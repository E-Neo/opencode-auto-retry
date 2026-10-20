/**
 * Exponential backoff with jitter. `attempt` is 1-based: the first retry uses
 * `baseDelayMs`, the second `baseDelayMs * factor`, and so on, capped at
 * `maxDelayMs` before jitter is applied.
 */

export interface BackoffConfig {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
  readonly jitter: number // 0..1, applied as +/- percentage around the delay
}

export function backoffDelay(attempt: number, config: BackoffConfig): number {
  const base = config.baseDelayMs * Math.pow(config.factor, Math.max(0, attempt - 1))
  const capped = Math.min(base, config.maxDelayMs)
  const jittered = config.jitter > 0 ? capped * (1 + (Math.random() * 2 - 1) * config.jitter) : capped
  return Math.max(0, Math.round(jittered))
}

/** OpenCode's proposed retry decision as seen by the `retry` hook. */
export interface RetryDecision {
  readonly retry: boolean
  readonly delay?: number
}

/**
 * The plugin may extend OpenCode's retry delay but never shorten it: OpenCode's
 * computed delay already honors the provider's `Retry-After` (capped at 15 min),
 * so overriding it wholesale made the plugin retry rate-limited providers too
 * eagerly. When OpenCode refuses a retry (`{ retry: false }`), the plugin's own
 * backoff applies.
 */
export function resolveRetryDelay(attempt: number, openCodeDecision: RetryDecision, config: BackoffConfig): number {
  const proposed = backoffDelay(attempt, config)
  const openCodeDelay =
    openCodeDecision.retry &&
    typeof openCodeDecision.delay === "number" &&
    Number.isFinite(openCodeDecision.delay) &&
    openCodeDecision.delay > 0
      ? openCodeDecision.delay
      : 0
  return Math.max(proposed, openCodeDelay)
}
