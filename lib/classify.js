/**
 * Failure classification: decide whether one `agent/request-error` payload is the
 * class this plugin owns.
 *
 * Why the shape below and not `failure.status === 400`:
 * `dsh-llm-pi-ai` builds its `LlmFailure` as exactly `{ message, code }`
 * (`case "error"` in its `mapStopReason`), so `status`, `requestId`,
 * `providerRetryAfterMs` and `offloadImages` are all `undefined` on the
 * `openai-responses` path — including for the `hh-commandcode*` routes this
 * plugin exists for. The HTTP status therefore has to be recovered from the
 * message text, which the vendored SDK formats as
 * `"<provider> API error (<status>): <body>"`. The status is parsed back out so
 * the diagnosis can still report it.
 *
 * @module dsh-retry-for-commandcode/classify
 */

import { matchesAny } from './util.js'

/** `hh-commandcode API error (400): {...}` — the SDK's exact framing. */
const MESSAGE_STATUS = /API error \((\d{3})\)/

/** Whether a provider selector matches the failing route. `''`/`[]` means any. */
export function providerMatches(selectors, provider) {
  if (selectors.length === 0) return true
  const name = typeof provider === 'string' ? provider : ''
  return selectors.some((selector) => {
    if (selector === '*' || selector === '') return true
    if (selector.endsWith('*')) return name.startsWith(selector.slice(0, -1))
    return name === selector
  })
}

/**
 * Recover the HTTP status the provider returned. Prefers the numeric
 * `LlmFailure.status` when some other adapter populated it, then the status
 * embedded in the message, then the status naming a known code.
 * @returns the status, or `undefined` when it cannot be determined.
 */
export function statusOf(failure) {
  if (Number.isInteger(failure?.status)) return failure.status
  const match = MESSAGE_STATUS.exec(String(failure?.message ?? ''))
  if (match !== null) return Number.parseInt(match[1], 10)
  return undefined
}

/**
 * The provider's own error `type`/`code` fields, when the body survived inside
 * the message. The body is JSON-stringified into the message, so it is parsed
 * back out for diagnostics; a failure to parse is not an error.
 * @returns `{ type, code, traceId, innerMessage }`, each possibly undefined.
 */
export function providerErrorFields(failure) {
  const text = String(failure?.message ?? '')
  const start = text.indexOf('{')
  if (start < 0) return {}
  let body
  try {
    body = JSON.parse(text.slice(start))
  } catch {
    return {}
  }
  if (body === null || typeof body !== 'object') return {}
  // The commandcode body nests a JSON string under `message`:
  //   {"message":"{\"type\":\"invalid_request_error\",...}","type":"invalid_request_error"}
  let inner = body
  if (typeof body.message === 'string' && body.message.trim().startsWith('{')) {
    try {
      inner = JSON.parse(body.message)
    } catch {
      inner = body
    }
  }
  const traceId = /trace_id:\s*([0-9a-f]+)/i.exec(String(inner?.message ?? body.message ?? ''))?.[1]
  return {
    type: typeof body.type === 'string' ? body.type : typeof inner?.type === 'string' ? inner.type : undefined,
    code: typeof body.code === 'string' && body.code.length > 0
      ? body.code
      : typeof inner?.code === 'string' && inner.code.length > 0
        ? inner.code
        : undefined,
    traceId,
    innerMessage: typeof inner?.message === 'string' ? inner.message : undefined,
  }
}

/**
 * Decide whether this payload is the failure class the plugin recovers.
 *
 * Matching is deliberately conjunctive on the provider, the code, and the
 * message wording: a bare `INVALID_REQUEST` from an unrelated route is left to
 * the shipped policies, so installing this plugin cannot change behaviour for
 * providers it was not configured for.
 *
 * @param failure - `payload.failure`.
 * @param provider - `payload.provider`, the route that served the failed request.
 * @param cfg - resolved plugin configuration.
 * @returns `{ matched, code, status, patterns, provider, reason }`.
 */
export function classifyFailure(failure, provider, cfg) {
  const text = String(failure?.message ?? '')
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const status = statusOf(failure)
  const providerOk = providerMatches(cfg.providers, provider)
  const codeOk = cfg.codes.includes(code)
  const statusOk = status !== undefined && cfg.statuses.includes(status)
  const patternOk = cfg.compiledPatterns.length === 0 ? true : matchesAny(text, cfg.compiledPatterns)

  const matched = providerOk && (codeOk || statusOk) && patternOk
  let reason
  if (matched) reason = 'provider+code+message agree'
  else if (!providerOk) reason = `provider "${provider}" is outside providers ${JSON.stringify(cfg.providers)}`
  else if (!patternOk) reason = 'message does not match any messagePatterns entry'
  else if (!codeOk && !statusOk) reason = `code "${code}" and status ${String(status)} are both unconfigured`
  else reason = 'unclassified'

  return { matched, code, status, provider, reason }
}
