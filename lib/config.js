/**
 * Configuration resolution for the commandcode 400 recovery plugin.
 *
 * The plugin ships no schemastery `Config` export on purpose: `apply()` receives
 * the raw YAML `config:` value and validates it here, so the package has no
 * runtime dependency on `@deepseek-ai/schemastery` and cannot fail to load
 * because of a peer-version mismatch. Every key is validated and every default
 * is applied explicitly, so a typo is reported instead of silently ignored.
 *
 * @module dsh-retry-for-commandcode/config
 */

import { backoffDelay, compilePatterns, describeError } from './util.js'

/**
 * Default message wording that identifies the failure class this plugin
 * recovers. `LlmFailure.status` is **not** populated on the pi-ai
 * (`openai-responses`) path — the adapter builds `{ message, code }` only — so
 * the HTTP status has to be read back out of the message text. The strings below
 * mirror both the pi-ai classifier's own tests and the exact wording produced by
 * the vendored SDK: `"<provider> API error (<status>): <body>"`.
 */
const DEFAULT_MESSAGE_PATTERNS = Object.freeze([
  'API error \\(4(?:00|13)\\)',
  'invalid[_ ]?request',
  'payload too large',
  'request body too large',
  'length limit exceeded',
])

export const STRATEGIES = Object.freeze(['probe', 'failover', 'prune', 'elide', 'compact', 'ask'])
export const FAILOVER_MODES = Object.freeze(['same-model', 'any'])
export const EXHAUSTED_ACTIONS = Object.freeze(['ask', 'delegate', 'retry'])
export const QUOTA_ACTIONS = Object.freeze(['failover', 'delegate'])

const DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: false,
  providers: Object.freeze([]),
  codes: Object.freeze(['INVALID_REQUEST']),
  statuses: Object.freeze([400, 413]),
  messagePatterns: DEFAULT_MESSAGE_PATTERNS,
  strategies: STRATEGIES,
  maxRecoveriesPerStep: 50,
  maxCycles: 3,
  onExhausted: 'ask',
  onExhaustedFallback: 'retry',
  onQuota: 'failover',
  backoff: Object.freeze({ initialDelayMs: 500, maxDelayMs: 30000, jitterRatio: 0.2 }),
  probeAttempts: 1,
  failover: Object.freeze({
    enabled: true,
    mode: 'same-model',
    autoDiscover: true,
    models: Object.freeze([]),
    exclude: Object.freeze([]),
    maxTargets: 4,
  }),
  prune: Object.freeze({
    thresholdChars: 8192,
    headChars: 2048,
    tailChars: 1024,
    maxNodes: 60,
    includeUserMessages: false,
  }),
  elide: Object.freeze({
    keepRecentNodes: 14,
    minChars: 400,
    headChars: 240,
    maxNodes: 80,
    minTotalChars: 6000,
    includeUserMessages: false,
  }),
  compact: Object.freeze({ enabled: true }),
  ask: Object.freeze({ enabled: true, timeoutMs: 600000 }),
  logDiagnostics: true,
})

class ConfigError extends Error {
  constructor(message) {
    super(`retry-for-commandcode: ${message}`)
    this.name = 'RetryForCommandcodeConfigError'
  }
}

function fail(message) {
  throw new ConfigError(message)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject unknown keys so a misspelled option is loud rather than inert. */
function rejectUnknown(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      fail(`unknown option "${path}${key}" (allowed: ${allowed.join(', ')})`)
    }
  }
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`)
  return value
}

function integer(value, path, fallback, { min = 0 } = {}) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min) {
    fail(`${path} must be an integer >= ${min}`)
  }
  return value
}

function ratio(value, path, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be a number between 0 and 1`)
  }
  return value
}

function stringArray(value, path, fallback) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) fail(`${path} must be an array of strings`)
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) fail(`${path} must contain non-empty strings`)
  }
  return [...value]
}

function enumValue(value, path, allowed, fallback) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) fail(`${path} must be one of: ${allowed.join(', ')}`)
  return value
}

function objectValue(value, path, allowed) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) fail(`${path} must be a mapping`)
  rejectUnknown(value, allowed, `${path}.`)
  return value
}

/**
 * Validate and detach the raw plugin config.
 * @param raw - value supplied by the profile's `config:` mapping.
 * @returns a frozen resolved configuration.
 * @throws {Error} when any supplied value is invalid, naming the exact option.
 */
export function resolveConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(input)) fail('config must be a mapping')

  rejectUnknown(
    input,
    [
      'enabled',
      'dryRun',
      'providers',
      'codes',
      'statuses',
      'messagePatterns',
      'strategies',
      'maxRecoveriesPerStep',
      'maxCycles',
      'onExhausted',
      'onExhaustedFallback',
      'onQuota',
      'backoff',
      'probeAttempts',
      'failover',
      'prune',
      'elide',
      'compact',
      'ask',
      'logDiagnostics',
    ],
    '',
  )

  const messagePatterns = stringArray(input.messagePatterns, 'messagePatterns', DEFAULTS.messagePatterns)
  const compiledPatterns = compilePatterns(messagePatterns, (source, error) => {
    fail(`messagePatterns entry ${JSON.stringify(source)} is not a valid regular expression: ${describeError(error)}`)
  })

  const strategies = stringArray(input.strategies, 'strategies', DEFAULTS.strategies)
  for (const strategy of strategies) {
    if (!STRATEGIES.includes(strategy)) {
      fail(`strategies entry "${strategy}" is unknown (allowed: ${STRATEGIES.join(', ')})`)
    }
  }

  const statuses = input.statuses === undefined ? [...DEFAULTS.statuses] : input.statuses
  if (!Array.isArray(statuses) || statuses.some((entry) => !Number.isInteger(entry))) {
    fail('statuses must be an array of HTTP status integers')
  }

  const backoffRaw = objectValue(input.backoff, 'backoff', ['initialDelayMs', 'maxDelayMs', 'jitterRatio'])
  const backoff = Object.freeze({
    initialDelayMs: integer(backoffRaw.initialDelayMs, 'backoff.initialDelayMs', DEFAULTS.backoff.initialDelayMs, { min: 0 }),
    maxDelayMs: integer(backoffRaw.maxDelayMs, 'backoff.maxDelayMs', DEFAULTS.backoff.maxDelayMs, { min: 0 }),
    jitterRatio: ratio(backoffRaw.jitterRatio, 'backoff.jitterRatio', DEFAULTS.backoff.jitterRatio),
  })
  if (backoff.maxDelayMs < backoff.initialDelayMs) {
    fail('backoff.maxDelayMs must be >= backoff.initialDelayMs')
  }

  const failoverRaw = objectValue(input.failover, 'failover', [
    'enabled',
    'mode',
    'autoDiscover',
    'models',
    'exclude',
    'maxTargets',
  ])
  const failoverModelsRaw = failoverRaw.models === undefined ? [] : failoverRaw.models
  if (!Array.isArray(failoverModelsRaw)) fail('failover.models must be an array')
  const failoverModels = failoverModelsRaw.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`failover.models[${index}] must be a mapping`)
    rejectUnknown(entry, ['provider', 'model'], `failover.models[${index}].`)
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      fail(`failover.models[${index}].provider must be a non-empty string`)
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      fail(`failover.models[${index}].model must be a non-empty string`)
    }
    return Object.freeze({ provider: entry.provider, model: entry.model })
  })
  const failover = Object.freeze({
    enabled: boolean(failoverRaw.enabled, 'failover.enabled', DEFAULTS.failover.enabled),
    mode: enumValue(failoverRaw.mode, 'failover.mode', FAILOVER_MODES, DEFAULTS.failover.mode),
    autoDiscover: boolean(failoverRaw.autoDiscover, 'failover.autoDiscover', DEFAULTS.failover.autoDiscover),
    models: Object.freeze(failoverModels),
    exclude: Object.freeze(stringArray(failoverRaw.exclude, 'failover.exclude', DEFAULTS.failover.exclude)),
    maxTargets: integer(failoverRaw.maxTargets, 'failover.maxTargets', DEFAULTS.failover.maxTargets, { min: 1 }),
  })

  const pruneRaw = objectValue(input.prune, 'prune', [
    'thresholdChars',
    'headChars',
    'tailChars',
    'maxNodes',
    'includeUserMessages',
  ])
  const prune = Object.freeze({
    thresholdChars: integer(pruneRaw.thresholdChars, 'prune.thresholdChars', DEFAULTS.prune.thresholdChars, { min: 1 }),
    headChars: integer(pruneRaw.headChars, 'prune.headChars', DEFAULTS.prune.headChars, { min: 0 }),
    tailChars: integer(pruneRaw.tailChars, 'prune.tailChars', DEFAULTS.prune.tailChars, { min: 0 }),
    maxNodes: integer(pruneRaw.maxNodes, 'prune.maxNodes', DEFAULTS.prune.maxNodes, { min: 1 }),
    includeUserMessages: boolean(
      pruneRaw.includeUserMessages,
      'prune.includeUserMessages',
      DEFAULTS.prune.includeUserMessages,
    ),
  })
  if (prune.headChars + prune.tailChars >= prune.thresholdChars) {
    fail('prune.headChars + prune.tailChars must be less than prune.thresholdChars')
  }

  const elideRaw = objectValue(input.elide, 'elide', [
    'keepRecentNodes',
    'minChars',
    'headChars',
    'maxNodes',
    'minTotalChars',
    'includeUserMessages',
  ])
  const elide = Object.freeze({
    keepRecentNodes: integer(elideRaw.keepRecentNodes, 'elide.keepRecentNodes', DEFAULTS.elide.keepRecentNodes, { min: 0 }),
    minChars: integer(elideRaw.minChars, 'elide.minChars', DEFAULTS.elide.minChars, { min: 0 }),
    headChars: integer(elideRaw.headChars, 'elide.headChars', DEFAULTS.elide.headChars, { min: 0 }),
    maxNodes: integer(elideRaw.maxNodes, 'elide.maxNodes', DEFAULTS.elide.maxNodes, { min: 1 }),
    minTotalChars: integer(elideRaw.minTotalChars, 'elide.minTotalChars', DEFAULTS.elide.minTotalChars, { min: 0 }),
    includeUserMessages: boolean(
      elideRaw.includeUserMessages,
      'elide.includeUserMessages',
      DEFAULTS.elide.includeUserMessages,
    ),
  })

  const compactRaw = objectValue(input.compact, 'compact', ['enabled'])
  const askRaw = objectValue(input.ask, 'ask', ['enabled', 'timeoutMs'])

  return Object.freeze({
    enabled: boolean(input.enabled, 'enabled', DEFAULTS.enabled),
    dryRun: boolean(input.dryRun, 'dryRun', DEFAULTS.dryRun),
    providers: Object.freeze(stringArray(input.providers, 'providers', DEFAULTS.providers)),
    codes: Object.freeze(stringArray(input.codes, 'codes', DEFAULTS.codes)),
    statuses: Object.freeze([...statuses]),
    messagePatterns: Object.freeze(messagePatterns),
    compiledPatterns: Object.freeze(compiledPatterns),
    strategies: Object.freeze(strategies),
    maxRecoveriesPerStep: integer(input.maxRecoveriesPerStep, 'maxRecoveriesPerStep', DEFAULTS.maxRecoveriesPerStep, {
      min: 1,
    }),
    maxCycles: integer(input.maxCycles, 'maxCycles', DEFAULTS.maxCycles, { min: 1 }),
    onExhausted: enumValue(input.onExhausted, 'onExhausted', EXHAUSTED_ACTIONS, DEFAULTS.onExhausted),
    onExhaustedFallback: enumValue(
      input.onExhaustedFallback,
      'onExhaustedFallback',
      ['delegate', 'retry'],
      DEFAULTS.onExhaustedFallback,
    ),
    onQuota: enumValue(input.onQuota, 'onQuota', QUOTA_ACTIONS, DEFAULTS.onQuota),
    backoff,
    probeAttempts: integer(input.probeAttempts, 'probeAttempts', DEFAULTS.probeAttempts, { min: 0 }),
    failover,
    prune,
    elide,
    compact: Object.freeze({
      enabled: boolean(compactRaw.enabled, 'compact.enabled', DEFAULTS.compact.enabled),
    }),
    ask: Object.freeze({
      enabled: boolean(askRaw.enabled, 'ask.enabled', DEFAULTS.ask.enabled),
      timeoutMs: integer(askRaw.timeoutMs, 'ask.timeoutMs', DEFAULTS.ask.timeoutMs, { min: 1 }),
    }),
    logDiagnostics: boolean(input.logDiagnostics, 'logDiagnostics', DEFAULTS.logDiagnostics),
  })
}

/** Backoff for one recovery attempt, exposed for tests and the ladder. */
export function delayForAttempt(cfg, attempt, random) {
  return backoffDelay(attempt, cfg.backoff, random)
}
