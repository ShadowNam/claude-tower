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

It also carries what nothing else on screen does: the effort the turn actually
ran at (after any silent downgrade), how many files this session has changed and
by how many lines, a warning before the context is compacted rather than after,
and the engine's own reason when a turn fails — rate limited, overloaded,
billing — which otherwise leaves the session simply stopping with nothing said.

The edit count is **what Tower watched happen**, not `git status`: it cannot see
a change made in your editor and will not un-count a file you reverted. That is
what the name `edits` is doing, and why it is not called anything suggesting a
working tree.

The rate-limit windows belong to your account, not to this session, so they are
re-read on a timer rather than only when this session gets a reply — a session
left open while the work happened elsewhere used to show an hour-old percentage
as though it were current. When more than one of your sessions is alive, the
band says how many, which is the answer to "why did that drop while I was
reading".

### Layouts

The same figures, arranged four ways. Change it in `/config`; nothing restarts.

- **`rows`** — one dense line, every figure the same weight. The most in the
  least space.
- **`dials`** — each window as an arc gauge with its figure inside. Reads as an
  instrument. An arc gives less length per percent than a bar, so it is the
  less precise of the two; it is chosen for being quicker to read, not finer.
- **`hero`** — the window that will stop you first gets the space and the rest
  shrink. Which one that is changes through the day: a window on course to run
  out wins over one that is merely emptier, because a deadline changes what you
  do next and a level does not.
- **`cards`** — every figure on its own tile, all equal. Scans well, takes the
  most room.

**Press the band's own `USAGE` label to cycle them** — or `2` from an empty
prompt box. It writes the setting, so the change sticks rather than lasting
until the next reload, and the label says which layout is on. Four layouts
behind a settings menu is four layouts nobody will ever compare: by the time
you have found the menu and come back, the thing you were comparing against is
gone from memory.

**The terminal always draws `rows`**, whatever the setting says. It can draw
neither a gauge nor a tile, and an arc made of text is a worse bar rather than
a dial.

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

How you change these depends on where you are running.

**In the desktop app**, use the **+** beside the prompt box → **Plugins** →
Tower. `/config` and `/plugin` open interactive terminal panels, which the
desktop app has no way to show, so neither one works there.

**From a terminal**, either `/plugin configure tower@tower` at the prompt, or
from a shell without starting a session:

```
echo '{"bandLayout":"hero"}' | claude plugin configure tower@tower --values-stdin
```

`claude plugin configure tower@tower` with no values lists every option and
says which are set.

| Setting | Default | Notes |
|---|---|---|
| Usage band | on | |
| Band layout | `dials` | `rows`, `dials`, `hero`, `cards` — see below |
| Agents panel | on | |
| Build status bar | on | |

A change made inside the session reloads the mod with the new values and nothing
restarts. A change written from a shell goes into the same file from another
process, which the running session does not re-read, so that one needs the app
restarted.


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
