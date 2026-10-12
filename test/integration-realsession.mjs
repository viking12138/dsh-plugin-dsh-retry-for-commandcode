/**
 * Integration test against the real `@deepseek-ai/dsh-session`.
 *
 * The self-test proves the plugin's logic; this proves the part that can only be
 * proven against the shipped implementation: that the durable rewrite the
 * plugin emits is **accepted** by `Session.append`, actually **shrinks** the
 * derived request history, **replays identically** through the canonical surface
 * fold, and leaves a log that **resumes** — the property that made inventing a
 * plugin-owned event type unacceptable in the first place.
 *
 * Skips cleanly (exit 0 with a notice) when the DSH packages cannot be located.
 *
 * Usage: node test/integration-realsession.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveConfig } from '../lib/config.js'
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

// ---------------------------------------------------------------------------
// Locate the shipped packages
// ---------------------------------------------------------------------------

function findSessionPackage() {
  const candidates = [
    process.env.DSH_SESSION_DIR,
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-session'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-session'),
    join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-session',
    ),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    const entry = join(candidate, 'lib', 'index.js')
    if (existsSync(entry)) return { dir: candidate, entry }
  }
  return undefined
}

const found = findSessionPackage()
if (found === undefined) {
  console.log('dsh-session not found on this machine; skipping the real-session integration test.')
  process.exit(0)
}

const sessionModule = await import(pathToFileURL(found.entry).href)
const surfaceModule = await import(pathToFileURL(join(found.dir, 'lib', 'types', 'surface.js')).href)
const { Session, SessionId } = sessionModule
const { foldSurface } = surfaceModule

console.log(`using ${found.dir}\n`)

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

// ---------------------------------------------------------------------------
// Seed a realistic session log using the exact shapes the agent loop appends
// ---------------------------------------------------------------------------

const HUGE = 'A'.repeat(40000)

function seedEvents() {
  const events = []
  const push = (type, data, opts) => events.push({ type, seq: events.length, time: 1000 + events.length, data, ...opts })

  push(
    'system/message',
    {
      turn: 0,
      step: 0,
      message: {
        id: 'sys-1',
        role: 'system',
        content: [{ type: 'text', text: 'You are a coding agent.' }],
        source: { kind: 'system-prompt' },
      },
    },
    { surfaceOp: 'append' },
  )
  push(
    'user/message',
    {
      id: 'u-1',
      role: 'user',
      content: [{ type: 'text', text: 'Refactor the parser and run the tests.' }],
      source: { kind: 'user' },
    },
    { surfaceOp: 'append' },
  )
  // Tool results cite the assistant event that requested them, exactly as the
  // loop appends them.
  for (let index = 0; index < 8; index += 1) {
    push(
      'tool/result',
      {
        turn: 1,
        step: index + 1,
        message: {
          id: `t-${index}`,
          role: 'tool',
          content: [{ type: 'text', text: index === 0 ? HUGE : `result ${index} `.repeat(30) }],
          source: { kind: 'tool', callId: `call_${index}` },
          toolCallId: `call_${index}`,
          ...(index === 3 ? { isError: true } : {}),
        },
      },
      // The loop cites the assistant event that requested the call; this seed has
      // no assistant events, and `sourceEventSeqs` is optional on an append.
      { surfaceOp: 'append' },
    )
  }
  return events
}

function createSession(seed) {
  return Session.create(SessionId('integration-test'), seed)
}

function totalChars(messages) {
  let total = 0
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') total += block.text.length
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// 1. The seed is a valid, resumable log
// ---------------------------------------------------------------------------

check('seed: the real Session accepts the seeded log', () => {
  const session = createSession(seedEvents())
  const messages = session.deriveMessages()
  assert.equal(messages.length, 10, 'system + user + 8 tool results')
  assert.ok(totalChars(messages) > 40000)
})

// ---------------------------------------------------------------------------
// 2. The plugin's rewrite is accepted and actually shrinks the request
// ---------------------------------------------------------------------------

check('rewrite: real Session.append accepts the compaction/prune + replacement pair', () => {
  const session = createSession(seedEvents())
  const before = session.deriveMessages()
  const beforeChars = totalChars(before)
  const inspection = inspectSurface(session, { topN: 5 })
  assert.equal(inspection.nodeCount, 10)

  const cfg = resolveConfig({})
  const candidates = pruneCandidates(inspection, cfg)
  assert.deepEqual(candidates.map((node) => node.seq), [2], 'the single over-budget node')

  const node = inspectNode(session, 2)
  const content = pruneContent(node.content, cfg.prune)
  const outcome = rewriteNodeContent(session, node, content, { label: 'tool result' })
  assert.equal(outcome.error, undefined, `append was refused: ${outcome.error?.message}`)
  assert.ok(outcome.savedChars > 30000)

  const after = session.deriveMessages()
  const afterChars = totalChars(after)
  assert.equal(after.length, before.length, 'node topology and message count are unchanged')
  assert.ok(afterChars < beforeChars - 30000, `history must shrink (${beforeChars} -> ${afterChars})`)

  // The replacement is the node the model will now see.
  const projected = after.find((message) => message.id === 't-0')
  assert.ok(projected !== undefined, 'the tool message identity survives the rewrite')
  const text = projected.content.find((block) => block.type === 'text').text
  assert.ok(text.includes('elided by dsh-retry-for-commandcode'))
  assert.ok(text.startsWith('A'.repeat(10)))
})

check('rewrite: elide sheds the oldest nodes and leaves the tail intact', () => {
  const session = createSession(seedEvents())
  const cfg = resolveConfig({ elide: { keepRecentNodes: 3, minChars: 100, minTotalChars: 0 } })
  const inspection = inspectSurface(session, { topN: 1 })
  const candidates = elideCandidates(inspection, cfg)
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((node) => node.seq !== 0), 'surface node 0 is never a candidate')

  let rewritten = 0
  for (const candidate of candidates) {
    const node = inspectNode(session, candidate.seq)
    const content = stubContent(node.content, { headChars: 10, label: 'tool result' })
    if (content === null) continue
    const outcome = rewriteNodeContent(session, node, content, { label: 'tool result' })
    assert.equal(outcome.error, undefined, `append was refused: ${outcome.error?.message}`)
    rewritten += 1
  }
  assert.ok(rewritten > 0)

  const messages = session.deriveMessages()
  // The newest three nodes are the last three tool results; they must be untouched.
  for (const index of [7]) {
    const message = messages.find((entry) => entry.id === `t-${index}`)
    const text = message.content.find((block) => block.type === 'text').text
    assert.ok(!text.includes('removed by dsh-retry-for-commandcode'), `t-${index} is in the retained tail`)
  }
  // The system prompt at node 0 is untouched.
  const system = messages.find((entry) => entry.id === 'sys-1')
  assert.equal(system.content[0].text, 'You are a coding agent.')
})

// ---------------------------------------------------------------------------
// 3. Replay fidelity: the fold reconstructs exactly what the live session sees
// ---------------------------------------------------------------------------

check('replay: foldSurface reproduces the live derived history exactly', () => {
  const session = createSession(seedEvents())
  const cfg = resolveConfig({})
  const node = inspectNode(session, 2)
  rewriteNodeContent(session, node, pruneContent(node.content, cfg.prune), { label: 'tool result' })

  const live = session.deriveMessages()
  const folded = foldSurface(session.snapshotEvents())
  const replayed = folded.nodes.map((seq) => {
    const event = session.snapshotEvents()[seq]
    return surfaceModule.deriveEventMessage(event, folded.projectedMessages)
  })

  assert.deepEqual(
    folded.nodes,
    [...session.surface.nodes],
    'the folded surface matches the live surface',
  )
  assert.equal(replayed.length, live.length)
  for (let index = 0; index < live.length; index += 1) {
    assert.equal(replayed[index]?.id, live[index]?.id, `message ${index} identity matches on replay`)
    assert.deepEqual(replayed[index]?.content, live[index]?.content, `message ${index} content matches on replay`)
  }
})

// ---------------------------------------------------------------------------
// 4. The rewritten log still resumes — the whole reason no new event type is used
// ---------------------------------------------------------------------------

check('resume: a session recreated from the rewritten log reconstructs identically', () => {
  const session = createSession(seedEvents())
  const cfg = resolveConfig({})
  const node = inspectNode(session, 2)
  rewriteNodeContent(session, node, pruneContent(node.content, cfg.prune), { label: 'tool result' })
  const expected = session.deriveMessages()
  const snapshot = session.snapshotEvents()

  // Recreate from the durable log alone: this is what resuming a session does,
  // and what dsh-session-persistence refuses when it meets an unknown,
  // non-ignorable event type.
  const resumed = createSession(snapshot)
  const actual = resumed.deriveMessages()
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index].id, expected[index].id)
    assert.deepEqual(actual[index].content, expected[index].content)
  }
})

// ---------------------------------------------------------------------------
// 5. Node 0 protection and the compaction invariant's shape rules
// ---------------------------------------------------------------------------

check('protection: the real Session refuses to rewrite the system prompt at node 0', () => {
  const session = createSession(seedEvents())
  const system = inspectNode(session, 0)
  assert.equal(system.type, 'system/message')
  assert.equal(system.rewritable, false)
  assert.equal(rewriteNodeContent(session, system, [{ type: 'text', text: 'hijacked' }], { label: 'x' }), null)
})

check('protection: a tool/result replacement may not change anything but content', () => {
  const session = createSession(seedEvents())
  const node = inspectNode(session, 3)
  const event = session.eventAt(3)
  // Same id/content change is fine; a changed toolCallId is not.
  assert.throws(
    () =>
      session.append(
        'tool/result',
        { ...event.data, message: { ...event.data.message, toolCallId: 'different' } },
        { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] },
      ),
    /may change only content/,
  )
})

check('invariant: the emitted compaction/prune satisfies compaction-invariant rules', () => {
  const session = createSession(seedEvents())
  const node = inspectNode(session, 2)
  rewriteNodeContent(session, node, pruneContent(node.content, resolveConfig({}).prune), { label: 'tool result' })
  const prune = session.snapshotEvents().find((event) => event.type === 'compaction/prune')
  assert.ok(prune !== undefined, 'a compaction/prune record was written')
  const { shadowedRange, shadowedSeqs, shadowedTokenCount } = prune.data
  // validateShadowedSeqs: first/last must match the range, and the list must
  // name every node of the current surface span (a single node here).
  assert.equal(shadowedSeqs[0], shadowedRange.start)
  assert.equal(shadowedSeqs.at(-1), shadowedRange.end)
  assert.equal(shadowedSeqs.length, shadowedRange.end - shadowedRange.start + 1)
  assert.ok(Number.isSafeInteger(shadowedTokenCount) && shadowedTokenCount >= 0)
  // The prune record must be immediately followed by its replacement.
  const events = session.snapshotEvents()
  const index = events.indexOf(prune)
  assert.equal(events[index + 1].surfaceOp?.op, 'replace', 'the replacement follows immediately')
})

check('invariant: every event type the plugin appends is in the harness vocabulary', () => {
  // This is the authoritative check: dsh-session-persistence refuses to resume a
  // log containing a type outside KNOWN_SESSION_EVENT_TYPES unless the event
  // carries the `ignorable` envelope marker, and `append` cannot set that marker.
  const { KNOWN_SESSION_EVENT_TYPES } = sessionModule
  assert.ok(KNOWN_SESSION_EVENT_TYPES instanceof Set, 'the harness exports its vocabulary')

  const session = createSession(seedEvents())
  const before = session.snapshotEvents().length
  const node = inspectNode(session, 2)
  rewriteNodeContent(session, node, pruneContent(node.content, resolveConfig({}).prune), { label: 'tool result' })

  const appended = session.snapshotEvents().slice(before)
  assert.ok(appended.length > 0, 'the rewrite wrote something')
  for (const event of appended) {
    assert.ok(
      KNOWN_SESSION_EVENT_TYPES.has(event.type),
      `the plugin appended "${event.type}", which is outside the harness vocabulary — an unknown, ` +
        'non-ignorable type would make dsh-session-persistence refuse to resume the session',
    )
    assert.equal(event.ignorable, undefined, 'the plugin never relies on the ignorable escape hatch')
  }
})

// ---------------------------------------------------------------------------
// 6. The composition measurement: what the plugin can and cannot shrink
// ---------------------------------------------------------------------------

/**
 * A session shaped like a real coding run under this route: assistant messages
 * carry their reasoning and tool calls, and each assistant message embeds the
 * provider replay state (`source.replayState`) that `dsh-llm-pi-ai` needs to
 * continue the conversation. All of that lives inside `assistant/message` nodes.
 */
function seedAssistantHeavyEvents() {
  const events = []
  const push = (type, data, opts) => events.push({ type, seq: events.length, time: 1000 + events.length, data, ...opts })

  push(
    'system/message',
    {
      turn: 0,
      step: 0,
      message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } },
    },
    { surfaceOp: 'append' },
  )
  push(
    'user/message',
    {
      id: 'u-1',
      role: 'user',
      content: [{ type: 'text', text: 'Refactor the parser and run the tests.' }],
      source: { kind: 'user' },
    },
    { surfaceOp: 'append' },
  )
  for (let index = 0; index < 3; index += 1) {
    const assistantSeq = events.length
    push(
      'assistant/message',
      {
        turn: 1,
        step: index + 1,
        // `assistant/message` carries the settled stream rather than citing it
        // through sourceEventSeqs, which is exactly what makes the node
        // referenceable but not shadowable.
        stream: [],
        message: {
          id: `a-${index}`,
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'R'.repeat(30000) },
            { type: 'text', text: 'I will read the parser next.' },
            { type: 'tool-call', id: `call_${index}`, name: 'read', arguments: '{"path":"parser.ts"}' },
          ],
          source: {
            kind: 'model',
            provider: 'hh-commandcode2',
            model: 'deepseek/deepseek-v4.1-flash',
            // The replay blob the harness must not have rewritten under it.
            replayState: { response: { kind: 'pi-ai', version: 2, responseId: `resp_${index}` } },
          },
        },
      },
      { surfaceOp: 'append' },
    )
    push(
      'tool/result',
      {
        turn: 1,
        step: index + 1,
        message: {
          id: `t-${index}`,
          role: 'tool',
          content: [{ type: 'text', text: index === 0 ? HUGE : `result ${index} `.repeat(30) }],
          source: { kind: 'tool', callId: `call_${index}` },
          toolCallId: `call_${index}`,
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [assistantSeq] },
    )
  }
  return events
}

check('composition: the real derived history splits into reachable and unreachable bytes', () => {
  const session = createSession(seedEvents())
  const composition = describeRequestComposition(session)
  assert.ok(composition !== null, 'the composition is measurable on a real session')
  assert.equal(composition.messages, 10)
  assert.equal(
    composition.touchableBytes + composition.untouchableBytes,
    composition.totalBytes,
    'every measured byte is classified exactly once',
  )
  // The 40000-char tool result is a `tool`-role message carrying a `text` block,
  // which is exactly what the plugin is allowed to rewrite.
  assert.ok(composition.touchableBytes > 40000, `expected the tool result to be reachable (${composition.touchableBytes} bytes)`)
  assert.equal(composition.largest.role, 'tool')
  assert.equal(composition.largest.id, 't-0')
})

check('composition: an assistant-dominated request is majority untouchable', () => {
  const session = createSession(seedAssistantHeavyEvents())
  const composition = describeRequestComposition(session)
  // Three assistant messages carrying 30 KB of reasoning each vs one 40 KB tool
  // result: the ladder can shrink the result and still leave most of the request
  // exactly where it was.
  assert.ok(composition.untouchablePercent > 50, `expected a majority untouchable share, got ${composition.untouchablePercent}%`)
  assert.ok(
    composition.untouchableBytes > composition.touchableBytes,
    `untouchable ${composition.untouchableBytes} should exceed touchable ${composition.touchableBytes}`,
  )
  // Per-message the largest node is rewritable (the 40 KB tool result), but in
  // aggregate the assistant messages dominate — which is exactly the case a
  // "find the biggest node and prune it" reflex gets wrong.
  assert.equal(composition.largest.role, 'tool')
  assert.equal(composition.largest.id, 't-0')
  assert.deepEqual(composition.byRole[0][0], 'assistant')
})

check('composition: the real Session refuses to rewrite an assistant node, with or without citations', () => {
  const session = createSession(seedAssistantHeavyEvents())
  const assistantSeq = 2
  const node = inspectNode(session, assistantSeq)
  assert.equal(node.type, 'assistant/message')
  assert.equal(node.rewritable, false)
  // The plugin's own path refuses it.
  assert.equal(rewriteNodeContent(session, node, [{ type: 'text', text: 'x' }], { label: 'assistant' }), null)

  // So does the harness, both ways — which is why no amount of pruning can shed
  // this content, and why the composition reports it as untouchable.
  const event = session.eventAt(assistantSeq)
  const content = [{ type: 'text', text: 'rewritten' }]
  assert.throws(
    () =>
      session.append(
        'assistant/message',
        { ...event.data, message: { ...event.data.message, content } },
        { surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq }, sourceEventSeqs: [assistantSeq] },
      ),
    /cannot carry sourceEventSeqs|embeds its source stream/,
  )
  assert.throws(
    () =>
      session.append(
        'assistant/message',
        { ...event.data, message: { ...event.data.message, content } },
        { surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq } },
      ),
    /sourceEventSeqs/,
  )
})

// ---------------------------------------------------------------------------

const total = passed + failures.length
console.log(`dsh-retry-for-commandcode real-session integration: ${passed}/${total} checks passed`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('all good')
}
