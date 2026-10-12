/**
 * Diagnosis: explain what the provider rejected and what the previous step did.
 *
 * Nothing here is model-visible — the rendered lines go to the DSH process log
 * and (when the `ask` strategy runs) to the user. That is deliberate: a plugin
 * event type of this plugin's own would make `dsh-session-persistence` refuse to
 * resume the session, because `session.append` cannot set the `ignorable`
 * envelope marker an out-of-tree event would need.
 *
 * @module dsh-retry-for-commandcode/diagnose
 */

import { providerErrorFields } from './classify.js'
import { describeRequestComposition, formatNode, inspectSurface, resolveService } from './surface.js'
import { describeError, truncateText } from './util.js'

/** Ranked guesses at why the provider rejected this request. */
function guessCauses({ failure, inspection, providerFields, cfg, composition }) {
  const causes = []
  const text = `${providerFields?.innerMessage ?? ''} ${failure?.message ?? ''}`.toLowerCase()

  if (/non-?empty|empty (?:text|content)|must not be empty/.test(text)) {
    causes.push({
      confidence: 'high',
      cause: 'a content block is empty — the provider rejects empty text blocks',
      remedy: 'prune/elide rebuilds affected content with a non-empty placeholder',
    })
  }
  if (/tool[_ ]?(?:use|call)|tool_result|function_call/.test(text)) {
    causes.push({
      confidence: 'high',
      cause: 'a tool call and its result are not correctly paired in the outgoing request',
      remedy: 'prune/elide keep node topology intact, so pairing is preserved; failover may also help',
    })
  }
  if (/too (?:large|long)|exceed|maximum|context length|token/.test(text)) {
    causes.push({
      confidence: 'high',
      cause: 'the request exceeds a provider-side size or context limit',
      remedy: 'prune then elide then compact, in that order, shrink the request',
    })
  }
  if (/image|vision|modality|unsupported content/.test(text)) {
    causes.push({
      confidence: 'medium',
      cause: 'the request carries content this route cannot accept (typically non-text blocks)',
      remedy: 'failover to a route that declares the modality, or let dsh-compaction-image-offload run',
    })
  }

  // The structural limit. `prune`/`elide` only rewrite `tool/result` and
  // `user/message` nodes; everything inside an assistant message is out of
  // reach, because a surface replacement must cite `sourceEventSeqs` for every
  // shadowed node and `assistant/message` is forbidden from carrying them. When
  // most of the request lives there, the ladder can prune diligently and still
  // be rejected — so name that instead of recommending another prune.
  if (
    composition !== null &&
    composition.untouchablePercent >= 50 &&
    composition.untouchableBytes > cfg.prune.thresholdChars
  ) {
    causes.push({
      confidence: composition.untouchablePercent >= 70 ? 'high' : 'medium',
      cause:
        `${composition.untouchablePercent}% of the outgoing request (${formatBytes(composition.untouchableBytes)} ` +
        `of ${formatBytes(composition.totalBytes)}, ~${composition.estimatedTokens} tokens) is inside assistant ` +
        'messages, which this plugin is structurally unable to rewrite',
      remedy:
        'prune/elide only reach tool results and user messages; shedding the assistant span needs compact ' +
        '(or a lower compaction trigger)',
    })
  }

  const prune = cfg.prune.thresholdChars
  const oversized = inspection?.oversized?.filter((node) => node.chars > prune) ?? []
  if (oversized.length > 0) {
    const biggest = oversized[0]
    causes.push({
      confidence: 'medium',
      cause: `${oversized.length} surface node(s) exceed ${prune} chars (largest: seq ${biggest.seq} ${biggest.type} at ${biggest.chars} chars)`,
      remedy: 'prune trims oversized text to a head/tail window',
    })
  }

  const lastStep = inspection?.lastStep
  if (lastStep !== null && lastStep !== undefined && lastStep.toolResultChars > prune) {
    causes.push({
      confidence: 'medium',
      cause: `the immediately preceding step returned ${lastStep.toolResultChars} chars of tool output across ${lastStep.toolResults.length} result(s)`,
      remedy: 'prune targets exactly those results first',
    })
  }

  if ((inspection?.nodeCount ?? 0) > 60) {
    causes.push({
      confidence: 'low',
      cause: `the history is long (${inspection.nodeCount} surface nodes, ~${inspection.estimatedTokens} tokens)`,
      remedy: 'elide then compact reduce the span the request is built from',
    })
  }

  if (causes.length === 0) {
    causes.push({
      confidence: 'low',
      cause: 'the request looks small and structurally ordinary, so the rejection may be provider-side or transient',
      remedy: 'probe retries unchanged first, then failover moves the request to another route',
    })
  }
  return causes
}

/**
 * Build the full diagnosis for one failed attempt.
 * @returns a serializable record, also used verbatim in the `ask` strategy.
 */
export function diagnose({ ctx, cfg, agent, provider, failure, verdict, turn, step, attempt, cycle, strategyHistory }) {
  const providerFields = providerErrorFields(failure)
  const session = agent?.session

  let inspection = null
  let inspectionError
  try {
    inspection = inspectSurface(session, { topN: 5 })
  } catch (error) {
    inspectionError = describeError(error)
  }

  let measured
  const meter = resolveService(ctx, agent, 'tokenMeter')
  try {
    const measurement = meter?.measure?.(session)
    if (measurement !== undefined && measurement !== null) {
      measured = {
        totalTokens: measurement.totalTokens,
        surfaceTokens: measurement.surfaceTokens,
        logRevision: measurement.logRevision,
      }
    }
  } catch {
    // Measurement is best-effort diagnostics only.
  }

  let composition = null
  try {
    composition = describeRequestComposition(session)
  } catch {
    // Composition is best-effort diagnostics only.
  }

  const options = agent?.options ?? {}
  const diagnosis = {
    provider,
    model: typeof options.model === 'string' ? options.model : undefined,
    turn,
    step,
    attempt,
    cycle,
    code: verdict?.code ?? failure?.code,
    status: verdict?.status,
    matchReason: verdict?.reason,
    providerErrorType: providerFields?.type,
    providerErrorCode: providerFields?.code,
    traceId: providerFields?.traceId,
    providerMessage: truncateText(providerFields?.innerMessage ?? failure?.message ?? '', 500),
    rawFailureMessage: truncateText(failure?.message ?? '', 1000),
    sessionId: safeSessionId(session),
    isSubagent: isSubagent(agent),
    inspection: inspection === null
      ? { error: inspectionError }
      : {
        nodeCount: inspection.nodeCount,
        totalChars: inspection.totalChars,
        estimatedTokens: inspection.estimatedTokens,
        measured,
        largest: inspection.largest.map(formatNode),
        lastStep: inspection.lastStep,
      },
    composition,
    strategyHistory,
  }
  diagnosis.suspectedCauses = guessCauses({ failure, inspection, providerFields, cfg, composition })
  return diagnosis
}

function safeSessionId(session) {
  try {
    const id = session?.id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the failing agent is a delegated child rather than the runtime root.
 * Subagents have no human answerer, so the `ask` strategy must not block on one.
 */
function isSubagent(agent) {
  try {
    const parent = agent?.session?.header?.parentSession
    if (parent !== undefined && parent !== null) return true
    const depth = agent?.session?.meta?.delegationDepth
    return Number.isInteger(depth) && depth > 0
  } catch {
    return false
  }
}

/** Render a diagnosis as indented log lines. */
export function renderDiagnosis(diagnosis) {
  const lines = []
  const headline =
    `provider=${diagnosis.provider} model=${diagnosis.model ?? '?'} code=${diagnosis.code}` +
    `${diagnosis.status === undefined ? '' : ` status=${diagnosis.status}`}` +
    ` turn=${diagnosis.turn} step=${diagnosis.step} attempt=${diagnosis.attempt}/${diagnosis.cycle}` +
    `${diagnosis.isSubagent ? ' agent=subagent' : ''}`
  lines.push(headline)

  const providerBits = []
  if (diagnosis.providerErrorType !== undefined) providerBits.push(`type=${diagnosis.providerErrorType}`)
  if (diagnosis.providerErrorCode !== undefined) providerBits.push(`code=${diagnosis.providerErrorCode}`)
  if (diagnosis.traceId !== undefined) providerBits.push(`trace_id=${diagnosis.traceId}`)
  if (providerBits.length > 0) lines.push(`  provider-error: ${providerBits.join(' ')}`)
  if (diagnosis.providerMessage !== undefined && diagnosis.providerMessage.length > 0) {
    lines.push(`  provider-message: ${JSON.stringify(diagnosis.providerMessage)}`)
  }
  if (diagnosis.matchReason !== undefined) lines.push(`  matched-because: ${diagnosis.matchReason}`)

  const inspection = diagnosis.inspection ?? {}
  if (inspection.error !== undefined) {
    lines.push(`  history: unavailable (${inspection.error})`)
  } else {
    lines.push(
      `  history: ${inspection.nodeCount} surface nodes, ${inspection.totalChars} chars (~${inspection.estimatedTokens} tokens)` +
        `${inspection.measured === undefined ? '' : `, tokenMeter=${inspection.measured.totalTokens}`}`,
    )
    for (const node of inspection.largest ?? []) lines.push(`    largest ${node}`)
  }

  const composition = diagnosis.composition
  if (composition !== null && composition !== undefined) {
    lines.push(
      `  request: ${composition.messages} messages, ${formatBytes(composition.totalBytes)} ` +
        `(~${composition.estimatedTokens} tokens), untouchable ${composition.untouchablePercent}% ` +
        `(${formatBytes(composition.untouchableBytes)})`,
    )
    for (const [role, bytes] of composition.byRole.slice(0, 3)) {
      lines.push(`    role ${role}: ${formatBytes(bytes)}`)
    }
    for (const [kind, bytes] of composition.byBlock.slice(0, 3)) {
      lines.push(`    block ${kind}: ${formatBytes(bytes)}`)
    }
    if (composition.largest !== undefined && composition.largest !== null) {
      const largest = composition.largest
      lines.push(
        `    largest message: ${formatBytes(largest.bytes)} role=${largest.role} ` +
          `id=${largest.id ?? '?'} [${largest.kinds}]`,
      )
    }
  }

  const lastStep = inspection.lastStep
  if (lastStep !== null && lastStep !== undefined) {
    lines.push(
      `  previous-step: assistant#${lastStep.assistantIndex} of ${lastStep.totalMessages} messages, ` +
        `${lastStep.toolCalls.length} tool call(s), ${lastStep.toolResultChars} result chars`,
    )
    if (lastStep.assistantText.length > 0) {
      lines.push(`    assistant-said: ${JSON.stringify(truncateText(lastStep.assistantText, 160))}`)
    }
    for (const call of lastStep.toolCalls) {
      lines.push(`    called ${call.name ?? '?'} (args ${call.argumentChars} chars)`)
    }
    for (const result of lastStep.toolResults) {
      lines.push(`    result ${result.chars} chars${result.isError ? ' (ERROR)' : ''} ${JSON.stringify(truncateText(result.preview, 80))}`)
    }
  }

  lines.push('  suspected-causes:')
  for (const guess of diagnosis.suspectedCauses ?? []) {
    lines.push(`    [${guess.confidence}] ${guess.cause}`)
    lines.push(`        remedy: ${guess.remedy}`)
  }
  return lines
}

/** One-line summary used in recovery logging. */
export function summarizeDiagnosis(diagnosis) {
  const causes = diagnosis.suspectedCauses ?? []
  const top = causes[0]
  return (
    `${diagnosis.provider}/${diagnosis.model ?? '?'} ${diagnosis.code}` +
    `${top === undefined ? '' : ` — ${top.cause}`}`
  )
}

/**
 * Render a byte count compactly. Request sizes are the point of the composition
 * report, and `1093000 bytes` is far harder to read at a glance than `1.0 MB`.
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
