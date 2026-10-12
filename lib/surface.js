/**
 * Session-surface inspection and durable, replay-safe content repair.
 *
 * ## Why rewrites go through the session log
 *
 * The agent loop assembles every attempt's request from the durable session
 * surface (`buildRequest` → `session.deriveMessages()`), and the loop-built
 * request handed to the `llm/stream` waterfall is deep-frozen. A plugin
 * therefore cannot edit the outgoing request — it must change the durable
 * history and let the retried attempt re-derive it. `dsh-compaction-image-offload`
 * and `dsh-compaction-tool-result-pruner` are the shipped precedents.
 *
 * ## Why the rewrite shape below
 *
 * `Session.append` only accepts event types this harness build knows, and
 * `dsh-session-persistence` *refuses to resume* a session containing an unknown
 * type that is not marked `ignorable` — and `append` cannot set `ignorable`.
 * This plugin consequently invents no event types. It repairs content with the
 * exact pair the shipped pruner uses:
 *
 *   1. `compaction/prune` — the log-only shadow-price record, which also
 *      satisfies `dsh-compaction`'s invariant (`shadowedSeqs` must list every
 *      node of the named current surface span, so a single-node span is valid).
 *   2. a same-type replacement of that one node with `surfaceOp:
 *      { op: 'replace', startSeq, endSeq }` and `sourceEventSeqs: [seq]`.
 *
 * `assertToolResultRewrite` in `dsh-session` permits a `tool/result`
 * replacement of exactly one current `tool/result` node that changes **only**
 * `message.content`; `assertSystemHeadRewrite` protects surface node 0 only when
 * it is a `system/message`. Both are honored here: this module only ever
 * rewrites single `tool/result` and `user/message` nodes, changes only
 * `content`, and never touches node 0's `system/message`.
 *
 * @module dsh-retry-for-commandcode/surface
 */

import { blockKindCounts, charCount, estimateTokens, previewOf, textBlocks, truncateText, withoutUndefined } from './util.js'

/** Node types this plugin is allowed to rewrite, and how to read their payload. */
const REWRITABLE = Object.freeze(new Set(['tool/result', 'user/message']))

/** Resolve an optional service from the agent scope first, then the root scope. */
export function resolveService(ctx, agent, serviceName) {
  for (const scope of [agent?.ctx, ctx]) {
    if (scope === undefined || scope === null) continue
    try {
      const value = typeof scope.get === 'function' ? scope.get(serviceName) : undefined
      if (value !== undefined && value !== null) return value
    } catch {
      // An isolated group can refuse a lookup; try the next scope.
    }
  }
  return undefined
}

/** The current surface node seqs, as a copy safe to iterate while appending. */
export function surfaceNodes(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? [...nodes] : []
}

/** The `surface.replaceGeneration` counter, or `-1` when unavailable. */
export function replaceGeneration(session) {
  const value = session?.surface?.replaceGeneration
  return Number.isSafeInteger(value) ? value : -1
}

/**
 * Inspect one surface node.
 * @returns `null` when the node produces no message or cannot be rewritten.
 */
export function inspectNode(session, seq) {
  let event
  let message
  try {
    event = session.eventAt(seq)
    if (event === null || event === undefined) return null
    message = session.deriveEventMessage(event)
  } catch {
    return null
  }
  if (message === null || message === undefined) return null
  const content = message.content
  return {
    seq,
    type: event.type,
    rewritable: REWRITABLE.has(event.type),
    role: typeof message.role === 'string' ? message.role : undefined,
    content,
    chars: charCount(content),
    kinds: blockKindCounts(content),
    preview: previewOf(content),
    toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
    toolName: toolNameOf(message),
    hasNonTextBlocks: (content ?? []).some((block) => block?.type !== 'text'),
  }
}

/** The tool a `tool-call` block names, for diagnostics. */
function toolNameOf(message) {
  if (!Array.isArray(message?.content)) return undefined
  for (const block of message.content) {
    if (block?.type === 'tool-call' && typeof block.name === 'string') return block.name
  }
  return undefined
}

/**
 * A compact picture of the history the failed request was built from, plus the
 * activity of the most recent assistant step — the two things needed to explain
 * *why* a request was rejected and *what the previous step did*.
 */
export function inspectSurface(session, { topN = 5 } = {}) {
  const seqs = surfaceNodes(session)
  const nodes = []
  for (const seq of seqs) {
    const info = inspectNode(session, seq)
    if (info !== null) nodes.push(info)
  }
  const totalChars = nodes.reduce((sum, node) => sum + node.chars, 0)
  const byChars = [...nodes].sort((a, b) => b.chars - a.chars)
  return {
    nodeCount: seqs.length,
    described: nodes.length,
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 4),
    largest: byChars.slice(0, topN),
    oversized: byChars.filter((node) => node.chars > 0),
    nodes,
    lastStep: describeLastStep(session),
  }
}

/**
 * Measure what the outbound request will actually contain, broken down by role
 * and block type — and how much of it this plugin is *structurally unable* to
 * shrink.
 *
 * This exists because a real session showed the plugin pruning diligently (tool
 * text 432 KB down to 136 KB) while the request stayed above 1 MB and kept being
 * rejected. The reason is a hard constraint in `dsh-session`: a surface
 * replacement must cite `sourceEventSeqs` covering every shadowed node, while an
 * `assistant/message` is *forbidden* from carrying `sourceEventSeqs`
 * (`assertSourceEventReferences`). An assistant node can therefore never be
 * replaced, so its `reasoning` and `tool-call` payload — the largest and
 * fastest-growing part of a long session — cannot be trimmed by rewriting
 * content. Only compaction can shed it, by replacing a balanced *range* with a
 * summary node. Reporting that share is what makes the limit visible instead of
 * looking like the plugin is idle.
 *
 * The constraint is not merely mechanical. A real assistant message embeds its
 * provider replay state (`source.replayState`, carrying the thinking signature
 * and response id) and its settled stream, so rewriting it would break the
 * replay the route needs to continue — which is *why* the harness forbids the
 * citation. Content there is untouchable by design, not by omission.
 *
 * @param session - the agent's session.
 * @returns byte composition, or `null` when the history cannot be derived.
 */
export function describeRequestComposition(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return null
  }
  if (!Array.isArray(messages) || messages.length === 0) return null

  let total = 0
  const byRole = new Map()
  const byBlock = new Map()
  let untouchable = 0
  let touchable = 0
  let largest

  for (const message of messages) {
    let messageBytes = 0
    let roleUntouchable = 0
    let roleTouchable = 0
    for (const block of message.content ?? []) {
      let bytes = 0
      try {
        bytes = JSON.stringify(block).length
      } catch {
        bytes = 0
      }
      messageBytes += bytes
      const key = `${message.role}:${block.type}`
      byBlock.set(key, (byBlock.get(key) ?? 0) + bytes)
      // A node is rewritable by this plugin only when it is a tool/result or
      // user/message; everything inside an assistant message is out of reach.
      const reachable = message.role === 'tool' || message.role === 'user'
      const slimmable = reachable && (block.type === 'text' || block.type === 'reasoning')
      if (slimmable) roleTouchable += bytes
      else roleUntouchable += bytes
    }
    if (messageBytes > 0) {
      // The JSON envelope (role, id, source, toolCallId) is carried along too.
      const envelope = Math.max(0, JSON.stringify({ ...message, content: [] }).length)
      messageBytes += envelope
      roleUntouchable += envelope
    }
    total += messageBytes
    untouchable += roleUntouchable
    touchable += roleTouchable
    byRole.set(message.role, (byRole.get(message.role) ?? 0) + messageBytes)
    if (largest === undefined || messageBytes > largest.bytes) {
      largest = {
        bytes: messageBytes,
        role: message.role,
        id: typeof message.id === 'string' ? message.id : undefined,
        kinds: (message.content ?? []).map((block) => block.type).join(','),
      }
    }
  }

  return {
    messages: messages.length,
    totalBytes: total,
    estimatedTokens: Math.ceil(total / 4),
    byRole: [...byRole.entries()].sort((a, b) => b[1] - a[1]),
    byBlock: [...byBlock.entries()].sort((a, b) => b[1] - a[1]),
    touchableBytes: touchable,
    untouchableBytes: untouchable,
    untouchablePercent: total === 0 ? 0 : Math.round((untouchable / total) * 100),
    largest,
  }
}

/**
 * What the most recent assistant turn requested and how large its results were.
 * This is the "what did the previous step do?" answer: the tool calls the model
 * made in the last assistant message, paired with the results that came back.
 */
export function describeLastStep(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return null
  }
  if (!Array.isArray(messages) || messages.length === 0) return null

  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return null

  const assistant = messages[assistantIndex]
  const calls = []
  for (const block of assistant.content ?? []) {
    if (block?.type === 'tool-call') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : undefined,
        argumentChars: typeof block.arguments === 'string' ? block.arguments.length : 0,
      })
    }
  }
  const callIds = new Set(calls.map((call) => call.id).filter((id) => id !== undefined))
  const results = []
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'tool') continue
    if (callIds.size > 0 && !callIds.has(message.toolCallId)) continue
    results.push({
      toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      isError: message.isError === true,
      chars: charCount(message.content),
      preview: previewOf(message.content, 120),
    })
  }
  return {
    assistantIndex,
    totalMessages: messages.length,
    assistantText: previewOf(assistant.content, 200),
    toolCalls: calls,
    toolResults: results,
    toolResultChars: results.reduce((sum, result) => sum + result.chars, 0),
  }
}

/**
 * Trim the middle out of every over-budget text block, keeping a head and a
 * tail. Mirrors `dsh-compaction-tool-result-pruner`'s head/marker/tail shape but
 * works per block, and returns `null` when nothing needs trimming so a no-op
 * never writes to the log.
 *
 * Only `text` blocks are touched. `reasoning`, `image`, `file`, and tool-change
 * blocks are left byte-identical: rewriting them risks provider replay-state
 * rejection, and image bytes are `dsh-compaction-image-offload`'s concern.
 */
export function pruneContent(content, { thresholdChars, headChars, tailChars }) {
  if (charCount(content) <= thresholdChars) return null
  const marker = '\n\n[... elided by dsh-retry-for-commandcode ...]\n\n'
  const budget = headChars + tailChars + Array.from(marker).length
  let changed = false
  const next = []
  for (const block of content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      next.push(block)
      continue
    }
    const points = Array.from(block.text)
    if (points.length <= budget) {
      next.push(block)
      continue
    }
    const text = points.slice(0, headChars).join('') + marker + points.slice(points.length - tailChars).join('')
    next.push({ ...block, text })
    changed = true
  }
  return changed ? next : null
}

/**
 * Replace a message's text with a short head plus an explicit removal notice —
 * the aggressive "shed this context" transform behind the `elide` strategy.
 * Always leaves at least one non-empty text block, because an empty text block
 * is exactly the `"text content blocks must be non-empty"` 400 class this plugin
 * exists to escape.
 */
export function stubContent(content, { headChars, label }) {
  let changed = false
  const next = []
  for (const block of content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      next.push(block)
      continue
    }
    const points = Array.from(block.text)
    if (points.length <= headChars) {
      next.push(block)
      continue
    }
    const removed = points.length - headChars
    const notice = `[… ${removed} characters of ${label} removed by dsh-retry-for-commandcode …]`
    next.push({ ...block, text: `${points.slice(0, headChars).join('')}\n${notice}` })
    changed = true
  }
  if (!changed) return null
  const hasText = next.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
  if (!hasText) next.push({ type: 'text', text: `[${label} removed by dsh-retry-for-commandcode]` })
  return next
}

/** Estimated token price of a node, preferring the harness token meter. */
function priceOf(meter, message) {
  try {
    const value = meter?.estimateMessage?.(message)
    if (Number.isSafeInteger(value) && value >= 0) return value
  } catch {
    // Fall through to the local estimate.
  }
  return estimateTokens(message)
}

/**
 * Durably replace one node's content, returning the append pair so callers can
 * assert real progress. `compaction/prune` is appended immediately before the
 * replacement, as its contract requires.
 *
 * @returns `{ seq, replacementSeq, savedChars, price }`, or `null` when the
 *   append was refused (the node is no longer a valid single-node rewrite target).
 */
export function rewriteNodeContent(session, node, content, { meter, label }) {
  const event = session.eventAt(node.seq)
  if (event === null || event === undefined) return null
  const message = session.deriveEventMessage(event)
  if (message === null || message === undefined) return null
  if (!REWRITABLE.has(event.type)) return null

  const price = priceOf(meter, message)
  const before = charCount(message.content)
  const after = charCount(content)

  try {
    session.append('compaction/prune', {
      shadowedRange: { start: node.seq, end: node.seq },
      shadowedSeqs: [node.seq],
      shadowedTokenCount: price,
    })
    const data = event.type === 'tool/result'
      ? { ...event.data, message: withoutUndefined({ ...message, content }) }
      : withoutUndefined({ ...message, content })
    const replacement = session.append(event.type, data, {
      surfaceOp: { op: 'replace', startSeq: node.seq, endSeq: node.seq },
      sourceEventSeqs: [node.seq],
    })
    return { seq: node.seq, replacementSeq: replacement?.seq, savedChars: before - after, price, label }
  } catch (error) {
    return { error }
  }
}

/** Candidate nodes for `prune`, largest first, excluding node 0. */
export function pruneCandidates(inspection, cfg) {
  const { prune } = cfg
  return inspection.oversized
    .filter((node) => node.rewritable && node.chars > prune.thresholdChars)
    .filter((node) => (node.type === 'tool/result' ? true : prune.includeUserMessages))
    .slice(0, prune.maxNodes)
}

/**
 * Candidate nodes for `elide`: the oldest rewritable nodes outside the retained
 * tail and outside node 0, largest-oldest first. Only applied once the surface
 * carries enough text to be worth shedding.
 */
export function elideCandidates(inspection, cfg) {
  const { elide } = cfg
  const nodes = inspection.nodes
  if (nodes.length === 0) return []
  if (inspection.totalChars < elide.minTotalChars) return []

  const protectFrom = Math.max(0, nodes.length - elide.keepRecentNodes)
  const eligible = []
  for (let index = 0; index < protectFrom; index += 1) {
    const node = nodes[index]
    if (index === 0) continue
    if (!node.rewritable) continue
    if (node.chars < elide.minChars) continue
    if (node.type !== 'tool/result' && !elide.includeUserMessages) continue
    eligible.push(node)
  }
  // Oldest first: the earliest context is the least likely to still matter.
  return eligible.slice(0, elide.maxNodes)
}

/** Render a node as one log line. */
export function formatNode(node) {
  const kinds = Object.entries(node.kinds)
    .map(([kind, count]) => `${kind}x${count}`)
    .join(',')
  return `seq=${node.seq} ${node.type} chars=${node.chars} [${kinds}]${
    node.toolName === undefined ? '' : ` tool=${node.toolName}`
  } ${JSON.stringify(truncateText(node.preview, 80))}`
}
