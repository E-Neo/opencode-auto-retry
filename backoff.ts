/**
 * L1 — backoff. The only place the plugin waits between request attempts.
 *
 * `attempt` is 1-based: the first retry waits `startMs`, the second
 * `startMs * factor`, and so on, capped at `maxMs` before jitter.
 */

export interface BackoffConfig {
  readonly startMs: number
  readonly maxMs: number
  readonly factor: number
  readonly jitter: number // 0..1, applied as +/- percentage around the delay
}

export function backoffDelay(attempt: number, config: BackoffConfig): number {
  const base = config.startMs * Math.pow(config.factor, Math.max(0, attempt - 1))
  const capped = Math.min(base, config.maxMs)
  const jittered = config.jitter > 0 ? capped * (1 + (Math.random() * 2 - 1) * config.jitter) : capped
  return Math.max(0, Math.round(jittered))
}

/** OpenCode's proposed retry decision as seen by the `retry` hook. */
export interface RetryDecision {
  readonly retry: boolean
  readonly delay?: number
}

/**
 * Never retry sooner than OpenCode would: its computed delay already honors the
 * provider's `Retry-After`, so the plugin's backoff acts as a floor, never a
 * shortcut.
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
