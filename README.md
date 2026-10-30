# Tower

One place to see what a Claude Code session is actually doing. Tower is a mod: it draws
inside the session rather than in a separate window, and it reads the engine's own figures,
so it costs no tokens to run and nothing to keep open.

```
USAGE  7D ●●●●●●●··· 69% left · 5d 18h   5H ●●●●●●●●●· 85% left · 21m   WARM 58m left   $2.14 session
BUILD  ●●●●●●●●····  62% ~1m 50s left ◈ · 2m 54s elapsed
       web-app 2.4.1 · npm run build
```

## Install

At the prompt of a terminal session:

```
/plugin install tower --marketplace ShadowNam/claude-tower
```

Answer `y` to add the marketplace, then choose a scope. From a shell instead:

```
claude plugin install tower --marketplace ShadowNam/claude-tower
```

In the desktop app, where `/plugin` does not run: **+** beside the prompt box → Plugins →
Add marketplace `ShadowNam/claude-tower` → Add plugin.

No GitHub sign-in is needed to install it.

## What it shows

**Usage** — how much of your 5-hour and 7-day windows is left, when each resets, whether the
prompt cache is warm and what re-sending the context will cost once it is not, and what the
engine says the session has cost. When a window is being spent fast enough to run out
*before* it resets, it says when. When it would reset first, it stays quiet.

**Agents** (`/tower-agents`) — every agent loop nested under the one that spawned it, with
its model and effort, what tool it is running right now, how full its context is, what it
has cost and how long it has run. The main session is a row of its own, because it is
usually the largest single cost. A run with no model request for two minutes is flagged as
stalled. The header compares wall time to summed agent time, which is the only figure that
says whether a fan-out really ran in parallel.

**Builds** — one row for the build that matters most, with a progress bar and an expected
finish. Sources, in the order they are trusted: a `.buildstatus.json` marker a build script
writes, a GitHub Actions run, and a shell command run in this session. A failure shows its
first error line and holds the row until something else needs it.

**Tank** (`/tower-tank`) — what each of your Tank instances is doing, what is waiting on an
answer from you, what failed in the last day, and how far the build queues are. Optionally a
watchdog that resumes tasks killed by a transient error.

**WhatsApp** — a message when something you cared about changed. Off until you turn it on.

## Settings

Everything is in `/config`, under Tower.

| Setting | Default | Notes |
|---|---|---|
| Usage band | on | |
| Agents panel | on | |
| Build status bar | on | |
| Tank panel | off | Needs the instance names below |
| Tank instances | `tank` | MCP server names, as `/mcp` lists them |
| GitHub token | empty | Actions read access, for CI progress. Kept in your OS keychain |
| Send WhatsApp notifications | **off** | The master switch |
| WhatsApp MCP server | empty | Your gateway's server name — see below |
| Notification level | `silent` | `silent`, `milestones`, `verbose`, `debug` |
| Quiet hours | `22:00-07:00` | Held until morning, except what means work has stopped |
| Tank watchdog | `alert` | `off`, `alert`, `resume` |

Changing any of these in `/config` reloads the mod with the new values. Nothing has to
be restarted. Changing them with `claude plugin configure` from a shell writes the same
file from another process, which the running session does not re-read — that one needs
the app restarted.

### Naming an MCP server

The Tank and WhatsApp settings take server names, and which spelling works depends on
where the server came from:

- **Configured yourself** (`claude mcp add`, `.mcp.json`) — the name you gave it:
  `tank`, `tank-prod`.
- **A claude.ai connector** — its **id**, not its title. A connector called
  "WhatsApp Gateway" is addressed as `aa465f29-6c9e-4063-966d-507df8b7208b`, which is
  the same string its tools carry: `mcp__aa465f29-…__whatsapp_send_message`. The title
  does not resolve.

If a name is wrong, `/tower-notify test` says so and names what it tried. Automatic
sends cannot, so test after any change.

## Commands

- `/tower` — what loaded, what is switched on, where it draws, and anything that
  failed to start
- `/tower-agents` — open or close the agents panel
- `/tower-tank` — open or close the Tank panel
- `/tower-hook` — print the snippet that lets a build script report its own progress
- `/tower-notify` — what would be sent; `/tower-notify test` sends the first message

## If you see nothing

Run `/tower`. It answers even when every other part of the mod has failed,
because the diagnostics are seeded before anything else starts.

- **`/tower` is an unknown command** — the mod is not loaded. Check it is enabled,
  and remember that a change made with `claude plugin configure` from a shell only
  takes effect the next time the app starts.
- **`/tower` answers and lists failures** — that feature is the one to look at; the
  rest of the mod carries on without it.
- **`/tower` answers, nothing is listed, and the band says `windows not measured
  yet`** — the mod is fine and waiting. The engine hands over the context a session
  is carrying at startup but the rate-limit windows only on a later measurement, so
  the windows appear once a turn has run.

Each feature starts on its own. One that throws is skipped alone and named in
`/tower`, rather than taking the other three down with it.

## About the WhatsApp notifications

This is the only part of Tower that does something irreversible, so the limits are built in
rather than configured:

- It is **off** until you turn it on, and `silent` even then.
- It only ever sends **to your own number**. The recipient is not a setting, because a
  setting could come from a file in a repository.
- Every message is a **fixed template** filled with local facts. Nothing a model composed is
  ever sent, so a prompt injection has nothing to say through it.
- Anything that looks like a credential is stripped before a message is built.
- The **first message is one you send yourself**, with `/tower-notify test`.
- Throttled: five minutes between messages of a kind, thirty before an identical one
  repeats, fifteen per session, sixty per day.

## About the Tank watchdog

In the default `alert` mode it only tells you. Set to `resume` it will reply `[watchdog
resume]` to a stalled task, under limits that cannot be configured away: only for transient
failures (connection lost, a 5xx, a restart), never on `main`, `master`, `production` or a
release branch, **twice per task ever**, five minutes apart, at most five an hour across
everything, and every resume sends a message. The counts live in the store, so restarting
the session does not reset them.

## Developing

```
claude plugin validate ./tower
claude plugin test ./tower
```

The mod is one hooks module (`hooks/register.tsx`) that wires each feature; `hooks.json`
takes a single module path, so features are functions, not separate modules. Four engine
rules shape the layout and are worth knowing before editing:

1. An `atom` is only followed by the static scan **within the file that reads or updates
   it**, so all state lives behind helpers in `core/state.ts`.
2. `$` crossing a module boundary is only followed into a **declared function**, never a
   const arrow, and the parameter must be spelled `$`.
3. An event may be registered **once without a matcher** per module, so `core/boot.ts` owns
   `session.start`, `core/turns.ts` owns the turn events, and `core/tools.ts` owns
   `tool.call`; each fans out to the features.
4. A `ui.render` hook may not write state and must do no I/O. Collectors write
   pre-formatted values; drawings only read.

`$.process.*` is CLI-only, so anything shelling out must degrade gracefully in the desktop
app.

## Credit

Tower's agent-tracking approach — recording the engine's `agentId` at spawn and matching
every later event on it — follows the one worked out in
[savvy-progress](https://github.com/johnnyvizz/claude-kit), and the price table is derived
from it. Both are MIT; see NOTICE.
