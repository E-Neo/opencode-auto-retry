/**
 * opencode-auto-retry
 *
 * Works around OpenCode's hard built-in retry limit (10 retries + initial =
 * 11 attempts, per `Schedule.recurs(10)` in packages/core/src/model-retry.ts).
 *
 * Two layers:
 *
 *  A. WITHIN the limit — the `retry` hook tunes OpenCode's own retry decisions:
 *     transient errors get a configurable backoff, terminal errors fail fast,
 *     and at the last attempt the turn is handed off to layer B.
 *
 *  B. PAST the limit — when a transient failure surfaces anyway
 *     (`session.step.failed` / `session.execution.failed`), the session is
 *     resumed with `session.synthetic({ ..., resume: true })`. This starts a new
 *     turn with a fresh attempt counter, and the transcript's original user
 *     message is never re-sent (no duplication).
 *
 * Safety: max replays per turn, a wall-clock time budget, a per-provider circuit
 * breaker, and cancellation when the user interrupts or sends a new prompt.
 *
 * Options precedence (highest first):
 *   1. `ctx.options` (plugins array in opencode.jsonc)
 *   2. `$AUTO_RETRY_CONFIG` file, else `~/.config/opencode/auto-retry.json`
 *   3. built-in defaults
 */

import { Plugin } from "@opencode/plugin"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { shouldRetry, type ClassifierOptions, type ProviderError } from "./classify.js"
import { backoffDelay, resolveRetryDelay, type BackoffConfig } from "./backoff.js"
import { ReplayState } from "./state.js"

interface WithinLimitOptions extends BackoffConfig {
  readonly enabled: boolean
  readonly handoffAtMaxAttempts: boolean
}

interface ReplayOptions {
  readonly enabled: boolean
  readonly maxReplays: number
  readonly timeBudgetMs: number
  readonly announce: boolean
  readonly backoff: BackoffConfig
}

interface CircuitBreakerOptions {
  readonly enabled: boolean
  readonly failureThreshold: number
  readonly cooldownMs: number
}

interface Options {
  readonly enabled: boolean
  /** Provider allow-list; empty means all providers. */
  readonly providers: string[]
  /** Mirror of OpenCode's hard attempt limit (recurs(10) + initial = 11). */
  readonly openCodeMaxAttempts: number
  readonly withinLimit: WithinLimitOptions
  readonly replay: ReplayOptions
  readonly circuitBreaker: CircuitBreakerOptions
  readonly errorPatterns: ClassifierOptions
}

const DEFAULT_OPTIONS: Options = {
  enabled: true,
  providers: [],
  openCodeMaxAttempts: 11,
  withinLimit: {
    enabled: true,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    factor: 2,
    jitter: 0.2,
    handoffAtMaxAttempts: true,
  },
  replay: {
    enabled: true,
    maxReplays: 3,
    timeBudgetMs: 600_000,
    announce: true,
    backoff: { baseDelayMs: 15_000, maxDelayMs: 120_000, factor: 2, jitter: 0.2 },
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    cooldownMs: 120_000,
  },
  errorPatterns: {},
}

// ---------------------------------------------------------------------------
// Options loading
// ---------------------------------------------------------------------------

function merge<T>(target: T, source: unknown): T {
  if (source === null || source === undefined || typeof source !== "object") return target
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const current = (target as Record<string, unknown>)[key]
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object") {
      merge(current, value)
    } else {
      ;(target as Record<string, unknown>)[key] = value
    }
  }
  return target
}

function readConfigFile(file: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(file, "utf8")
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function loadOptions(pluginOptions: unknown): Options {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode")
  const configFile = process.env.AUTO_RETRY_CONFIG ?? path.join(configDir, "auto-retry.json")

  const options = structuredClone(DEFAULT_OPTIONS)
  merge(options, readConfigFile(configFile))
  merge(options, pluginOptions)
  return options
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "auto-retry",
  async setup(ctx) {
    const options = loadOptions(ctx.options)
    console.error(`[auto-retry] loaded (config file: ${process.env.AUTO_RETRY_CONFIG ?? "~/.config/opencode/auto-retry.json"})`)
    console.error(`[auto-retry] options: ${JSON.stringify(options)}`)
    if (!options.enabled) return

    const state = new ReplayState()
    // sessionID -> providerID, learned from retry-hook events so the event
    // stream can scope decisions without an extra lookup.
    const sessionProviders = new Map<string, string>()

    const isScopedProvider = (providerID: string | undefined) =>
      options.providers.length === 0 || (providerID !== undefined && options.providers.includes(providerID))

    const resolveProvider = async (sessionID: string): Promise<string | undefined> => {
      const cached = sessionProviders.get(sessionID)
      if (cached) return cached
      try {
        const session = await ctx.session.get({ sessionID })
        const providerID = session?.model?.providerID
        if (providerID) sessionProviders.set(sessionID, providerID)
        return providerID
      } catch {
        return undefined
      }
    }

    const classifierOptions: ClassifierOptions = options.errorPatterns

    // -----------------------------------------------------------------------
    // Layer A: tune OpenCode's retries within the built-in limit
    // -----------------------------------------------------------------------

    const retryHook = (event: {
      readonly sessionID: string
      readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
      readonly error: ProviderError
      readonly attempt: number
      decision: { retry: boolean; delay?: number }
    }) => {
      sessionProviders.set(event.sessionID, event.model.providerID)
      if (!isScopedProvider(event.model.providerID)) return
      if (!options.withinLimit.enabled) return

      if (!shouldRetry(event.error, classifierOptions)) {
        event.decision = { retry: false }
        console.error(
          `[auto-retry] vetoing retry (attempt ${event.attempt}): ${event.error.type} ${event.error.status ?? ""}`.trim(),
        )
        return
      }
      const maxAttempts = Math.max(1, options.openCodeMaxAttempts)
      if (
        options.replay.enabled &&
        options.withinLimit.handoffAtMaxAttempts &&
        event.attempt >= maxAttempts
      ) {
        // Last chance: hand the turn over to the replay layer deterministically
        // instead of running (and likely failing) the final OpenCode attempt.
        event.decision = { retry: false }
        console.error(`[auto-retry] handing off at attempt ${event.attempt} to replay layer`)
        return
      }
      const delay = resolveRetryDelay(event.attempt, event.decision, options.withinLimit)
      event.decision = { retry: true, delay }
      console.error(`[auto-retry] retry ${event.attempt}: ${event.error.type}, delay ${delay}ms`)
    }

    if (options.providers.length > 0) {
      for (const providerID of options.providers) {
        await ctx.session.hook("retry", retryHook, { providerID })
      }
    } else {
      await ctx.session.hook("retry", retryHook)
    }

    // -----------------------------------------------------------------------
    // Reset per-turn replay state on every real user prompt (synthetic and
    // shell messages do not run the prompt hook, so our own resumes never
    // clobber this).
    // -----------------------------------------------------------------------

    await ctx.session.hook("prompt", (event: { readonly sessionID: string }) => {
      state.reset(event.sessionID)
    })

    // -----------------------------------------------------------------------
    // Layer B: resume past the limit via synthetic messages
    // -----------------------------------------------------------------------

    const fireReplay = async (sessionID: string, error: ProviderError): Promise<void> => {
      const log = (msg: string) => console.error(`[auto-retry] ${new Date().toISOString()} ${msg}`)
      const session = state.get(sessionID)
      if (session.interrupted) return log(`fireReplay bail: interrupted ${sessionID}`)
      if (session.userPromptAt !== undefined && session.firstFailureAt !== undefined && session.userPromptAt > session.firstFailureAt) {
        return log(`fireReplay bail: user took over ${sessionID}`)
      }
      const now = Date.now()
      if (session.firstFailureAt !== undefined && now - session.firstFailureAt >= options.replay.timeBudgetMs) return log(`fireReplay bail: budget ${sessionID}`)
      const providerID = await resolveProvider(sessionID)
      if (!isScopedProvider(providerID)) return log(`fireReplay bail: unscoped ${sessionID} provider=${providerID}`)
      if (options.circuitBreaker.enabled && providerID && state.isOpen(providerID, options.circuitBreaker.cooldownMs)) return log(`fireReplay bail: circuit open ${sessionID}`)

      // Give the failed turn time to settle before waking the session. Bound the
      // wait so we never block behind a brand-new user turn.
      try {
        await Promise.race([
          ctx.session.wait({ sessionID }),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ])
        log(`fireReplay wait resolved ${sessionID}`)
      } catch (waitError) {
        return log(`fireReplay bail: wait threw ${sessionID}: ${String(waitError)}`)
      }

      // The user may have sent a new prompt (which resets the session state)
      // while we waited. If the entry we captured is no longer the current one,
      // bail out: resuming now would interleave with the user's new turn.
      if (state.get(sessionID) !== session) return log(`fireReplay bail: state changed ${sessionID}`)

      session.replays += 1
      const statusText = error.status !== undefined ? ` (HTTP ${error.status})` : ""
      const countText = options.replay.maxReplays > 1 ? ` (retry ${session.replays}/${options.replay.maxReplays})` : ""
      const text = options.replay.announce
        ? `⟳ Auto-retrying after provider error: ${error.type}${statusText}${countText}. Please ignore the transient error above and continue with your previous request.`
        : `Please ignore the transient provider error above and continue with your previous request.`

      try {
        await ctx.session.synthetic({
          sessionID,
          text,
          description: "auto-retry",
          metadata: { source: "auto-retry", attempt: session.replays, error: error.type, status: error.status ?? null },
          resume: true,
        })
        console.error(
          `[auto-retry] ${new Date().toISOString()} resumed session ${sessionID} (retry ${session.replays}) after ${error.type} ${error.status ?? ""}`.trim(),
        )
      } catch (syntheticError) {
        log(`fireReplay synthetic threw ${sessionID}: ${String(syntheticError)}`)
        // Could not submit the resume (session busy or removed); count it as a
        // replay failure so the circuit breaker can eventually give up.
        if (providerID && options.circuitBreaker.enabled) {
          state.recordFailure(providerID, options.circuitBreaker.failureThreshold)
        }
      }
    }

    const scheduleReplay = async (sessionID: string, error: ProviderError): Promise<void> => {
      const session = state.get(sessionID)
      if (session.timer) return // already scheduled for this failure
      if (session.interrupted) return

      const providerID = await resolveProvider(sessionID)
      if (!isScopedProvider(providerID)) return
      if (options.circuitBreaker.enabled && providerID && state.isOpen(providerID, options.circuitBreaker.cooldownMs)) return

      // The prompt hook may have reset the session while we awaited the lookup.
      if (state.get(sessionID) !== session) return

      const now = Date.now()
      if (session.firstFailureAt === undefined) session.firstFailureAt = now
      if (session.replays >= options.replay.maxReplays) return
      const budgetLeft = session.firstFailureAt + options.replay.timeBudgetMs - now
      if (budgetLeft <= 0) return

      // A replay cycle is a whole resumed turn (fresh OpenCode retry schedule),
      // so count every failure we observe after at least one replay against the
      // provider's circuit breaker.
      if (session.replays > 0 && providerID && options.circuitBreaker.enabled) {
        state.recordFailure(providerID, options.circuitBreaker.failureThreshold)
        if (state.isOpen(providerID, options.circuitBreaker.cooldownMs)) return
      }

      const nextAttempt = session.replays + 1
      const delay = Math.min(backoffDelay(nextAttempt, options.replay.backoff), budgetLeft)
      session.timer = setTimeout(() => {
        session.timer = undefined
        void fireReplay(sessionID, error).catch(() => {})
      }, delay)
      console.error(
        `[auto-retry] scheduling resume for session ${sessionID} in ${delay}ms (replay ${nextAttempt}/${options.replay.maxReplays}, budget ${Math.max(0, budgetLeft)}ms left)`,
      )
    }

    const handleEvent = (event: unknown): void => {
      const record = event as {
        type?: string
        data?: { sessionID?: string; error?: ProviderError }
      }
      if (!record?.type || !record.data?.sessionID) return
      switch (record.type) {
        case "session.step.failed":
        case "session.execution.failed": {
          if (!options.replay.enabled || !record.data.error) return
          if (!shouldRetry(record.data.error, classifierOptions)) return
          void scheduleReplay(record.data.sessionID, record.data.error).catch(() => {})
          break
        }
        case "session.execution.interrupted": {
          state.cancelTimer(record.data.sessionID)
          state.get(record.data.sessionID).interrupted = true
          break
        }
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handleEvent(event)
        }
      } catch {
        // Stream closed during shutdown; ignore.
      }
    })()

    return () => {
      controller.abort()
      for (const session of state.allSessions()) {
        if (session.timer) clearTimeout(session.timer)
      }
    }
  },
})
