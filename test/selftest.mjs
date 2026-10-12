/**
 * Self-test for dsh-retry-for-commandcode.
 *
 * Runs the plugin's pure logic and its event wiring against a miniature session
 * model, with no DSH runtime required. This is what verifies the parts that
 * matter and that are easy to get wrong:
 *
 *   - the failure class actually matches the real commandcode 400 message;
 *   - the durable rewrite emits the exact append pair `dsh-session` accepts
 *     (`compaction/prune` + a same-type single-node replacement that changes
 *     only `message.content`);
 *   - a rewrite never empties content, never touches surface node 0, and never
 *     touches the retained tail;
 *   - the ladder escalates and returns `{ kind: 'retry' }`;
 *   - the plugin never throws into the agent loop, even when everything it
 *     depends on is missing.
 *
 * Usage: node test/selftest.mjs
 */

import assert from 'node:assert/strict'

import { classifyFailure, providerErrorFields, statusOf } from '../lib/classify.js'
import { resolveConfig } from '../lib/config.js'
import { diagnose, renderDiagnosis } from '../lib/diagnose.js'
import { apply } from '../lib/index.js'
import {
  describeRequestComposition,
  elideCandidates,
  inspectNode,
  inspectSurface,
  pruneCandidates,
  pruneContent,
  rewriteNodeContent,
  stubContent,
} from '../lib/surface.js'
import { runLadder } from '../lib/strategies.js'

let passed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Miniature session / context doubles
// ---------------------------------------------------------------------------

/** The exact provider message from the user's report. */
const REAL_FAILURE_MESSAGE =
  'hh-commandcode2 API error (400): {"message":"{\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"\\",' +
  '\\"message\\":\\"invalid request error trace_id: 53cfc3ba738d8e7749918f27a2653fa8\\"}\\n","type":"invalid_request_error"}'

class MiniSession {
  constructor(events) {
    this.id = 'session-mini'
    this.events = [...events]
    this.surface = { nodes: events.map((event) => event.seq), replaceGeneration: 0 }
    this.header = {}
  }

  eventAt(seq) {
    return this.events.find((event) => event.seq === seq)
  }

  deriveEventMessage(event) {
    if (event === undefined || event === null) return null
    if (event.type === 'user/message') return event.data
    if (event.type === 'tool/result') return event.data.message
    if (event.type === 'assistant/message') return event.data.message
    if (event.type === 'system/message') return event.data.message
    return null
  }

  deriveMessages() {
    return this.surface.nodes
      .map((seq) => this.deriveEventMessage(this.eventAt(seq)))
      .filter((message) => message !== null)
  }

  append(type, data, opts) {
    const event = {
      type,
      seq: this.events.length,
      time: Date.now(),
      data,
      ...(opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    }
    this.events.push(event)
    if (opts?.surfaceOp === 'append') {
      this.surface.nodes.push(event.seq)
    } else if (opts?.surfaceOp?.op === 'replace') {
      const startIndex = this.surface.nodes.indexOf(opts.surfaceOp.startSeq)
      const endIndex = this.surface.nodes.indexOf(opts.surfaceOp.endSeq)
      assert.ok(startIndex >= 0 && endIndex >= startIndex, 'replace must target current surface nodes')
      this.surface.nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
      this.surface.replaceGeneration += 1
    }
    return event
  }
}

function textMessage(seq, role, text, extra = {}) {
  const message = {
    id: `m${seq}`,
    role,
    content: [{ type: 'text', text }],
    source: role === 'tool' ? { kind: 'tool', callId: `c${seq}` } : role === 'assistant' ? { kind: 'model', provider: 'hh-commandcode2', model: 'deepseek/deepseek-v4.1-flash' } : { kind: 'user' },
    ...extra,
  }
  return message
}

/** Build a session shaped like a real coding run: system prompt, task, big tool output. */
function buildSession() {
  const events = []
  const push = (event) => {
    events.push({ seq: events.length, time: 0, ...event })
  }
  push({ type: 'system/message', data: { turn: 0, step: 0, message: textMessage(0, 'system', 'You are a coding agent.') }, surfaceOp: 'append' })
  push({ type: 'user/message', data: textMessage(1, 'user', 'Please refactor the parser and run the tests.'), surfaceOp: 'append' })
  push({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: textMessage(2, 'assistant', 'I will read the file and then run the tests.', {
        content: [
          { type: 'text', text: 'I will read the file and then run the tests.' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"parser.ts"}' },
          { type: 'tool-call', id: 'call_2', name: 'pwsh', arguments: '{"command":"npm test"}' },
        ],
      }),
    },
    surfaceOp: 'append',
  })
  // A huge tool result — the shape this plugin exists to shed.
  push({
    type: 'tool/result',
    data: { message: textMessage(3, 'tool', 'A'.repeat(40000), { toolCallId: 'call_1' }) },
    surfaceOp: 'append',
  })
  push({
    type: 'tool/result',
    data: { message: textMessage(4, 'tool', 'tests failed: 3 passing, 2 failing', { toolCallId: 'call_2', isError: true }) },
    surfaceOp: 'append',
  })
  for (let index = 5; index < 24; index += 1) {
    push({
      type: 'tool/result',
      data: { message: textMessage(index, 'tool', `result ${index} `.repeat(40), { toolCallId: `call_${index}` }) },
      surfaceOp: 'append',
    })
  }
  return new MiniSession(events)
}

/** A ctx double that records listeners so tests can dispatch the real events. */
function makeCtx({ services = {} } = {}) {
  const listeners = new Map()
  const lines = []
  const ctx = {
    listeners,
    lines,
    logger: { warn: (line) => lines.push(String(line)), info: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
    get: (name) => services[name],
    on: (eventName, listener) => {
      const list = listeners.get(eventName) ?? []
      list.push(listener)
      listeners.set(eventName, list)
      return () => {}
    },
    effect: () => () => {},
  }
  return ctx
}

/**
 * Dispatch a waterfall: each listener calls `next()` to delegate.
 * `fallback` models the machine's own terminal handler — for `agent/request`
 * that is the seeded call configuration, which `next()` yields.
 */
async function waterfall(ctx, eventName, payload, fallback) {
  const list = ctx.listeners.get(eventName) ?? []
  let index = -1
  const next = async () => {
    index += 1
    if (index >= list.length) return typeof fallback === 'function' ? fallback() : fallback
    return list[index](payload, next)
  }
  return next()
}

function makeAgent(session, { isSubagent = false } = {}) {
  const agent = {
    session,
    options: { provider: 'hh-commandcode2', model: 'deepseek/deepseek-v4.1-flash' },
    ctx: { get: () => undefined },
    status: 'running',
  }
  if (isSubagent) session.header = { parentSession: 'parent-session' }
  return agent
}

const realFailure = { message: REAL_FAILURE_MESSAGE, code: 'INVALID_REQUEST' }

// ---------------------------------------------------------------------------
// 1. Failure classification
// ---------------------------------------------------------------------------

check('classify: the real commandcode 400 is matched by default config', () => {
  const cfg = resolveConfig({})
  const verdict = classifyFailure(realFailure, 'hh-commandcode2', cfg)
  assert.equal(verdict.matched, true, verdict.reason)
  assert.equal(verdict.code, 'INVALID_REQUEST')
  // The HTTP status is recovered from the message, because the pi-ai adapter
  // builds only { message, code } and leaves `status` undefined.
  assert.equal(verdict.status, 400)
})

check('statusOf: reads the status out of the SDK message framing', () => {
  assert.equal(statusOf(realFailure), 400)
  assert.equal(statusOf({ code: 'INVALID_REQUEST', message: 'no status here' }), undefined)
  assert.equal(statusOf({ code: 'X', message: 'm', status: 413 }), 413)
})

check('providerErrorFields: unwraps the nested commandcode body', () => {
  const fields = providerErrorFields(realFailure)
  assert.equal(fields.type, 'invalid_request_error')
  assert.equal(fields.traceId, '53cfc3ba738d8e7749918f27a2653fa8')
})

check('classify: a 400 from an unconfigured provider is not owned', () => {
  const cfg = resolveConfig({ providers: ['hh-commandcode2'] })
  assert.equal(classifyFailure(realFailure, 'openai', cfg).matched, false)
})

check('classify: unrelated codes are not owned', () => {
  const cfg = resolveConfig({})
  assert.equal(classifyFailure({ code: 'TRANSPORT', message: 'socket closed' }, 'hh-commandcode2', cfg).matched, false)
})

check('classify: bare INVALID_REQUEST without matching wording is not owned', () => {
  const cfg = resolveConfig({})
  assert.equal(classifyFailure({ code: 'INVALID_REQUEST', message: 'bad thing' }, 'hh-commandcode2', cfg).matched, false)
})

// ---------------------------------------------------------------------------
// 2. Config resolution
// ---------------------------------------------------------------------------

check('config: defaults resolve and freeze', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.enabled, true)
  assert.deepEqual([...cfg.strategies], ['probe', 'failover', 'prune', 'elide', 'compact', 'ask'])
  assert.equal(cfg.onExhausted, 'ask')
  assert.equal(cfg.onExhaustedFallback, 'retry')
  assert.equal(cfg.failover.mode, 'same-model')
  assert.equal(cfg.prune.includeUserMessages, false)
})

check('config: unknown keys are rejected by name', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown option "nope"/)
  assert.throws(() => resolveConfig({ prune: { nope: 1 } }), /unknown option "prune\.nope"/)
})

check('config: bad values are rejected with the exact path', () => {
  assert.throws(() => resolveConfig({ strategies: ['prune', 'bogus'] }), /strategies entry "bogus"/)
  assert.throws(() => resolveConfig({ maxRecoveriesPerStep: 0 }), /maxRecoveriesPerStep must be an integer >= 1/)
  assert.throws(() => resolveConfig({ backoff: { jitterRatio: 2 } }), /jitterRatio must be a number between 0 and 1/)
  assert.throws(() => resolveConfig({ messagePatterns: ['('] }), /not a valid regular expression/)
  assert.throws(
    () => resolveConfig({ prune: { thresholdChars: 100, headChars: 90, tailChars: 90 } }),
    /headChars \+ prune\.tailChars must be less than prune\.thresholdChars/,
  )
})

check('config: a provider selector supports a trailing star', () => {
  const cfg = resolveConfig({ providers: ['hh-commandcode*'] })
  assert.equal(classifyFailure(realFailure, 'hh-commandcode2', cfg).matched, true)
  assert.equal(classifyFailure(realFailure, 'command', cfg).matched, false)
})

// ---------------------------------------------------------------------------
// 3. Content transforms
// ---------------------------------------------------------------------------

check('pruneContent: trims the middle and keeps head/tail', () => {
  const content = [{ type: 'text', text: 'H'.repeat(3000) + 'M'.repeat(20000) + 'T'.repeat(3000) }]
  const pruned = pruneContent(content, { thresholdChars: 8192, headChars: 100, tailChars: 50 })
  assert.ok(pruned !== null)
  const text = pruned[0].text
  assert.ok(text.startsWith('H'.repeat(100)), 'head preserved')
  assert.ok(text.endsWith('T'.repeat(50)), 'tail preserved')
  assert.ok(text.includes('elided by dsh-retry-for-commandcode'))
  assert.ok(text.length < content[0].text.length)
})

check('pruneContent: leaves in-budget content untouched', () => {
  assert.equal(pruneContent([{ type: 'text', text: 'short' }], { thresholdChars: 8192, headChars: 100, tailChars: 50 }), null)
})

check('pruneContent: never touches reasoning or image blocks', () => {
  const content = [
    { type: 'reasoning', text: 'R'.repeat(50000) },
    { type: 'image', attachment: { id: 'a' } },
    { type: 'text', text: 'T'.repeat(50000) },
  ]
  const pruned = pruneContent(content, { thresholdChars: 8192, headChars: 10, tailChars: 10 })
  assert.equal(pruned[0].text, 'R'.repeat(50000))
  assert.deepEqual(pruned[1], { type: 'image', attachment: { id: 'a' } })
  assert.ok(pruned[2].text.length < 50000)
})

check('stubContent: always leaves a non-empty text block', () => {
  const stubbed = stubContent([{ type: 'text', text: 'X'.repeat(5000) }], { headChars: 10, label: 'tool result' })
  assert.ok(stubbed !== null)
  assert.ok(stubbed.some((block) => block.type === 'text' && block.text.length > 0))
  assert.equal(stubContent([{ type: 'text', text: 'tiny' }], { headChars: 10, label: 'x' }), null)
})

// ---------------------------------------------------------------------------
// 4. Surface inspection and durable rewrite
// ---------------------------------------------------------------------------

check('inspectSurface: identifies the previous step and the largest nodes', () => {
  const session = buildSession()
  const inspection = inspectSurface(session, { topN: 3 })
  assert.equal(inspection.nodeCount, 24)
  assert.equal(inspection.largest[0].seq, 3, 'the 40000-char tool result is the largest')
  assert.equal(inspection.largest[0].chars, 40000)
  assert.equal(inspection.lastStep.toolCalls.length, 2)
  assert.deepEqual(
    inspection.lastStep.toolCalls.map((call) => call.name),
    ['read', 'pwsh'],
  )
  assert.equal(inspection.lastStep.toolResults.length, 2)
  assert.equal(inspection.lastStep.toolResults[0].chars, 40000)
  assert.equal(inspection.lastStep.toolResults[1].isError, true)
})

check('rewriteNodeContent: emits the exact append pair the session accepts', () => {
  const session = buildSession()
  const cfg = resolveConfig({})
  const before = inspectNode(session, 3)
  const content = pruneContent(before.content, cfg.prune)
  assert.ok(content !== null)

  const eventsBefore = session.events.length
  const outcome = rewriteNodeContent(session, before, content, { label: 'tool result' })
  assert.equal(outcome.error, undefined)
  assert.ok(outcome.savedChars > 30000)

  const appended = session.events.slice(eventsBefore)
  assert.equal(appended.length, 2, 'exactly one prune record plus one replacement')
  assert.equal(appended[0].type, 'compaction/prune')
  assert.deepEqual(appended[0].data.shadowedRange, { start: 3, end: 3 })
  assert.deepEqual(appended[0].data.shadowedSeqs, [3])
  assert.ok(Number.isSafeInteger(appended[0].data.shadowedTokenCount))

  const replacement = appended[1]
  assert.equal(replacement.type, 'tool/result')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.deepEqual(replacement.sourceEventSeqs, [3])
  // assertToolResultRewrite requires that only message.content changed.
  const original = session.eventAt(3)
  assert.equal(replacement.data.message.id, original.data.message.id)
  assert.equal(replacement.data.message.toolCallId, original.data.message.toolCallId)
  assert.deepEqual(Object.keys(replacement.data).sort(), Object.keys(original.data).sort())
  assert.equal(session.surface.replaceGeneration, 1)
})

check('rewriteNodeContent: refuses a non-rewritable node', () => {
  const session = buildSession()
  const assistant = inspectNode(session, 2)
  assert.equal(assistant.rewritable, false)
  assert.equal(rewriteNodeContent(session, assistant, [{ type: 'text', text: 'x' }], { label: 'x' }), null)
})

check('rewriteNodeContent: refuses surface node 0 when it holds the system prompt', () => {
  const session = buildSession()
  const system = inspectNode(session, 0)
  assert.equal(system.type, 'system/message')
  assert.equal(system.rewritable, false)
})

check('describeRequestComposition: separates the bytes this plugin can rewrite from the bytes it cannot', () => {
  const session = buildSession()
  const composition = describeRequestComposition(session)
  assert.equal(composition.messages, 24)
  assert.ok(composition.totalBytes > 40000, 'the request is measured in its JSON form')
  assert.equal(composition.estimatedTokens, Math.ceil(composition.totalBytes / 4))
  assert.equal(
    composition.touchableBytes + composition.untouchableBytes,
    composition.totalBytes,
    'every measured byte is classified exactly once',
  )
  // The 40000-char tool result is reachable; the assistant message is not.
  assert.ok(composition.touchableBytes > 40000)
  assert.ok(composition.untouchableBytes > 0)
  assert.equal(composition.largest.role, 'tool')
  assert.equal(composition.untouchablePercent, Math.round((composition.untouchableBytes / composition.totalBytes) * 100))
  const roles = composition.byRole.map(([role]) => role)
  assert.deepEqual(roles, ['tool', 'assistant', 'user', 'system'], 'largest role first')
})

/** A session whose request is dominated by assistant text — the untouchable shape. */
function buildAssistantHeavySession() {
  const events = []
  const push = (event) => events.push({ seq: events.length, time: 0, ...event })
  push({ type: 'system/message', data: { turn: 0, step: 0, message: textMessage(0, 'system', 'You are a coding agent.') }, surfaceOp: 'append' })
  push({ type: 'user/message', data: textMessage(1, 'user', 'Keep going.'), surfaceOp: 'append' })
  for (let index = 0; index < 4; index += 1) {
    push({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: index + 1,
        message: textMessage(2 + index * 2, 'assistant', 'thinking…', {
          content: [
            { type: 'reasoning', text: 'R'.repeat(6000) },
            { type: 'text', text: 'I will check the invariant.' },
            { type: 'tool-call', id: `call_${index}`, name: 'read', arguments: '{"path":"parser.ts"}' },
          ],
        }),
      },
      surfaceOp: 'append',
    })
    push({
      type: 'tool/result',
      data: { message: textMessage(3 + index * 2, 'tool', `ok ${index} `.repeat(60), { toolCallId: `call_${index}` }) },
      surfaceOp: 'append',
    })
  }
  return new MiniSession(events)
}

check('describeRequestComposition: an assistant-dominated request reports a majority it cannot rewrite', () => {
  const composition = describeRequestComposition(buildAssistantHeavySession())
  assert.ok(composition.untouchablePercent >= 90, `expected a dominant untouchable share, got ${composition.untouchablePercent}%`)
  assert.equal(composition.largest.role, 'assistant')
})

check('rewriteNodeContent: no assistant node is ever a rewrite candidate', () => {
  const session = buildAssistantHeavySession()
  const inspection = inspectSurface(session, { topN: 5 })
  for (const node of inspection.nodes) {
    if (node.type !== 'assistant/message') continue
    assert.equal(node.rewritable, false, `assistant seq ${node.seq} must not be rewritable`)
  }
  const cfg = resolveConfig({ elide: { keepRecentNodes: 3, minChars: 100, minTotalChars: 0 } })
  const candidates = [...pruneCandidates(inspection, cfg), ...elideCandidates(inspection, cfg)]
  assert.ok(candidates.length > 0, 'the small tool results are still candidates')
  assert.ok(
    candidates.every((node) => node.type !== 'assistant/message'),
    'neither transform may propose an assistant node',
  )
})

// ---------------------------------------------------------------------------
// 5. Candidate selection
// ---------------------------------------------------------------------------

check('pruneCandidates: only over-budget rewritable nodes', () => {
  const session = buildSession()
  const cfg = resolveConfig({})
  const candidates = pruneCandidates(inspectSurface(session), cfg)
  assert.deepEqual(candidates.map((node) => node.seq), [3])
})

check('elideCandidates: oldest first, tail protected, node 0 protected', () => {
  const session = buildSession()
  const cfg = resolveConfig({ elide: { keepRecentNodes: 4, minChars: 100 } })
  const candidates = elideCandidates(inspectSurface(session), cfg)
  assert.ok(candidates.length > 0)
  assert.ok(candidates[0].seq > 0, 'node 0 is never a candidate')
  const tailSeqs = session.surface.nodes.slice(-4)
  for (const candidate of candidates) {
    assert.ok(!tailSeqs.includes(candidate.seq), `seq ${candidate.seq} is inside the retained tail`)
  }
})

// ---------------------------------------------------------------------------
// 6. The ladder
// ---------------------------------------------------------------------------

await checkAsync('runLadder: prune repairs the oversized result and owns recovery', async () => {
  const session = buildSession()
  const agent = makeAgent(session)
  const ctx = makeCtx()
  const cfg = resolveConfig({ probeAttempts: 0, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } })
  const logged = []
  const record = {
    key: '1:1',
    turn: 1,
    step: 1,
    attempts: 0,
    cycle: 1,
    used: new Set(),
    probeCount: 0,
    askedOnce: false,
    priority: null,
    history: [],
    triedRoutes: new Set(),
  }
  const outcome = await runLadder({
    ctx,
    cfg,
    agent,
    rec: record,
    diagnosis: { isSubagent: false, suspectedCauses: [] },
    signal: new AbortController().signal,
    provider: 'hh-commandcode2',
    log: (line) => logged.push(line),
  })
  // No llm/compaction/userQuestions service is mounted on this double, so with
  // the probe budget spent the ladder must reach `prune` and actually rewrite
  // history, which is the durable progress the loop's retry then re-derives.
  assert.equal(outcome.kind, 'retry', JSON.stringify(outcome))
  assert.ok(['prune', 'elide'].includes(outcome.strategy), `unexpected strategy ${outcome.strategy}`)
  assert.ok(session.surface.replaceGeneration > 0, 'durable surface progress was made')
})

await checkAsync('runLadder: escalates through cycles and then reports exhaustion', async () => {
  // A session with nothing oversized and nothing elidable, and no services.
  const session = new MiniSession([
    { seq: 0, time: 0, type: 'user/message', data: textMessage(0, 'user', 'hi'), surfaceOp: 'append' },
  ])
  const agent = makeAgent(session)
  const cfg = resolveConfig({ strategies: ['prune', 'elide', 'compact'], maxCycles: 2, probeAttempts: 0 })
  const record = {
    key: '1:1',
    turn: 1,
    step: 1,
    attempts: 0,
    cycle: 1,
    used: new Set(),
    probeCount: 0,
    askedOnce: false,
    priority: null,
    history: [],
    triedRoutes: new Set(),
  }
  const outcome = await runLadder({
    ctx: makeCtx(),
    cfg,
    agent,
    rec: record,
    diagnosis: {},
    signal: new AbortController().signal,
    provider: 'hh-commandcode2',
    log: () => {},
  })
  assert.equal(outcome.kind, 'exhausted')
  assert.equal(record.cycle, 2, 'the ladder used every cycle before giving up')
  assert.ok(outcome.notes.length >= 3, 'each failed strategy is reported')
})

// ---------------------------------------------------------------------------
// 7. End-to-end wiring through the plugin's listeners
// ---------------------------------------------------------------------------

await checkAsync('apply(): recovers a real 400 and returns { kind: "retry" }', async () => {
  const ctx = makeCtx()
  apply(ctx, { maxCycles: 1, probeAttempts: 0, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } })

  const session = buildSession()
  const agent = makeAgent(session)
  const action = await waterfall(ctx, 'agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.deepEqual(action, { kind: 'retry' })
  assert.ok(session.surface.replaceGeneration > 0, 'history was repaired durably')
  const joined = ctx.lines.join('\n')
  assert.match(joined, /provider-error: type=invalid_request_error/)
  assert.match(joined, /trace_id=53cfc3ba738d8e7749918f27a2653fa8/)
  assert.match(joined, /previous-step: assistant#\d+ .*2 tool call\(s\)/)
  assert.match(joined, /called read/)
  assert.match(joined, /suspected-causes:/)
})

await checkAsync('apply(): delegates a failure it does not own', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(buildSession()),
    turn: 1,
    step: 1,
    provider: 'openai',
    failure: { code: 'SERVER', message: '500 boom' },
    signal: new AbortController().signal,
  })
  assert.equal(action, undefined)
})

await checkAsync('apply(): delegates auth and account-level failures the wording cannot fix', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  for (const code of ['AUTH', 'ACCOUNT_QUOTA', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ABORTED']) {
    const action = await waterfall(ctx, 'agent/request-error', {
      agent: makeAgent(buildSession()),
      turn: 1,
      step: 1,
      provider: 'hh-commandcode2',
      failure: { code, message: 'hh-commandcode2 API error (400): invalid request error' },
      signal: new AbortController().signal,
    })
    assert.equal(action, undefined, `${code} must not be owned`)
  }
})

await checkAsync('apply(): a route-scoped QUOTA moves to a route that still has credit', async () => {
  // Observed in a real session: hh-commandcode answered HTTP 400 with
  // "You have insufficient credits", which classifies as QUOTA. That key is out
  // of credit; another route is not, so the task can continue.
  const llm = {
    listProviders: () => [{ id: 'hh-commandcode', name: 'hh-commandcode' }, { id: 'deepseek', name: 'deepseek' }],
    listModels: async (provider) =>
      provider === 'deepseek' ? [{ id: 'deepseek-flash' }] : [{ id: 'deepseek/deepseek-v4.1-flash' }],
  }
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, { strategies: ['failover'], failover: { mode: 'any' } })

  const session = buildSession()
  const agent = makeAgent(session)
  const action = await waterfall(ctx, 'agent/request-error', {
    agent,
    turn: 7,
    step: 6,
    provider: 'hh-commandcode',
    failure: {
      code: 'QUOTA',
      message:
        'hh-commandcode API error (400): {"message":"You have insufficient credits to make this request. ' +
        'Please purchase more credits to continue using the service.","type":"invalid_request_error","code":"BAD_REQUEST"}',
    },
    signal: new AbortController().signal,
  })
  assert.deepEqual(action, { kind: 'retry' }, 'a route-scoped credit failure is recoverable by switching route')
  assert.equal(session.surface.replaceGeneration, 0, 'credit recovery must not touch history')

  const seed = () => ({ provider: 'hh-commandcode', model: 'deepseek/deepseek-v4.1-flash' })
  const config = await waterfall(
    ctx,
    'agent/request',
    { agent, turn: 7, step: 6, signal: new AbortController().signal },
    seed,
  )
  assert.equal(config.provider, 'deepseek', 'the retry lands on a route outside the credit-exhausted one')
})

await checkAsync('apply(): onQuota=delegate leaves a credit failure to the shipped behaviour', async () => {
  const llm = { listProviders: () => [{ id: 'command', name: 'command' }], listModels: async () => [{ id: 'x' }] }
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, { onQuota: 'delegate', failover: { mode: 'any' } })
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(buildSession()),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode',
    failure: { code: 'QUOTA', message: 'hh-commandcode API error (400): insufficient credits' },
    signal: new AbortController().signal,
  })
  assert.equal(action, undefined)
})

await checkAsync('apply(): a credit failure with no other route surfaces instead of retrying a dead key', async () => {
  // Only the failing route is registered, so there is nothing to switch to.
  // Retrying the same key cannot restore credit, so the ladder must delegate
  // rather than burn requests against it.
  const llm = { listProviders: () => [{ id: 'hh-commandcode', name: 'hh-commandcode' }], listModels: async () => [] }
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, {
    onQuota: 'failover',
    strategies: ['failover'],
    onExhausted: 'retry',
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  })
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(buildSession()),
    turn: 7,
    step: 6,
    provider: 'hh-commandcode',
    failure: {
      code: 'QUOTA',
      message:
        'hh-commandcode API error (400): {"message":"You have insufficient credits to make this request.",' +
        '"type":"invalid_request_error","code":"BAD_REQUEST"}',
    },
    signal: new AbortController().signal,
  })
  assert.equal(action, undefined, 'no route switch is possible, so the quota error surfaces')
  assert.match(ctx.lines.join('\n'), /no usable route left/)
})

await checkAsync('apply(): dryRun diagnoses but never mutates', async () => {
  const ctx = makeCtx()
  apply(ctx, { dryRun: true })
  const session = buildSession()
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(session),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.equal(action, undefined)
  assert.equal(session.surface.replaceGeneration, 0)
  assert.match(ctx.lines.join('\n'), /dryRun is on/)
})

await checkAsync('apply(): an aborted turn is never recovered', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const controller = new AbortController()
  controller.abort()
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(buildSession()),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: controller.signal,
  })
  assert.equal(action, undefined)
})

await checkAsync('apply(): failover rewrites the next attempt call config only', async () => {
  const llm = {
    listProviders: () => [{ name: 'hh-commandcode2' }, { name: 'command' }],
    listModels: async (provider) => (provider === 'command' ? [{ id: 'deepseek/deepseek-v4.1-flash' }] : []),
  }
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, { strategies: ['failover'] })

  const session = buildSession()
  const agent = makeAgent(session)
  const action = await waterfall(ctx, 'agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(session.surface.replaceGeneration, 0, 'failover must not touch history')

  // next() yields the machine's seeded call config, which the loop resolves from
  // AgentOptions on the first request; the override is layered on top of it.
  const seed = () => ({ provider: 'hh-commandcode2', model: 'deepseek/deepseek-v4.1-flash' })
  const config = await waterfall(ctx, 'agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, seed)
  assert.deepEqual(config, { provider: 'command', model: 'deepseek/deepseek-v4.1-flash' })

  // The override is consumed exactly once, so the following attempt is untouched.
  const again = await waterfall(ctx, 'agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, seed)
  assert.deepEqual(again, seed())

  // And it is scoped to the turn/step that failed.
  const other = await waterfall(ctx, 'agent/request', { agent, turn: 2, step: 1, signal: new AbortController().signal }, seed)
  assert.deepEqual(other, seed())
})

await checkAsync('runLadder: consecutive failures escalate instead of repeating failover', async () => {
  // Regression for the bug a real session exposed: turn 7 step 6 failed four
  // times, switching hh-commandcode2 -> command -> hh-commandcode and never once
  // trying to repair the request — because `failover` always claims progress and
  // so was selected on every failure. A successful strategy must retire.
  const llm = {
    listProviders: () => [
      { id: 'command', name: 'command' },
      { id: 'hh-commandcode', name: 'hh-commandcode' },
      { id: 'hh-commandcode2', name: 'hh-commandcode2' },
    ],
    listModels: async () => [{ id: 'deepseek/deepseek-v4.1-flash' }],
  }
  const ctx = makeCtx({ services: { llm } })
  const session = buildSession()
  const agent = makeAgent(session)
  const cfg = resolveConfig({ strategies: ['failover', 'prune'], probeAttempts: 0 })
  const record = {
    key: '7:6',
    turn: 7,
    step: 6,
    attempts: 0,
    cycle: 1,
    used: new Set(),
    probeCount: 0,
    askedOnce: false,
    priority: null,
    only: null,
    history: [],
    triedRoutes: new Set(),
  }
  const seen = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    record.attempts += 1
    const outcome = await runLadder({
      ctx,
      cfg,
      agent,
      rec: record,
      diagnosis: { isSubagent: false, suspectedCauses: [] },
      signal: new AbortController().signal,
      provider: 'hh-commandcode2',
      log: () => {},
    })
    seen.push(outcome.strategy)
    if (outcome.kind !== 'retry') break
  }
  assert.deepEqual(
    seen,
    ['failover', 'prune', 'failover'],
    `unexpected sequence ${JSON.stringify(seen)}`,
  )
  // The point of the fix: request repair is reached on the SECOND failure, not
  // never. Before the fix this sequence was failover, failover, failover.
  assert.equal(seen[1], 'prune', 'the second failure repairs the request instead of switching route again')
  assert.ok(session.surface.replaceGeneration > 0, 'the request was actually repaired')
})

await checkAsync('failoverTargets: excludes routes and reports when only other models exist', async () => {
  const llm = {
    listProviders: () => [
      { id: 'hh-commandcode', name: 'hh-commandcode' },
      { id: 'command', name: 'command' },
      { id: 'deepseek', name: 'deepseek' },
    ],
    listModels: async (provider) => {
      if (provider === 'deepseek') return [{ id: 'deepseek-flash' }]
      return [{ id: 'deepseek/deepseek-v4.1-flash' }]
    },
  }
  const logged = []
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, {
    strategies: ['failover'],
    failover: { mode: 'same-model', exclude: ['hh-commandcode'] },
  })
  const agent = makeAgent(buildSession())
  const action = await waterfall(ctx, 'agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.deepEqual(action, { kind: 'retry' })
  const config = await waterfall(
    ctx,
    'agent/request',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    () => ({ provider: 'hh-commandcode2', model: 'deepseek/deepseek-v4.1-flash' }),
  )
  assert.equal(config.provider, 'command', 'the excluded alias is skipped')
})

await checkAsync('failoverTargets: warns when only other-model routes exist', async () => {
  // same-model mode with every same-model route excluded: failover cannot help,
  // and the log must say why instead of silently doing nothing.
  const llm = {
    listProviders: () => [
      { id: 'hh-commandcode', name: 'hh-commandcode' },
      { id: 'command', name: 'command' },
      { id: 'deepseek', name: 'deepseek' },
    ],
    listModels: async (provider) =>
      provider === 'deepseek' ? [{ id: 'deepseek-flash' }] : [{ id: 'deepseek/deepseek-v4.1-flash' }],
  }
  const ctx = makeCtx({ services: { llm } })
  apply(ctx, {
    strategies: ['failover'],
    failover: { mode: 'same-model', exclude: ['hh-commandcode', 'command'] },
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  })
  await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(buildSession()),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.match(ctx.lines.join('\n'), /only for other models/)
  assert.match(ctx.lines.join('\n'), /set failover\.mode: 'any'/)
})

await checkAsync('apply(): a delegated subagent is recovered but never asked', async () => {
  let asked = false
  const userQuestions = {
    ask: async () => {
      asked = true
      return { answers: [] }
    },
  }
  const ctx = makeCtx({ services: { userQuestions } })
  apply(ctx, { strategies: ['ask'], backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } })
  const session = buildSession()
  const agent = makeAgent(session, { isSubagent: true })
  const action = await waterfall(ctx, 'agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.equal(asked, false, 'a subagent has no human answerer')
  // With ask declining, the exhausted path keeps the task alive by default.
  assert.deepEqual(action, { kind: 'retry' })
})

await checkAsync('apply(): a user choice drives the chosen strategy', async () => {
  const userQuestions = {
    ask: async () => ({ answers: [{ id: 'retry-for-commandcode', selected: ['精简旧上下文后重试'] }] }),
  }
  const ctx = makeCtx({ services: { userQuestions } })
  apply(ctx, { strategies: ['ask'], ask: { timeoutMs: 1000 } })
  const session = buildSession()
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(session),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.deepEqual(action, { kind: 'retry' })
  assert.ok(session.surface.replaceGeneration > 0, 'the chosen elide strategy ran')
})

await checkAsync('apply(): onExhausted=delegate surfaces the error instead of looping', async () => {
  const ctx = makeCtx()
  apply(ctx, { strategies: ['prune'], onExhausted: 'delegate', maxCycles: 1 })
  // Nothing oversized, so prune cannot help and there is nowhere left to go.
  const session = new MiniSession([
    { seq: 0, time: 0, type: 'user/message', data: textMessage(0, 'user', 'hi'), surfaceOp: 'append' },
  ])
  const action = await waterfall(ctx, 'agent/request-error', {
    agent: makeAgent(session),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  })
  assert.equal(action, undefined)
})

await checkAsync('apply(): the hard budget is terminal', async () => {
  const ctx = makeCtx()
  apply(ctx, {
    maxRecoveriesPerStep: 1,
    strategies: ['probe'],
    onExhausted: 'retry',
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  })
  const agent = makeAgent(buildSession())
  const payload = {
    agent,
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    failure: realFailure,
    signal: new AbortController().signal,
  }
  assert.deepEqual(await waterfall(ctx, 'agent/request-error', payload), { kind: 'retry' })
  assert.deepEqual(await waterfall(ctx, 'agent/request-error', payload), { kind: 'retry' })
  // attempts is now 2 and onExhausted is 'retry', so it still keeps going — the
  // documented never-stop mode, which deliberately ignores the budget.
  assert.deepEqual(await waterfall(ctx, 'agent/request-error', payload), { kind: 'retry' })

  // With the default 'ask' and no answerer available, the budget is enforced
  // exactly: maxRecoveriesPerStep recoveries, then the failure surfaces.
  const strict = makeCtx()
  apply(strict, {
    maxRecoveriesPerStep: 1,
    strategies: ['probe'],
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  })
  const strictAgent = makeAgent(buildSession())
  const strictPayload = { ...payload, agent: strictAgent }
  assert.deepEqual(await waterfall(strict, 'agent/request-error', strictPayload), { kind: 'retry' })
  assert.equal(await waterfall(strict, 'agent/request-error', strictPayload), undefined)
  assert.match(strict.lines.join('\n'), /recovery budget of 1 attempts is exhausted/)
})

await checkAsync('apply(): invalid config fails loudly at load', async () => {
  const ctx = makeCtx()
  assert.throws(() => apply(ctx, { strategies: ['nope'] }), /strategies entry "nope"/)
})

await checkAsync('apply(): disabled installs no listeners', async () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.listeners.size, 0)
})

await checkAsync('apply(): an internal failure delegates rather than breaking the turn', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  // A payload whose `failure` throws on property access exercises the catch-all.
  const hostile = {
    agent: makeAgent(buildSession()),
    turn: 1,
    step: 1,
    provider: 'hh-commandcode2',
    get failure() {
      throw new Error('hostile getter')
    },
    signal: new AbortController().signal,
  }
  const action = await waterfall(ctx, 'agent/request-error', hostile)
  assert.equal(action, undefined)
  assert.match(ctx.lines.join('\n'), /internal error while recovering/)
})

// ---------------------------------------------------------------------------
// 8. Diagnosis rendering
// ---------------------------------------------------------------------------

check('diagnose/renderDiagnosis: produces a readable, provider-truthful report', () => {
  const cfg = resolveConfig({})
  const session = buildSession()
  const diagnosis = diagnose({
    ctx: makeCtx(),
    cfg,
    agent: makeAgent(session),
    provider: 'hh-commandcode2',
    failure: realFailure,
    verdict: classifyFailure(realFailure, 'hh-commandcode2', cfg),
    turn: 3,
    step: 2,
    attempt: 1,
    cycle: 1,
    strategyHistory: [],
  })
  assert.equal(diagnosis.status, 400)
  assert.equal(diagnosis.traceId, '53cfc3ba738d8e7749918f27a2653fa8')
  assert.equal(diagnosis.inspection.nodeCount, 24)
  assert.equal(diagnosis.isSubagent, false)
  assert.ok(diagnosis.suspectedCauses.length > 0)
  const rendered = renderDiagnosis(diagnosis).join('\n')
  assert.match(rendered, /provider=hh-commandcode2/)
  assert.match(rendered, /status=400/)
  assert.match(rendered, /largest seq=3/)
  assert.match(rendered, /result 40000 chars/)
  // The composition is rendered, so an operator can see how much of the request
  // the ladder is structurally unable to touch.
  assert.match(rendered, /request: 24 messages, [\d.]+ KB \(~\d+ tokens\), untouchable \d+%/)
  assert.match(rendered, /role tool: /)
  assert.match(rendered, /largest message: [\d.]+ KB role=tool/)
})

check('diagnose: an assistant-dominated request blames the untouchable share first', () => {
  const cfg = resolveConfig({})
  const session = buildAssistantHeavySession()
  const diagnosis = diagnose({
    ctx: makeCtx(),
    cfg,
    agent: makeAgent(session),
    provider: 'hh-commandcode2',
    failure: realFailure,
    verdict: classifyFailure(realFailure, 'hh-commandcode2', cfg),
    turn: 5,
    step: 9,
    attempt: 1,
    cycle: 1,
    strategyHistory: [],
  })
  const top = diagnosis.suspectedCauses[0]
  assert.equal(top.confidence, 'high')
  assert.match(top.cause, /% of the outgoing request .* is inside assistant messages/)
  assert.match(top.remedy, /compact/)
  const rendered = renderDiagnosis(diagnosis).join('\n')
  assert.match(rendered, /untouchable 9\d%/)
})

// ---------------------------------------------------------------------------

const total = passed + failures.length
console.log(`\ndsh-retry-for-commandcode self-test: ${passed}/${total} checks passed`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('all good')
}
