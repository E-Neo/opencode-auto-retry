# opencode-auto-retry

Auto-retry plugin for OpenCode (V2). Keeps a turn alive through transient
provider failures (rate limits, 5xx, transport errors) instead of letting the
error surface after OpenCode's built-in retry budget is spent.

## Mechanism — three levels

| Level | Name | What happens |
|---|---|---|
| L1 | **backoff** | OpenCode retries the model request; the plugin tunes the wait between attempts (never shorter than the provider's `Retry-After`). |
| L2 | **resume** | When the turn finally fails, the plugin posts a "continue" message that starts a fresh turn. It keeps resuming for `resume.withinMs`. |
| L3 | **pause** | When the resume window is over, it waits `pause.forMs` (a fixed sleep, not a backoff), then starts a new resume window. It stops after `pause.untilMs` since the first failure. |

```
L1  backoff    ── wait between attempts (exponential)
L2  resume     ── repeat L1 for 30 min
L3  pause      ── sleep 30 min, repeat L2, stop after 8 h
```

## Behavior

- Only **transient** failures are retried: rate limits (429), 408/409/5xx,
  transport failures, incomplete streams, and unknown failures. Terminal errors
  (`provider.auth`, `provider.quota` without 429, invalid request, content
  filter, permission) fail fast.
- A `429` is always treated as transient, even when OpenCode maps it to
  `provider.quota` (common for tpm/rpm limits).
- The failed turn's original user message is **never re-sent**. Resume posts one
  synthetic message; the transcript has no duplicate prompt.
- No persisted state. Counters/timers live in memory; an OpenCode restart starts
  every session from zero.

## Defaults

Configured in code (`DEFAULTS` in `index.ts`) — there is **no config file**.

```ts
openCodeMaxAttempts: 11,                                  // OpenCode's real limit
backoff: { startMs: 2000, maxMs: 30000, factor: 2, jitter: 0.2, handoffAtMaxAttempts: true },
resume:  { withinMs: 1_800_000 },                         // 30 min
pause:   { forMs: 1_800_000, untilMs: 28_800_000 },       // 30 min, 8 h total
```

## Install

Place the plugin under the global plugins directory (auto-discovered):

```sh
git clone <repo-url> ~/.config/opencode/plugins/auto-retry
```

OpenCode provides `@opencode/plugin` at runtime, so no `npm install` is needed;
`node_modules` is only for local type-checking (`npm install && npx tsc --noEmit`).

Verify it loaded:

```sh
opencode plugin list | grep auto-retry
```

## Layout

```
index.ts     plugin setup, L1 retry hook, L2/L3 loop, event subscription
classify.ts  transient vs terminal failure classification
backoff.ts   L1 exponential backoff + Retry-After floor
state.ts     in-memory per-session state + the phase decision
```
