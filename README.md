# opencode-auto-retry

Auto-retry plugin for OpenCode (V2). Works around OpenCode's hard built-in
retry limit (`Schedule.recurs(10)` → 11 physical attempts per turn) that
otherwise surfaces as an `AIError` and kills the turn.

## How it works

- **Within the limit** — the `retry` hook tunes OpenCode's own retries:
  transient errors get a configurable exponential backoff, terminal errors
  (`provider.auth`, `provider.quota`, `provider.invalid-request`, …) fail fast,
  and at the last attempt the turn is handed off to the replay layer.
- **Past the limit** — on a terminal transient failure
  (`session.step.failed` / `session.execution.failed`) the session is resumed
  with `session.synthetic({ ..., resume: true })`. This starts a new turn with a
  fresh attempt counter. The original user message is never re-sent, so the
  transcript has **no duplicate prompt** — only the synthetic announcement.

## Safety

- `maxReplays` per turn and a `timeBudgetMs` wall-clock budget (whichever runs
  out first stops the loop).
- Per-provider circuit breaker (`failureThreshold`, `cooldownMs`) so a dead
  provider is not hammered.
- Replays are cancelled when the user interrupts or sends a new prompt.

## Install / load

Place the plugin under the global plugins directory; OpenCode discovers it
automatically:

```
~/.config/opencode/plugins/auto-retry/
```

If you register it in the `plugins` array of `opencode.jsonc` instead (to pass
options inline), **do not** leave it in the auto-discovered `plugins/`
directory too — OpenCode dies with "Duplicate plugin ID" when the same plugin
loads twice.

## Configuration

Options are read in this order (highest precedence first):

1. `ctx.options` — the `plugins` array entry in `opencode.jsonc`
2. `$AUTO_RETRY_CONFIG` file, or `~/.config/opencode/auto-retry.json`
3. built-in defaults

Example `~/.config/opencode/auto-retry.json`:

```json
{
  "enabled": true,
  "providers": [],
  "openCodeMaxAttempts": 11,
  "withinLimit": {
    "enabled": true,
    "baseDelayMs": 2000,
    "maxDelayMs": 30000,
    "factor": 2,
    "jitter": 0.2,
    "handoffAtMaxAttempts": true
  },
  "replay": {
    "enabled": true,
    "maxReplays": 3,
    "timeBudgetMs": 600000,
    "announce": true,
    "backoff": { "baseDelayMs": 15000, "maxDelayMs": 120000, "factor": 2, "jitter": 0.2 }
  },
  "circuitBreaker": {
    "enabled": true,
    "failureThreshold": 5,
    "cooldownMs": 120000
  },
  "errorPatterns": {
    "retryTypes": ["provider.timeout"],
    "ignoreTypes": [],
    "retryPatterns": [],
    "ignorePatterns": []
  }
}
```

Set `providers` (e.g. `["sensenova"]`) to limit the plugin to specific
providers. `errorPatterns` lets you force retry/ignore decisions per type or by
message/body substring.

## Development

```sh
cd ~/.config/opencode/plugins/auto-retry
npm install
npx tsc --noEmit
```

Restart the service to pick up changes:

```sh
touch ~/.config/opencode/plugins/auto-retry/index.ts
opencode service restart
```

Check it loaded: `opencode plugin list` and `~/.local/share/opencode/log/opencode.log`
(role=server).
