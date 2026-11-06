/**
 * In-memory, per-session retry state. Nothing is persisted: when OpenCode
 * restarts, the map is gone and every session starts again from zero.
 */

export interface RetryState {
  /** First failure of this turn — the L3 stopwatch. */
  firstFailureAt?: number
  /** Start of the current resume window — the L2 stopwatch. */
  resumeStartedAt?: number
  /** Pending resume (immediate) or pause timer. */
  timer?: ReturnType<typeof setTimeout>
  /** A resume is currently being submitted (dedupe guard). */
  resuming: boolean
  /** Set when the user interrupted; cleared by the next user prompt. */
  interrupted: boolean
}

export type Phase = "resume" | "pause" | "stop"

/**
 * The whole mechanism in one decision:
 *
 *   stop    — the overall patience window elapsed
 *   resume  — still inside the current resume window: resume now
 *   pause   — resume window over: sleep, then start a new window
 */
export function decidePhase(input: {
  now: number
  firstFailureAt: number
  resumeStartedAt: number
  resumeWithinMs: number
  pauseUntilMs: number
}): Phase {
  if (input.now - input.firstFailureAt >= input.pauseUntilMs) return "stop"
  if (input.now - input.resumeStartedAt < input.resumeWithinMs) return "resume"
  return "pause"
}

export class RetryStates {
  private readonly sessions = new Map<string, RetryState>()

  get(sessionID: string): RetryState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { resuming: false, interrupted: false }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  /** Clears timers and forgets the session (next real user prompt). */
  reset(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (state?.timer) clearTimeout(state.timer)
    this.sessions.delete(sessionID)
  }

  cancelTimer(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (state?.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  all(): IterableIterator<RetryState> {
    return this.sessions.values()
  }
}
