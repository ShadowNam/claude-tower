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

Where the surface draws vector art — the desktop app, the editor, the phone — each
window is a drawn meter and the band carries the mod's mark, so it is obvious at a
glance whose row it is. The terminal gets dot strings saying the same thing, and every
figure is written out either way: a drawing is never the only account of a number.

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
writes and a shell command run in this session. A failure shows its
first error line and holds the row until something else needs it.

## Settings

Everything is in `/config`, under Tower.

| Setting | Default | Notes |
|---|---|---|
| Usage band | on | |
| Agents panel | on | |
| Build status bar | on | |

Changing any of these in `/config` reloads the mod with the new values. Nothing has to
be restarted. Changing them with `claude plugin configure` from a shell writes the same
file from another process, which the running session does not re-read — that one needs
the app restarted.


## Commands

- `/tower` — what loaded, what is switched on, where it draws, and anything that
  failed to start
- `/tower-agents` — open or close the agents panel
- `/tower-hook` — print the snippet that lets a build script report its own progress


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

## What was taken out

Tower watches the session you are sitting in. Three features did not — Tank
polling, the Tank watchdog, WhatsApp notifications and GitHub Actions polling
all watched a machine somewhere else — so they were lifted out whole into [`salvage/`](salvage/),
along with the GitHub Actions polling, with their tests, types, settings and the reasoning behind their safety
rules. Nothing there is loaded. Its README says how to revive them.

Everything taken out is also written up whole in [`EXTRACTED.md`](EXTRACTED.md):
the code, its types, its settings, how it was wired and the reasoning behind the
parts that look arbitrary — enough to rebuild any of it somewhere else without
reading this repository.
