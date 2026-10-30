# Salvage

Four features lifted out of Tower whole, for a plugin of their own later.
All of this is also written up as one self-contained document in
[`../EXTRACTED.md`](../EXTRACTED.md), which is the file to hand to a fresh
session.
Nothing here is loaded: `hooks/hooks.json` names one module and it does not
reach this folder. The tests are `.spec.ts` rather than `.test.ts` so
`claude plugin test` leaves them alone — rename them back when they have a
plugin to run against.

They were removed because none of them is about watching the session you are
sitting in. `ci.ts` is the odd one: it needs no MCP server, only a GitHub token,
but it watches a build on someone else's machine and the token was never set, so
it has never run. They watch a machine somewhere else, and they all go through
`$.mcp.call`, which has a consequence worth knowing before reviving them:
**auto mode refuses every one of these calls.** The classifier judges a call
against the model request that asked for it, and a mod's call belongs to no
request, so it fails closed. In auto mode all three features are dead.

## What is here

| File | Was | Lines |
|---|---|---|
| `hooks/notify.ts` | WhatsApp notifications, and all the sending policy | 331 |
| `hooks/tank.ts` | Tank instance polling and the alert model | 273 |
| `hooks/watchdog.ts` | Resuming Tank tasks killed by a transient failure | 186 |
| `hooks/pane-tank.tsx` | The Tank panel | 138 |
| `hooks/ci.ts` | GitHub Actions run polling, for a build bar | 176 |
| `tests/*.spec.ts` | 23 tests, all of the policy ones pure | — |
| `types.d.ts` | `Tank`, `TankInstance`, `TankTask`, `TankQueue`, `TankAlert` | 53 |
| `userConfig.json` | The seven settings these owned | — |

## Putting them back

1. Copy `hooks/*` into the host's `hooks/core/` (and `pane-tank.tsx` into
   `hooks/ui/`), `types.d.ts` into its contract, and add `tank: Tank` to the
   `PluginState` entry.
2. Merge `userConfig.json` into the host manifest's `userConfig`.
3. Wire them up. Each exports a `register*` for the host's `register`, and
   `notify.ts`, `tank.ts` export a `start*` the host calls from its one
   `session.start` hook — the engine takes a single unmatched registration
   per event, so they cannot hook it themselves.
4. `fmt.ts` needs `['tankPanel', 'tank']` back in `panelsOf`.

They import `reasonOf` and `redact` from the host's `fmt.ts`, and `notify`
from each other; `tank.ts` imports `runWatchdog`, and `watchdog.ts` imports
`jsonOf` from `tank.ts`.

## What the callers lost

Four places used to call `notify(...)` and no longer do. Revive these only
if the new plugin can see the same events:

- `usage.ts` — `ratelimit.hit` at 100% of a window, `ratelimit.near` at 90%
- `tools.ts` — `build.failed` / `build.finished`, for builds long enough to
  be worth telling about
- `turns.ts` — `agent.failed`, when a subagent stops without answering
- `watchdog.ts` — `tank.resumed`, on every resume

## The rules that are not settings

These were deliberately built in rather than configured, and the reasoning
holds wherever the code lands.

**The recipient is not a setting.** `to` is never passed to the gateway, which
falls back to the account's own number. A setting could be written by a file
in a repository; the absence of one cannot.

**Every message is a fixed template** filled with local facts. Nothing a model
composed is ever sent, so a prompt injection has nothing to say through it.

**The first message is one the person sends**, with `/tower-notify test`.

**The watchdog's limits cannot be configured away**: transient failures only,
never on a protected branch, twice per task ever, five minutes apart, five an
hour across everything, and every resume sends a message. The counts live in
the store, so restarting the session does not reset them.
