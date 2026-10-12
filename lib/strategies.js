/**
 * The recovery ladder.
 *
 * Each strategy returns `{ progress }`. `progress: true` means the strategy
 * changed something the retried attempt will actually see — or deliberately
 * decided a plain retry is the right move — so the caller owns recovery and
 * returns `{ kind: 'retry' }`. `progress: false` means the strategy could not
 * help and the ladder moves on.
 *
 * The ordering is least-destructive first: an unchanged retry, then moving the
 * request to another route that serves the *same* model, then shedding context
 * in increasing order of aggression, and only then asking the human.
 *
 * @module dsh-retry-for-commandcode/strategies
 */

import { describeError, sleep } from './util.js'
import { delayForAttempt } from './config.js'
import {
  elideCandidates,
  inspectNode,
  inspectSurface,
  pruneCandidates,
  pruneContent,
  replaceGeneration,
  resolveService,
  rewriteNodeContent,
  stubContent,
} from './surface.js'

/** Reject a promise that settles later than `ms`, without leaking a timer. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 1. `probe` — retry the identical request once, after a short backoff.
 * Catches the case where the provider's 400 was a one-off (a load balancer's
 * transient rejection, or a trace-id-bearing hiccup) and costs nothing but a
 * repeated request.
 */
async function probe({ cfg, rec, signal, log }) {
  if (rec.probeCount >= cfg.probeAttempts) {
    return { progress: false, reason: `probe budget of ${cfg.probeAttempts} spent` }
  }
  rec.probeCount += 1
  const delay = delayForAttempt(cfg, rec.attempts)
  log(`probe: retrying the same request unchanged after ${delay}ms (probe ${rec.probeCount}/${cfg.probeAttempts})`)
  if (!(await sleep(delay, signal))) return { progress: false, reason: 'turn aborted during probe backoff' }
  return { progress: true, detail: `retried unchanged after ${delay}ms` }
}

/**
 * Build the ordered list of alternate routes to try.
 *
 * Candidates are tiered so the cheapest, least surprising switch comes first:
 *
 *   1. routes the operator named explicitly in `failover.models`;
 *   2. other providers serving the **same** model id;
 *   3. with `mode: 'any'`, other providers serving any model of their own.
 *
 * Tier 2 exists because the routes a user configures are frequently the *same
 * upstream service* under different API keys (a relay reachable as several
 * profiles). Switching between those cannot fix a request-shape rejection, so
 * tier 3 is what actually reaches a distinct provider — which is why `exclude`
 * and the logged candidate list matter: an operator who knows two routes are
 * aliases can keep the ladder from wasting requests on them.
 */
async function failoverTargets({ ctx, cfg, agent, provider, log }) {
  const excluded = new Set(cfg.failover.exclude)
  const sameModel = []
  const otherModel = []
  const seen = new Set()

  const blocked = (candidate) => {
    if (excluded.has(candidate.provider)) return true
    if (candidate.provider === provider && candidate.model === currentModel(agent)) return true
    const key = `${candidate.provider}\u0000${candidate.model}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  }

  for (const entry of cfg.failover.models) {
    if (blocked(entry)) continue
    if (entry.model === currentModel(agent)) sameModel.push(entry)
    else otherModel.push(entry)
  }

  if (cfg.failover.autoDiscover) {
    const llm = resolveService(ctx, agent, 'llm')
    const model = currentModel(agent)
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      let providers = []
      try {
        providers = llm.listProviders() ?? []
      } catch (error) {
        log(`failover: could not list providers (${describeError(error)})`)
      }
      for (const info of providers) {
        if (typeof llm.listModels !== 'function') continue
        // LlmProviderInfo carries `{ id, name }`; the route key options carry is `id`.
        const name = typeof info?.id === 'string' ? info.id : typeof info?.name === 'string' ? info.name : undefined
        if (name === undefined || name === provider || excluded.has(name)) continue
        let models = []
        try {
          models = (await withTimeout(llm.listModels(name), 5000, `listModels(${name})`)) ?? []
        } catch (error) {
          log(`failover: could not list models for "${name}" (${describeError(error)})`)
          continue
        }
        for (const entry of models) {
          const id = typeof entry?.id === 'string' ? entry.id : typeof entry?.model === 'string' ? entry.model : undefined
          if (id === undefined) continue
          const candidate = { provider: name, model: id }
          if (blocked(candidate)) continue
          if (id === model) sameModel.push(candidate)
          else otherModel.push(candidate)
        }
      }
    }
  }

  const ordered = cfg.failover.mode === 'any' ? [...sameModel, ...otherModel] : sameModel
  if (ordered.length === 0 && sameModel.length === 0 && otherModel.length > 0) {
    log(
      `failover: ${otherModel.length} route(s) exist but only for other models ` +
        `(${[...new Set(otherModel.map((entry) => `${entry.provider}/${entry.model}`))].slice(0, 4).join(', ')}) — ` +
        "set failover.mode: 'any' to allow a model change, which is what reaches a genuinely distinct provider",
    )
  }
  // Indicate whether a model change is in play so the caller can log it honestly.
  for (const entry of ordered) {
    if (entry.model !== currentModel(agent)) {
      log(`failover: candidate ${entry.provider}/${entry.model} changes the model as well as the route`)
    }
  }
  return ordered.slice(0, cfg.failover.maxTargets)
}

function currentModel(agent) {
  const model = agent?.options?.model
  return typeof model === 'string' ? model : undefined
}

/**
 * 2. `failover` — serve the *next attempt* from a different route.
 *
 * This is the only strategy that keeps the conversation byte-identical: nothing
 * in the durable history changes, so no context is lost and tool-call pairing
 * cannot be disturbed. Applied through the `agent/request` waterfall, which
 * `prepareRequest` dispatches on **every** attempt (including retries), so the
 * override reaches the retried request.
 *
 * Note the loop logs a changed call configuration as a new request header, so a
 * successful switch persists for the rest of the session rather than only for
 * this attempt. That is intentional — it is what keeps the task running on a
 * route that works — and is documented in the README.
 */
async function failover({ ctx, cfg, agent, rec, provider, signal, log }) {
  if (!cfg.failover.enabled) return { progress: false, reason: 'failover is disabled' }
  const targets = await failoverTargets({ ctx, cfg, agent, provider, log })
  const tried = rec.triedRoutes
  const target = targets.find((candidate) => !tried.has(`${candidate.provider}\u0000${candidate.model}`))
  if (target === undefined) {
    return {
      progress: false,
      reason: targets.length === 0
        ? 'no alternate route serves this model (set failover.models or failover.autoDiscover)'
        : `all ${targets.length} candidate route(s) already failed for this session`,
    }
  }
  tried.add(`${target.provider}\u0000${target.model}`)
  rec.modelOverride = { provider: target.provider, model: target.model, turn: rec.turn, step: rec.step }
  const sameModel = target.model === currentModel(agent)
  log(
    `failover: the next attempt will use ${target.provider}/${target.model} instead of ${provider}/${currentModel(agent) ?? '?'}` +
      `${sameModel ? '' : ` (MODEL CHANGE: ${currentModel(agent) ?? '?'} -> ${target.model})`}` +
      ` — the switch persists for this session, because the loop logs a changed call configuration as a new request header` +
      `${sameModel ? '' : '; disable it with failover.enabled: false if changing model is not acceptable'}`,
  )
  return {
    progress: true,
    detail: `next attempt uses ${target.provider}/${target.model}${sameModel ? '' : ' (model changed)'}`,
  }
}

/**
 * 3. `prune` — trim the middle out of over-budget text, keeping head and tail.
 *
 * Prefers the shipped `ctx.toolResultPruner` when the agent's preset exposes it
 * (the web profile mounts it inside the agent-preset scope, not at the profile
 * root), and otherwise applies the same rewrite itself.
 */
async function prune({ ctx, cfg, agent, signal, log }) {
  const session = agent.session
  const meter = resolveService(ctx, agent, 'tokenMeter')
  const service = resolveService(ctx, agent, 'toolResultPruner')

  if (service !== undefined && typeof service.pruneSession === 'function') {
    try {
      const result = service.pruneSession(session)
      const saved = result?.charsRemoved ?? 0
      if (saved > 0) {
        return {
          progress: true,
          detail: `toolResultPruner trimmed ${saved} chars from ${result.pruned?.length ?? 0} tool result(s)`,
        }
      }
      return { progress: false, reason: 'toolResultPruner found nothing over its budget' }
    } catch (error) {
      log(`prune: toolResultPruner failed, falling back to the built-in rewrite (${describeError(error)})`)
    }
  }

  const inspection = inspectSurface(session, { topN: 1 })
  const candidates = pruneCandidates(inspection, cfg)
  if (candidates.length === 0) {
    return {
      progress: false,
      reason: `no rewritable node exceeds prune.thresholdChars (${cfg.prune.thresholdChars})`,
    }
  }
  let saved = 0
  let count = 0
  for (const candidate of candidates) {
    if (signal?.aborted) break
    const node = inspectNode(session, candidate.seq)
    if (node === null) continue
    const content = pruneContent(node.content, cfg.prune)
    if (content === null) continue
    const outcome = rewriteNodeContent(session, node, content, { meter, label: 'tool result' })
    if (outcome?.error !== undefined) {
      log(`prune: the session refused a rewrite of seq ${node.seq} (${describeError(outcome.error)}); stopping`)
      break
    }
    if (outcome !== null) {
      saved += outcome.savedChars
      count += 1
    }
  }
  if (count === 0) return { progress: false, reason: 'no node could be trimmed' }
  return { progress: true, detail: `trimmed ${count} node(s), removing ${saved} chars` }
}

/**
 * 4. `elide` — shed the *content* of the oldest nodes outside a retained tail,
 * leaving one short head plus an explicit removal notice.
 *
 * This is this plugin's honest answer to "clear the context and continue".
 * A true structural wipe is not available mid-step: the only surface operation
 * is a positional replacement, its edges must be tool-pairing balanced (so an
 * open step cannot be cut), and `CompactionEngine.compactNow` — the user-facing
 * `/compact` path — requires an **idle** agent and so throws `busy` inside a
 * live turn. Rewriting content instead keeps node topology, tool-call pairing,
 * message identity, and replay reconstruction exactly intact while removing the
 * overwhelming majority of a coding session's context.
 */
async function elide({ ctx, cfg, agent, signal, log }) {
  const session = agent.session
  const meter = resolveService(ctx, agent, 'tokenMeter')
  const inspection = inspectSurface(session, { topN: 1 })
  const candidates = elideCandidates(inspection, cfg)
  if (candidates.length === 0) {
    return {
      progress: false,
      reason: `nothing elidable outside the newest ${cfg.elide.keepRecentNodes} nodes (total ${inspection.totalChars} chars)`,
    }
  }
  let saved = 0
  let count = 0
  for (const candidate of candidates) {
    if (signal?.aborted) break
    const node = inspectNode(session, candidate.seq)
    if (node === null) continue
    const label = node.type === 'tool/result' ? `tool result ${node.toolName ?? ''}`.trim() : 'message'
    const content = stubContent(node.content, { headChars: cfg.elide.headChars, label })
    if (content === null) continue
    const outcome = rewriteNodeContent(session, node, content, { meter, label })
    if (outcome?.error !== undefined) {
      log(`elide: the session refused a rewrite of seq ${node.seq} (${describeError(outcome.error)}); stopping`)
      break
    }
    if (outcome !== null) {
      saved += outcome.savedChars
      count += 1
    }
  }
  if (count === 0) return { progress: false, reason: 'no node could be elided' }
  return { progress: true, detail: `elided ${count} oldest node(s), removing ${saved} chars` }
}

/**
 * 5. `compact` — hand the problem to the shipped compaction engine with the
 * `context-overflow` trigger, which bypasses its normal pressure threshold and
 * retention policy. It prunes first and then replaces a balanced span with one
 * model-written summary node, so this is genuine semantic compression rather
 * than omission. Progress is judged only by durable surface movement, exactly
 * as `dsh-compaction-basic` judges its own recovery.
 */
async function compact({ ctx, cfg, agent, signal, log }) {
  if (!cfg.compact.enabled) return { progress: false, reason: 'compact is disabled' }
  const engine = resolveService(ctx, agent, 'compaction')
  if (engine === undefined || typeof engine.compactIfNeeded !== 'function') {
    return { progress: false, reason: 'no compaction engine in this agent scope (mount a compaction backend)' }
  }
  const session = agent.session
  const before = replaceGeneration(session)
  const options = {
    provider: typeof agent?.options?.provider === 'string' ? agent.options.provider : undefined,
    model: typeof agent?.options?.model === 'string' ? agent.options.model : undefined,
  }
  try {
    const result = await engine.compactIfNeeded({ session, options }, 'context-overflow', signal)
    const after = replaceGeneration(session)
    if (after > before) {
      return {
        progress: true,
        detail: result === null || result === undefined
          ? 'compaction advanced the surface'
          : `compacted ${result.shadowedSeqs?.length ?? 0} node(s) (~${result.shadowedTokenCount ?? 0} tokens) into one summary`,
      }
    }
    return { progress: false, reason: 'the compaction engine found no safe range to compact' }
  } catch (error) {
    const after = replaceGeneration(session)
    if (after > before) {
      return { progress: true, detail: `compaction threw after making durable progress (${describeError(error)})` }
    }
    return { progress: false, reason: `compaction failed: ${describeError(error)}` }
  }
}

/** The choices the `ask` strategy offers, and the strategy each one re-arms. */
function askOptions() {
  return [
    { label: '压缩上下文后重试', description: 'Summarize older history into one node, then retry. (compact)', thenRun: ['compact'] },
    { label: '精简旧上下文后重试', description: 'Shed the content of the oldest tool results, then retry. (elide)', thenRun: ['elide'] },
    { label: '换个供应商/模型重试', description: 'Serve the next attempt from another configured route. (failover)', thenRun: ['failover'] },
    { label: '原样再试一次', description: 'Retry the identical request once more. (probe)', thenRun: ['probe'] },
    { label: '停止任务并显示错误', description: 'Stop recovering and let dsh report the failure. (delegate)', thenRun: [] },
  ]
}

/**
 * 6. `ask` — hand the decision to the human, with the diagnosis attached.
 *
 * Bounded twice: the question waits at most `ask.timeoutMs`, and it is asked at
 * most once per step. A delegated (subagent) caller has no human answerer at
 * all, so this strategy declines rather than blocking a child agent forever.
 */
async function ask({ ctx, cfg, agent, diagnosis, rec, signal, log }) {
  if (!cfg.ask.enabled) return { progress: false, reason: 'ask is disabled' }
  if (rec.askedOnce) return { progress: false, reason: 'already asked the user for this step' }
  if (diagnosis?.isSubagent === true) {
    return { progress: false, reason: 'a delegated subagent has no human answerer' }
  }
  const service = resolveService(ctx, agent, 'userQuestions')
  if (service === undefined || typeof service.ask !== 'function') {
    return { progress: false, reason: 'no user-questions service is mounted' }
  }

  const options = askOptions()
  const controller = new AbortController()
  const abortFromTurn = () => controller.abort()
  signal?.addEventListener?.('abort', abortFromTurn, { once: true })
  const timer = setTimeout(() => controller.abort(), cfg.ask.timeoutMs)
  rec.askedOnce = true

  const detail = [
    `供应商 ${diagnosis?.provider ?? '?'} 拒绝了这次请求（${diagnosis?.code ?? '?'}${diagnosis?.status === undefined ? '' : ` ${diagnosis.status}`}）。`,
    diagnosis?.providerMessage === undefined ? '' : `供应商返回：${diagnosis.providerMessage}`,
    diagnosis?.suspectedCauses?.[0] === undefined ? '' : `最可能的原因：${diagnosis.suspectedCauses[0].cause}`,
    `已经尝试过：${rec.history.length === 0 ? '（无）' : rec.history.join('、')}。`,
    '请选择接下来怎么处理，任务会保持不中断。',
  ]
    .filter((line) => line.length > 0)
    .join('\n')

  log(`ask: requesting a decision from the user (waiting up to ${cfg.ask.timeoutMs}ms)`)
  let answer
  try {
    answer = await service.ask({
      agent,
      signal: controller.signal,
      questions: [
        {
          id: 'retry-for-commandcode',
          header: '请求被供应商拒绝',
          question: `dsh-retry-for-commandcode：${diagnosis?.provider ?? '?'} 拒绝了请求，如何继续？`,
          detail,
          options: options.map((option) => ({ label: option.label, description: option.description })),
        },
      ],
    })
  } catch (error) {
    return { progress: false, reason: `could not ask the user: ${describeError(error)}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abortFromTurn)
  }

  const answered = answer?.answers?.[0]
  const chosenLabel = answered?.selected?.[0] ?? answered?.custom
  if (typeof chosenLabel !== 'string' || chosenLabel.length === 0) {
    return { progress: false, reason: 'the user returned no choice' }
  }
  const chosen = options.find((option) => option.label === chosenLabel)
  if (chosen === undefined) {
    // A free-text answer: treat it as "keep going as you see fit".
    log(`ask: the user replied with free text ${JSON.stringify(chosenLabel)}; continuing with the ladder`)
    return { progress: false, reason: `free-text answer ${JSON.stringify(chosenLabel)}` }
  }
  if (chosen.thenRun.length === 0) {
    log('ask: the user chose to stop recovering')
    return { progress: false, delegate: true, reason: 'the user chose to stop' }
  }
  log(`ask: the user chose "${chosen.label}"`)
  return { progress: true, detail: `the user chose "${chosen.label}"`, thenRun: chosen.thenRun }
}

/** The strategy implementations, keyed by their config names. */
export const STRATEGIES = Object.freeze({
  probe,
  failover,
  prune,
  elide,
  compact,
  ask,
})

/**
 * Run the ladder until a strategy makes progress, the cycle budget runs out, or
 * the user tells us to stop.
 *
 * A strategy that makes progress is recorded as used, even though it succeeded.
 * Without that, a strategy which always claims progress — `failover`, which can
 * always name another route — would be selected on every consecutive failure and
 * permanently starve the strategies behind it. The observed consequence was a
 * step that failed three times switching providers and never once tried to fix
 * the request, which is the only thing that helps when every route is the same
 * upstream service. Each new failure now advances one rung:
 * `probe → failover → prune → elide → compact → ask`.
 *
 * @returns `{ kind: 'retry', strategy, detail }` when the caller should own
 *   recovery, or `{ kind: 'exhausted' | 'delegate', notes }`.
 */
export async function runLadder({ ctx, cfg, agent, rec, diagnosis, signal, provider, log }) {
  const notes = []
  for (;;) {
    const strategies = Array.isArray(rec.only) && rec.only.length > 0 ? rec.only : cfg.strategies
    const order = rec.priority === null || rec.priority === undefined
      ? strategies
      : [rec.priority, ...strategies.filter((name) => name !== rec.priority)]

    for (const strategy of order) {
      if (strategy !== 'probe' && rec.used.has(strategy)) continue
      if (strategy === 'probe' && rec.probeCount >= cfg.probeAttempts) continue
      if (strategy === 'ask' && rec.askedOnce) continue
      const implementation = STRATEGIES[strategy]
      if (implementation === undefined) continue

      let result
      try {
        result = await implementation({ ctx, cfg, agent, rec, diagnosis, signal, provider, log })
      } catch (error) {
        notes.push(`${strategy}: threw ${describeError(error)}`)
        rec.used.add(strategy)
        continue
      }

      if (result?.delegate === true) {
        notes.push(`${strategy}: ${result.reason ?? 'delegating'}`)
        return { kind: 'delegate', strategy, notes }
      }

      if (result?.progress === true) {
        rec.priority = null
        rec.history.push(result.detail ?? strategy)
        notes.push(`${strategy}: ${result.detail ?? 'succeeded'}`)
        // Retire the strategy so the NEXT failure escalates instead of repeating it.
        if (strategy !== 'probe') rec.used.add(strategy)
        if (Array.isArray(result.thenRun) && result.thenRun.length > 0) {
          await runDirectives({ ctx, cfg, agent, rec, diagnosis, signal, provider, log, names: result.thenRun, notes })
        }
        return { kind: 'retry', strategy, detail: result.detail, notes }
      }

      notes.push(`${strategy}: ${result?.reason ?? 'no progress'}`)
      rec.used.add(strategy)
    }

    if (rec.cycle >= cfg.maxCycles) return { kind: 'exhausted', notes }
    rec.cycle += 1
    rec.used.clear()
    rec.probeCount = 0
    log(`recovery ladder: starting cycle ${rec.cycle} of ${cfg.maxCycles}`)
  }
}

/** Re-arm and run the strategies a user choice selected, in order. */
async function runDirectives({ ctx, cfg, agent, rec, diagnosis, signal, provider, log, names, notes }) {
  for (const name of names) {
    const implementation = STRATEGIES[name]
    if (implementation === undefined) continue
    rec.used.delete(name)
    if (name === 'probe') rec.probeCount = 0
    if (name === 'ask') continue
    try {
      const result = await implementation({ ctx, cfg, agent, rec, diagnosis, signal, provider, log })
      if (result?.progress === true) notes.push(`${name} (chosen): ${result.detail ?? 'succeeded'}`)
      else notes.push(`${name} (chosen): ${result?.reason ?? 'no progress'}`)
    } catch (error) {
      notes.push(`${name} (chosen): threw ${describeError(error)}`)
    }
  }
}
