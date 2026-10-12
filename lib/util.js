/**
 * Dependency-free helpers shared by the recovery plugin.
 *
 * The plugin deliberately imports nothing from `@deepseek-ai/*`: it observes and
 * mutates the live runtime objects handed to it by cordis, so it keeps working
 * whether the profile installs it as a copied package or as a `link:` to a
 * working tree (a linked package resolves `node_modules` from its real path, not
 * from the profile, so bare `@deepseek-ai/*` specifiers would not resolve).
 *
 * @module dsh-retry-for-commandcode/util
 */

/** Substituted for content the plugin removes from a model-visible message. */
export const PRUNE_MARKER = '\n\n[... elided by dsh-retry-for-commandcode ...]\n\n'

/** Render any thrown value as a single log-safe line. */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Whether a value is a non-empty string. */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Wait for a delay, resolving `true` when it elapsed and `false` when the
 * supplied signal aborted first. Mirrors the cancellable-wait contract the
 * shipped retry executor uses, so an aborted turn never leaves a live timer.
 */
export function sleep(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  if (!(delayMs > 0)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Bounded exponential backoff with symmetric jitter.
 * @param attempt - 1-based attempt number inside the recovery ladder.
 * @param backoff - resolved `{ initialDelayMs, maxDelayMs, jitterRatio }`.
 * @param random - injectable sample in [0,1) for deterministic tests.
 */
export function backoffDelay(attempt, backoff, random = Math.random) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 1024)
  const exponential = Math.min(backoff.initialDelayMs * 2 ** exponent, backoff.maxDelayMs)
  const jitter = 1 - backoff.jitterRatio + 2 * backoff.jitterRatio * random()
  return Math.max(0, Math.min(exponential * jitter, backoff.maxDelayMs))
}

/** The text blocks of a content array, tolerating a malformed value. */
export function textBlocks(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
}

/** Total Unicode code points across a content array's text blocks. */
export function charCount(content) {
  let total = 0
  for (const block of textBlocks(content)) {
    if (typeof block.text === 'string') total += Array.from(block.text).length
  }
  return total
}

/** How many blocks of each non-text kind a content array carries. */
export function blockKindCounts(content) {
  const counts = {}
  if (!Array.isArray(content)) return counts
  for (const block of content) {
    const kind = block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : 'unknown'
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

/** Truncate to `max` Unicode code points, appending an ellipsis when cut. */
export function truncateText(text, max) {
  if (typeof text !== 'string') return ''
  const points = Array.from(text)
  if (points.length <= max) return text
  if (max <= 1) return '…'
  return `${points.slice(0, max - 1).join('')}…`
}

/** First `max` code points of a text block's content, whitespace-collapsed. */
export function previewOf(content, max = 160) {
  const parts = []
  for (const block of textBlocks(content)) {
    if (typeof block.text === 'string') parts.push(block.text)
    if (parts.join('').length > max * 4) break
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  return truncateText(joined, max)
}

/**
 * Cheap provider-neutral token estimate. Used only for diagnostics and for
 * ranking nodes to repair; the authoritative figure is `ctx.tokenMeter.measure`.
 */
export function estimateTokens(value) {
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    return 0
  }
  return Math.ceil((json?.length ?? 0) / 4)
}

/** Compile config-supplied regex sources, dropping invalid entries. */
export function compilePatterns(sources, onInvalid) {
  const compiled = []
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'i'))
    } catch (error) {
      onInvalid?.(source, error)
    }
  }
  return compiled
}

/** Whether any compiled pattern matches the text. */
export function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text))
}

/** A fresh opaque identity for message-shaped values this plugin mints. */
export function newOpaqueId() {
  return globalThis.crypto?.randomUUID?.() ?? `cc-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * `session.append`'s data argument must be losslessly JSON-serializable. Live
 * message objects can carry frozen branded values, which serialize fine, but a
 * `undefined` nested value would reject the append. Drop `undefined` keys
 * without otherwise touching the value.
 */
export function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map((entry) => withoutUndefined(entry))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = withoutUndefined(entry)
  }
  return out
}
