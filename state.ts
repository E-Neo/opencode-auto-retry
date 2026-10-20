/**
 * Mutable per-session replay state and a per-provider circuit breaker.
 *
 * Replay state is scoped to a single turn: the count and time budget reset when
 * the next real user prompt is admitted. The circuit breaker is scoped to a
 * provider and survives across turns so a dead provider stops being hammered.
 */

export interface SessionState {
  /** Number of auto-retry resumes fired for the current turn. */
  replays: number
  /** Epoch ms of the first terminal failure of the current turn. */
  firstFailureAt?: number
  /** Pending scheduled resume timer. */
  timer?: ReturnType<typeof setTimeout>
  /** Set when the user interrupted; blocks replays until the next user prompt. */
  interrupted: boolean
  /** Last epoch ms a real user prompt was admitted (used to detect user takeover). */
  userPromptAt?: number
}

interface BreakerState {
  failures: number
  openedAt?: number
}

export class ReplayState {
  private readonly sessions = new Map<string, SessionState>()
  private readonly breakers = new Map<string, BreakerState>()

  get(sessionID: string): SessionState {
    let session = this.sessions.get(sessionID)
    if (!session) {
      session = { replays: 0, interrupted: false }
      this.sessions.set(sessionID, session)
    }
    return session
  }

  /** Clears a session's pending timer and replay budget (next real user prompt). */
  reset(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (session?.timer) clearTimeout(session.timer)
    this.sessions.delete(sessionID)
  }

  cancelTimer(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (session?.timer) {
      clearTimeout(session.timer)
      session.timer = undefined
    }
  }

  allSessions(): IterableIterator<SessionState> {
    return this.sessions.values()
  }

  /** Records a replay failure against a provider; opens the circuit at the threshold. */
  recordFailure(providerID: string, threshold: number): void {
    const breaker = this.breakers.get(providerID) ?? { failures: 0 }
    breaker.failures += 1
    if (threshold > 0 && breaker.failures >= threshold) breaker.openedAt = Date.now()
    this.breakers.set(providerID, breaker)
  }

  /** True while the circuit is open (within the cooldown window). */
  isOpen(providerID: string, cooldownMs: number): boolean {
    const breaker = this.breakers.get(providerID)
    if (!breaker?.openedAt) return false
    if (Date.now() - breaker.openedAt >= cooldownMs) {
      // Cooldown elapsed: close the circuit and allow a probe.
      this.breakers.delete(providerID)
      return false
    }
    return true
  }
}
