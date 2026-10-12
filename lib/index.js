/**
 * dsh-retry-for-commandcode — keep a task alive when a `commandcode` /
 * `openai-responses` route rejects a model request with HTTP 400
 * `invalid_request_error`.
 *
 * ## Why this plugin exists
 *
 * `hh-commandcode*` routes are configured without a `retryPolicy`, and
 * `INVALID_REQUEST` is outside `dsh-llm-retry`'s default retryable set
 * (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`), so a 400
 * delegates straight through every shipped recovery policy and the step — and
 * with it the task — becomes terminal.
 *
 * ## How it recovers
 *
 * This plugin registers a second `agent/request-error` listener. When the
 * failure matches its configured class it:
 *
 *   1. **diagnoses** the rejection — the provider's own error type/code/trace id,
 *      the size and shape of the history the request was built from, and the
 *      tool calls and results of the immediately preceding step;
 *   2. **chooses a strategy** from an escalating ladder
 *      (`probe` → `failover` → `prune` → `elide` → `compact` → `ask`);
 *   3. **applies it durably** where it changes context, so the retried attempt's
 *      request is genuinely different (`buildRequest` re-derives messages from
 *      the session log on every attempt);
 *   4. returns `{ kind: 'retry' }`, which is the only recovery action the
 *      waterfall defines.
 *
 * Nothing here can make a task *more* likely to stop: every failure inside this
 * plugin is caught and delegates to the next listener, which is exactly the
 * behaviour that would have happened without it.
 *
 * ## Subagents
 *
 * `agent/request-error` is a scope-filtered dispatch, and a listener registered
 * on the profile-root context is untagged, so it is admitted for **every** agent
 * — the runtime root and every in-process `spawn`/`fork` subagent. Per-agent
 * state is keyed on `payload.agent`, and services are resolved through
 * `agent.ctx` first (an agent preset's `compaction`/`toolResultPruner` live in an
 * isolated preset scope, not at the profile root). The `ask` strategy declines
 * for a delegated child, which has no human answerer.
 *
 * @module dsh-retry-for-commandcode
 */

import { classifyFailure } from './classify.js'
import { delayForAttempt, resolveConfig } from './config.js'
import { diagnose, renderDiagnosis, summarizeDiagnosis } from './diagnose.js'
import { STRATEGIES, runLadder } from './strategies.js'
import { resolveService } from './surface.js'
import { describeError, sleep } from './util.js'

/** Display name for fiber diagnostics and logger names. */
export const name = 'retry-for-commandcode'

/**
 * `agents` is the only hard requirement: the event bus carries
 * `agent/request-error` and `agent/request` regardless, but waiting for the
 * registry keeps recovery state keyed on a real agent from the first failure.
 */
export const inject = ['agents']

/**
 * Failure classes this plugin declines to own outright.
 *
 * `QUOTA` is deliberately **not** here: on a relay/gateway route a credit
 * exhaustion is scoped to that one API key, so moving the request to a route
 * that still has credit is exactly what keeps the task alive. It is handled
 * separately under `onQuota`. `ACCOUNT_QUOTA` is account-level billing that no
 * route switch can fix, so it always delegates.
 */
const NEVER_OWNED = Object.freeze(
  new Set([
    'ABORTED',
    'AUTH',
    'ACCOUNT_QUOTA',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'UNSUPPORTED_REASONING_EFFORT',
    'UNKNOWN_MODEL',
    'NO_ADAPTER',
    'INVALID_CONFIG',
  ]),
)

/**
 * Install recovery listeners.
 * @param ctx - the plugin context.
 * @param rawConfig - the profile row's `config:` mapping.
 * @throws when the supplied configuration is invalid, naming the exact option.
 */
export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`retry-for-commandcode: ${message}`)
    } catch {
      // Logging must never become a failure path.
    }
  }

  if (!cfg.enabled) {
    log('disabled by configuration; no recovery listeners installed')
    return
  }

  /** Per-step recovery state, keyed on the failing agent. */
  const records = new WeakMap()
  /** Routes that already rejected a request for this agent, so failover never repeats one. */
  const triedRoutes = new WeakMap()
  /** A route switch to apply to one specific upcoming attempt. */
  const pendingFailover = new WeakMap()

  function routesFor(agent) {
    let set = triedRoutes.get(agent)
    if (set === undefined) {
      set = new Set()
      triedRoutes.set(agent, set)
    }
    return set
  }

  function recordFor(agent, turn, step) {
    let record = records.get(agent)
    const key = `${turn}:${step}`
    if (record === undefined || record.key !== key) {
      record = {
        key,
        turn,
        step,
        attempts: 0,
        cycle: 1,
        used: new Set(),
        probeCount: 0,
        askedOnce: false,
        priority: null,
        only: null,
        history: [],
        modelOverride: null,
        triedRoutes: routesFor(agent),
      }
      records.set(agent, record)
    }
    return record
  }

  // A settled step or a fresh turn makes the previous ladder moot. dsh-llm-retry
  // resets its accounting the same way.
  ctx.on('agent/status', (payload) => {
    if (payload?.status === 'idle' && payload.agent !== undefined) records.delete(payload.agent)
  })
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent !== undefined) {
      records.delete(payload.agent)
      triedRoutes.delete(payload.agent)
      pendingFailover.delete(payload.agent)
    }
  })

  /**
   * Apply a pending route switch. `prepareRequest` dispatches this waterfall on
   * **every** attempt — including the retry driven by the listener below — so an
   * override set while handling a failure reaches the retried request.
   */
  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    let override
    try {
      override = pendingFailover.get(payload.agent)
      if (override === undefined) return base
      if (override.turn !== payload.turn || override.step !== payload.step) return base
      pendingFailover.delete(payload.agent)
    } catch (error) {
      log(`agent/request: ignoring a failover override (${describeError(error)})`)
      return base
    }
    if (base === undefined || base === null) return base
    log(
      `agent/request: serving turn ${payload.turn} step ${payload.step} from ${override.provider}/${override.model} ` +
        `instead of ${base.provider}/${base.model}`,
    )
    return { ...base, provider: override.provider, model: override.model }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    // Everything, including reading the payload, sits inside the guard: this
    // listener must never be the reason a turn fails, so any throw — even from a
    // hostile property getter — falls back to the behaviour the turn would have
    // had without the plugin.
    try {
      const { agent, turn, step, provider, failure, signal } = payload ?? {}
      if (signal?.aborted) return next()
      if (agent === undefined || agent === null) return next()

      // A credit/quota rejection from one route does not mean every route is out
      // of credit, so `onQuota: 'failover'` owns it by moving the request. This
      // is the difference between "the task ends on a quota error" and "the task
      // continues on a key that still has credit".
      const isQuota = failure?.code === 'QUOTA'
      const quotaOwned = isQuota && cfg.onQuota === 'failover' && cfg.failover.enabled
      if (NEVER_OWNED.has(failure?.code)) return next()
      // A quota body can still look like the 400 class this plugin owns (the
      // observed one was `HTTP 400 invalid_request_error` whose text was about
      // credits), so the generic wording match must not re-admit it.
      if (isQuota && !quotaOwned) return next()

      const verdict = classifyFailure(failure, provider, cfg)
      if (!verdict.matched && !quotaOwned) return next()

      const record = recordFor(agent, turn, step)
      if (quotaOwned) {
        // Only route switching can help; context repair cannot restore credit.
        record.only = ['failover']
        if (!verdict.matched) {
          verdict.matched = true
          verdict.reason = `code QUOTA owned by onQuota: 'failover' (route-scoped credit exhaustion)`
        }
      } else if (record.only !== null && record.only !== undefined) {
        record.only = null
      }

      // `onExhausted: 'retry'` is the documented never-stop mode; every other
      // mode stops at the budget so an unfixable request cannot burn unbounded
      // provider requests.
      const atHardCap = record.attempts >= cfg.maxRecoveriesPerStep && cfg.onExhausted !== 'retry'

      let diagnosis = null
      try {
        diagnosis = diagnose({
          ctx,
          cfg,
          agent,
          provider,
          failure,
          verdict,
          turn,
          step,
          attempt: record.attempts + 1,
          cycle: record.cycle,
          strategyHistory: [...record.history],
        })
      } catch (error) {
        log(`diagnosis failed (${describeError(error)}); recovering without it`)
      }

      if (cfg.logDiagnostics && diagnosis !== null) {
        for (const line of renderDiagnosis(diagnosis)) log(line)
      } else {
        log(`matched ${summaryOf(verdict)} for provider "${provider}"`)
      }

      if (cfg.dryRun) {
        log('dryRun is on: reporting the diagnosis and delegating instead of recovering')
        return next()
      }

      if (atHardCap) {
        log(
          `recovery budget of ${cfg.maxRecoveriesPerStep} attempts is exhausted for turn ${turn} step ${step}; ` +
            'delegating so the failure surfaces normally',
        )
        return next()
      }
      record.attempts += 1

      const outcome = await runLadder({ ctx, cfg, agent, rec: record, diagnosis, signal, provider, log })
      if (outcome.notes.length > 0) log(`ladder: ${outcome.notes.join(' | ')}`)

      if (outcome.kind === 'retry') {
        // Publish a route switch recorded by the `failover` strategy — either
        // from the ladder or from a strategy the user picked — so the
        // `agent/request` listener above applies it to this next attempt.
        if (record.modelOverride !== null && record.modelOverride !== undefined) {
          pendingFailover.set(agent, record.modelOverride)
          record.modelOverride = null
        }
        log(
          `recovering turn ${turn} step ${step} with "${outcome.strategy}" ` +
            `(attempt ${record.attempts}/${cfg.maxRecoveriesPerStep}): ${outcome.detail ?? 'retrying'}`,
        )
        return { kind: 'retry' }
      }
      if (outcome.kind === 'delegate') {
        log(`delegating recovery for turn ${turn} step ${step} (${outcome.strategy ?? 'ladder'})`)
        return next()
      }

      return await finishExhausted({ ctx, cfg, agent, record, diagnosis, signal, log, next, turn, step })
    } catch (error) {
      // The plugin must never be the reason a turn fails.
      log(`internal error while recovering (${describeError(error)}); delegating`)
      try {
        return await next()
      } catch {
        return undefined
      }
    }
  })

  log(
    `installed: providers=${cfg.providers.length === 0 ? 'any' : cfg.providers.join(',')} ` +
      `codes=${cfg.codes.join(',')} strategies=${cfg.strategies.join('>')} ` +
      `budget=${cfg.maxRecoveriesPerStep}/${cfg.maxCycles} onExhausted=${cfg.onExhausted}/${cfg.onExhaustedFallback}`,
  )
}

function summaryOf(verdict) {
  return `${verdict.code}${verdict.status === undefined ? '' : ` status=${verdict.status}`}`
}

/**
 * Decide what to do once the ladder has nothing left that can help.
 *
 * `ask` gets a last chance if it never ran (a subagent or a missing UI makes it
 * unavailable rather than fatal). Otherwise `onExhaustedFallback` decides
 * between surfacing the error and keeping the turn alive with a growing
 * backoff — the default, because a stopped task is the failure this plugin
 * exists to prevent.
 */
async function finishExhausted({ ctx, cfg, agent, record, diagnosis, signal, log, next, turn, step }) {
  // A route-restricted recovery (a credit/quota failure) can only be fixed by
  // moving to a route that still works. Re-sending to the same route cannot
  // restore credit, so the "keep the turn alive by retrying" fallback would just
  // burn requests against a dead key — delegate instead and let the quota error
  // surface.
  if (Array.isArray(record.only) && record.only.length > 0) {
    log(
      `no usable route left for a ${diagnosis?.code ?? 'route-restricted'} failure ` +
        `(candidates tried: ${[...record.triedRoutes].join(', ') || 'none'}); delegating so it surfaces`,
    )
    return next()
  }

  if (cfg.onExhausted === 'ask' && !record.askedOnce) {
    let result
    try {
      result = await STRATEGIES.ask({ ctx, cfg, agent, rec: record, diagnosis, signal, log })
    } catch (error) {
      result = { progress: false, reason: describeError(error) }
    }
    if (result?.delegate === true) {
      log('the user chose to stop; delegating so the failure surfaces normally')
      return next()
    }
    if (result?.progress === true) {
      log(`the user chose "${result.detail ?? 'a strategy'}"; retrying`)
      return { kind: 'retry' }
    }
    log(`could not obtain a user decision (${result?.reason ?? 'unknown'}); falling back to ${cfg.onExhaustedFallback}`)
  }

  if (cfg.onExhausted === 'delegate') return next()
  if (cfg.onExhausted === 'ask' && cfg.onExhaustedFallback === 'delegate') return next()

  const delay = delayForAttempt(cfg, record.attempts)
  log(
    `ladder exhausted for turn ${turn} step ${step}; waiting ${delay}ms and retrying to keep the task alive ` +
      `(onExhausted=${cfg.onExhausted}, fallback=${cfg.onExhaustedFallback}). ` +
      `Most likely cause: ${diagnosis?.suspectedCauses?.[0]?.cause ?? summarizeDiagnosis(diagnosis ?? {})}`,
  )
  if (!(await sleep(delay, signal))) {
    log('the turn was cancelled during the final backoff; delegating')
    return next()
  }
  return { kind: 'retry' }
}

/** Re-exported for tests and for tooling that inspects the plugin. */
export { resolveConfig } from './config.js'
export { classifyFailure, providerErrorFields, statusOf } from './classify.js'
export { diagnose, renderDiagnosis } from './diagnose.js'
export { describeRequestComposition, inspectSurface } from './surface.js'
export { resolveService }
