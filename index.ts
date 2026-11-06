/**
 * opencode-auto-retry
 *
 * Three mechanisms, one per level:
 *
 *   backoff — wait between request attempts (OpenCode retries; the plugin
 *             only tunes the delays and never shortens `Retry-After`).
 *   resume  — when a turn finally fails, post a "continue" message that starts
 *             a fresh turn. Repeat for `resume.withinMs`.
 *   pause   — when the resume window is over, wait `pause.forMs`, then start a
 *             new window. Stop after `pause.untilMs` since the first failure.
 *
 * All state is in memory: a restart starts every session from zero. The plugin
 * writes no config, no storage, and no OpenCode state — apart from the synthetic
 * "continue" message, which is the only way to resume a failed turn.
 *
 * Behavior is configured by editing DEFAULTS below; there is no config file.
 */

import { Plugin } from "@opencode/plugin"
import { shouldRetry, type ProviderError } from "./classify.js"
import { resolveRetryDelay } from "./backoff.js"
import { decidePhase, RetryStates } from "./state.js"

const DEFAULTS = {
  /** OpenCode's real per-turn attempt limit (recurs(10) + initial = 11). */
  openCodeMaxAttempts: 11,

  /** L1 — wait between request attempts. */
  backoff: {
    startMs: 2_000,
    maxMs: 30_000,
    factor: 2,
    jitter: 0.2,
    handoffAtMaxAttempts: true,
  },

  /** L2 — keep resuming the failed turn. */
  resume: {
    withinMs: 1_800_000, // 30 minutes
  },

  /** L3 — pause, then resume again. */
  pause: {
    forMs: 1_800_000, // 30 minutes
    untilMs: 28_800_000, // 8 hours since the first failure
  },
} as const

const log = (message: string) => console.error(`[auto-retry] ${message}`)

export default Plugin.define({
  id: "auto-retry",
  async setup(ctx) {
    const states = new RetryStates()

    // -------------------------------------------------------------------------
    // L1 — backoff: tune OpenCode's per-attempt retry delay.
    // -------------------------------------------------------------------------

    const retryHook = (event: {
      readonly sessionID: string
      readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
      readonly error: ProviderError
      readonly attempt: number
      decision: { retry: boolean; delay?: number }
    }) => {
      if (!shouldRetry(event.error)) {
        event.decision = { retry: false }
        log(`backoff: not retryable (${event.error.type} ${event.error.status ?? ""})`.trim())
        return
      }
      if (event.attempt >= DEFAULTS.openCodeMaxAttempts && DEFAULTS.backoff.handoffAtMaxAttempts) {
        // Hand the turn over to resume instead of running the final attempt.
        event.decision = { retry: false }
        log(`backoff: handing off at attempt ${event.attempt}`)
        return
      }
      const delay = resolveRetryDelay(event.attempt, event.decision, DEFAULTS.backoff)
      event.decision = { retry: true, delay }
      log(`backoff: attempt ${event.attempt} in ${delay}ms (${event.error.type})`)
    }

    await ctx.session.hook("retry", retryHook)

    // A real user prompt starts a clean slate (synthetic and shell messages do
    // not run the prompt hook, so our own resumes never reset the state).
    await ctx.session.hook("prompt", (event: { readonly sessionID: string }) => {
      states.reset(event.sessionID)
    })

    // -------------------------------------------------------------------------
    // L2 — resume: post a "continue" message to start a fresh turn.
    // -------------------------------------------------------------------------

    const resumeTurn = async (sessionID: string, error: ProviderError): Promise<void> => {
      const state = states.get(sessionID)
      if (state.interrupted || state.resuming) return
      state.resuming = true
      try {
        // Wait for the failed turn to settle before waking the session.
        await ctx.session.wait({ sessionID })
        // A new user prompt replaces the state; do not interleave with it.
        if (states.get(sessionID) !== state) return

        const status = error.status !== undefined ? ` (HTTP ${error.status})` : ""
        await ctx.session.synthetic({
          sessionID,
          text: `⟳ Resuming the turn after provider error: ${error.type}${status}. Ignore the transient error above and continue with your previous request.`,
          description: "auto-retry resume",
          metadata: { source: "auto-retry", phase: "resume", error: error.type, status: error.status ?? null },
          resume: true,
        })
        log(`resume: session ${sessionID} after ${error.type}${status}`)
      } catch (cause) {
        log(`resume: failed for ${sessionID}: ${String(cause)}`)
      } finally {
        state.resuming = false
      }
    }

    // -------------------------------------------------------------------------
    // L3 — pause: sleep, then start a new resume window.
    // -------------------------------------------------------------------------

    const announcePause = async (sessionID: string): Promise<void> => {
      try {
        await ctx.session.synthetic({
          sessionID,
          text: `⏸ Still failing — pausing ${Math.round(DEFAULTS.pause.forMs / 60_000)} min before resuming again.`,
          description: "auto-retry pause",
          metadata: { source: "auto-retry", phase: "pause", pauseMs: DEFAULTS.pause.forMs },
          resume: false,
        })
      } catch {
        // The session may be gone; the pause still applies.
      }
    }

    const onTurnFailed = (sessionID: string, error: ProviderError): void => {
      const state = states.get(sessionID)
      if (state.timer || state.resuming || state.interrupted) return

      const now = Date.now()
      state.firstFailureAt ??= now
      state.resumeStartedAt ??= now

      const phase = decidePhase({
        now,
        firstFailureAt: state.firstFailureAt,
        resumeStartedAt: state.resumeStartedAt,
        resumeWithinMs: DEFAULTS.resume.withinMs,
        pauseUntilMs: DEFAULTS.pause.untilMs,
      })

      if (phase === "stop") {
        log(`stop: patience window elapsed for ${sessionID}`)
        return
      }

      if (phase === "resume") {
        // Resume immediately; the retry loop backoff happens inside the turn.
        state.timer = setTimeout(() => {
          state.timer = undefined
          void resumeTurn(sessionID, error)
        }, 0)
        return
      }

      // phase === "pause"
      log(`pause: ${DEFAULTS.pause.forMs}ms for ${sessionID}`)
      void announcePause(sessionID)
      state.timer = setTimeout(() => {
        state.timer = undefined
        state.resumeStartedAt = Date.now()
        void resumeTurn(sessionID, error)
      }, DEFAULTS.pause.forMs)
    }

    // -------------------------------------------------------------------------
    // Failure signal: a turn failed after its own backoff retries.
    // -------------------------------------------------------------------------

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const record = event as {
            type?: string
            data?: { sessionID?: string; error?: ProviderError }
          }
          if (!record?.type || !record.data?.sessionID) continue

          if (record.type === "session.step.failed" || record.type === "session.execution.failed") {
            const error = record.data.error
            if (error && shouldRetry(error)) onTurnFailed(record.data.sessionID, error)
          } else if (record.type === "session.execution.interrupted") {
            states.cancelTimer(record.data.sessionID)
            states.get(record.data.sessionID).interrupted = true
          }
        }
      } catch {
        // Stream closed during shutdown.
      }
    })()

    return () => {
      controller.abort()
      for (const state of states.all()) {
        if (state.timer) clearTimeout(state.timer)
      }
    }
  },
})
