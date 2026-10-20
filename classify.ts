/**
 * Transient-failure classification for provider errors.
 *
 * Mirrors OpenCode's own `isRetryable` (packages/ai/src/provider-error.ts) and
 * `toSessionError` type mapping, plus body/status heuristics for providers whose
 * failures arrive in under-classified shapes. Anything not clearly transient is
 * left alone: retrying deterministic rejections wastes attempts and money.
 */

/** The `SessionError.Error` shape carried by retry hooks and session events. */
export interface ProviderError {
  readonly type: string
  readonly message: string
  readonly status?: number
  readonly response?: { readonly body?: string }
}

/** Session error types OpenCode classifies as retryable by default. */
const RETRYABLE_TYPES = new Set([
  "provider.rate-limit",
  "provider.internal",
  "provider.transport",
  "provider.unknown",
  "provider.invalid-output",
])

/**
 * Deterministic rejections that retrying the identical request cannot fix.
 * `provider.timeout` is deliberately excluded from the retryable set: OpenCode
 * already gives timeouts up to 3 attempts and a timed-out request may have been
 * processed. Add it via `retryTypes` if your provider timeouts are clearly safe
 * to repeat.
 */
const TERMINAL_TYPES = new Set([
  "provider.auth",
  "provider.quota",
  "provider.content-filter",
  "provider.invalid-request",
  "provider.no-route",
  "provider.unsupported-operation",
  "provider.timeout",
  "permission.rejected",
  "tool.execution",
  "output-limit",
  "compaction.failed",
  "aborted",
])

const isTransientStatus = (status: number | undefined) =>
  status !== undefined && (status === 429 || status === 408 || status === 409 || status >= 500)

/** Substring signals that classify otherwise-unknown errors as transient. */
const TRANSIENT_PATTERNS = [
  /rate[-_\s]?limit/i,
  /rate_limit_error/i,
  /too[_\s]?many[_\s]?requests/i,
  /overloaded/i,
  /overload/i,
  /try again/i,
  /retry (?:the |this |your )?request/i,
  /temporarily (?:unavailable|at capacity)/i,
  /service[-_\s]?unavailable/i,
  /server (?:is )?busy/i,
  /internal(?: server)? error/i,
  /upstream (?:connect|connection|request)/i,
  /resource[-_\s]?exhausted/i,
  /connection reset/i,
  /network request failed/i,
  /failed to fetch/i,
  /socket hang up/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /epipe/i,
]

export interface ClassifierOptions {
  /** Extra error types to treat as transient (e.g. ["provider.timeout"]). */
  readonly retryTypes?: string[]
  /** Extra error types to treat as terminal and never retry. */
  readonly ignoreTypes?: string[]
  /** Substrings (case-insensitive) that force a retry decision. */
  readonly retryPatterns?: string[]
  /** Substrings (case-insensitive) that force a terminal decision. */
  readonly ignorePatterns?: string[]
}

export function shouldRetry(error: ProviderError, options: ClassifierOptions = {}): boolean {
  const text = [error.message, error.response?.body].filter(Boolean).join("\n").toLowerCase()

  // Explicit overrides win over everything.
  if (options.retryTypes?.includes(error.type)) return true
  if (options.ignoreTypes?.includes(error.type)) return false
  if (options.retryPatterns?.some((p) => text.includes(p.toLowerCase()))) return true
  if (options.ignorePatterns?.some((p) => text.includes(p.toLowerCase()))) return false

  // A rate-limit / slow-down status is transient regardless of how the failure
  // was classified. Providers such as SenseTime return quota-ish 429 codes that
  // OpenCode maps to `provider.quota`; retrying with backoff is still correct
  // because the limit is time-based and recovers.
  if (isTransientStatus(error.status)) return true

  // Deterministic rejections: do not burn attempts (401 auth, 400 invalid
  // request, 402 quota without a 429, content-filter, permission, ...).
  if (TERMINAL_TYPES.has(error.type)) return false

  // Any other 4xx is a deterministic client rejection, even when the failure
  // was not classified (OpenCode maps these to InvalidRequest).
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return false

  // OpenCode's retryable set (RateLimit, ProviderInternal, Transport,
  // incomplete output, and unknown/unrecognized failures).
  if (RETRYABLE_TYPES.has(error.type)) return true

  // Body/message heuristics for unclassified failures.
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) return true

  // Conservative default.
  return false
}
