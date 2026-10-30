# Tower — what is left to build

Everything here came out of three research passes over the band, the engine's
typings and the two mods that draw well. Tick what you want.

**How to read the marks.** ✅ means I verified it against the code or the
typings myself. ⚠ means the research asserts it and I have not checked — treat
those as leads, not facts. Space is in columns of the band's wide row.

**The one constraint that governs everything below.** The wide row already
measures about **155 columns against a `WIDE_AT` of 110**. Nothing fits by
addition. Every band item is marked **(R)** replaces something, **(N)** costs
nothing until it has news, or **(2)** lives on row two.

---

## A. Bugs and debt — do these first, they are small

- [ ] ✅ **Gate the ticker.** `startUsage` calls `$.clock.every(30s)` with no
      condition, so every idle session redraws the band forever. savvy-progress
      ticks only while something is running. *Easy.*
- [ ] ✅ **The context percentage uses the wrong denominator.** `band.tsx`
      divides by `ledger.window`, but compaction fires against `rawMaxTokens`,
      which the typings say "may be smaller than `window`". The number is wrong
      for the one decision it drives. Fixed by B2 below. *Easy.*
- [ ] ✅ **The burn projection is per-session; the window is account-wide.**
      `burn.ts` fits a line through this session's samples. With three sessions
      running the projection is wrong and the band states it confidently.
      Either qualify it or fix it with D4. *Medium.*
- [ ] ⚠ **Sibling elements wrap onto new lines on the desktop surface.**
      savvy-progress draws its whole row as one SVG and its comment says this is
      why. Tower's band is a long chain of sibling `Box`/`Text`, which is what
      made `$4.80 session` fall onto a second line. See C7. *Medium.*
- [ ] ✅ **Prune the build-run store.** `$.store.set` is called but `keys` and
      `delete` never are, so run history grows without bound against a 4 MiB cap.
      *Easy.*

---

## B. Features — high value, cheap

- [ ] ✅ **B1. Stalled agents in the crew chip** — `3 running · 1 stalled 3m`
      **(N)**, ~12 cols.
      Tower already flags a run with no model request for two minutes; `totalsOf`
      just doesn't surface it, so the band drops the one fact that needs you to
      act now. *Easy — the data is already computed.*
- [ ] ✅ **B2. Distance to auto-compaction** — `ctx 62% · compact in ~38k`
      **(R)**, +8 cols.
      `$.session.usage({ breakdown: 'summary' })` gives `autoCompactThreshold`,
      `rawMaxTokens`, `isAutoCompactEnabled`. `summary` estimates locally — no
      API call, no cost. Replaces today's `ctx N%` and fixes it. *Easy–medium.*
- [ ] ✅ **B3. Last turn's cost beside the session total** — `$99.78 session ·
      $0.31 last` **(R)**, +12 cols.
      `session.measure` already arrives with `e.cost.usd`; keep the previous
      value and subtract. Turns a vanity total into a feedback loop. *Easy.*
- [ ] ✅ **B4. Effort level** — `xhigh` **(N)**, 5 cols, only when not default.
      Already flowing through `turn.step` as `e.effort`. Effort is invisible in
      the UI and silently downgrades per model, so a session you believe is on
      xhigh may not be. *Easy.*
- [ ] ⚠ **B5. Session edits** — `edits 7 files +248/−31` **(N/2)**, ~20 cols.
      From the existing `tool.call` hook on `Edit`/`Write`: collect file paths,
      count newlines in `old_string` vs `new_string`. The honest "should I commit"
      signal. **Label it `session edits`, never `dirty`** — it cannot see your
      editor's changes and will not un-count a revert. *Easy.*
- [ ] ⚠ **B6. API-slow warning** — `API SLOW · 18 tok/s` **(N)**, 0 at rest.
      `turn.complete` gives `durationMs` and `usage.output_tokens`; keep a rolling
      median. Tells you whether a slow session is the API, your repo or your
      prompt. *Easy–medium — the threshold is the hard part.*
- [ ] ⚠ **B7. Plan progress** — `PLAN ●●●●●··· 5/9 · writing the migration test`
      **(2)**, ~45 cols.
      From `tool.call` on `TodoWrite` / `mcp__ccd_turn__update_plan`. Reading an
      MCP tool's **arguments** in a `tool.call` hook is not `$.mcp.call`, so auto
      mode does not block it. The only thing that would say what the session is
      *doing* rather than what it costs. Partly duplicates engine chrome. *Easy.*
- [ ] ✅ **B8. Use `isWorking` from the band's own props.** Tower infers working
      state from `turn.step`/`turn.complete` into state; `AbovePrompt` hands it
      over free on every draw. *Easy.*

---

## C. Graphics and GUI

Already shipped in 2.2.0, listed so nobody redoes it: track rim, linear fill
below 12%, dark-lip profile, head shadow and leading edge, 2-unit minimum
feature, opaque floor, dither, quarter notches, orb rim arc, small specular,
alert silhouette for failure, single-silhouette mark, cyan cold state, `weight`
instead of deprecated `bold`, `tabular` figures.

- [ ] ✅ **C1. Run the filter probe.** One SVG with a blurred and an unblurred
      square side by side. Nobody in any installed mod uses `feGaussianBlur` or
      `feDropShadow`, so availability is unknown. Everything shipped so far is
      filter-free, but the answer decides whether real blur is ever on the table.
      *Trivial — needs you to look at it.*
- [ ] ✅ **C2. CSS animation inside a plain `Svg`.** savvy-progress ships
      `<style>`, `@keyframes` and `prefers-reduced-motion` with **no
      `isInteractive`** — so animation needs nothing special. Candidates: a slow
      pulse on the running-agents orb, a travelling sheen on an active build bar.
      Keep it to liveness, never decoration. *Medium.*
- [ ] ✅ **C3. `@media (prefers-color-scheme: dark)` inside the SVG.** Same
      proof. Not needed while the band paints its own `BG`, but it is the route
      to true theme response if that ever changes. *Easy.*
- [ ] ✅ **C4. `isInteractive` on `Svg`.** Draws in a sandboxed script-less frame
      so `:hover` and **`<title>` tooltips** work — a real tooltip on a meter
      saying what it measures. *Medium.*
- [ ] ✅ **C5. Hover props, which cost nothing.** `BoxHoverProps` and
      `TextHoverProps` are entirely unused, and **no hook runs for a hover** —
      nothing crosses to the plugin. With `position: 'absolute'` plus
      `display: 'none'` → `hover: { display: 'flex' }` that is a hover card over
      the band for free. *Medium.*
- [ ] ✅ **C6. `gap` instead of `marginRight` on every child.** The documented
      way to space children; a graphical surface spaces Buttons itself. *Easy.*
- [ ] ⚠ **C7. Draw the band row as one SVG.** savvy-progress's approach, and its
      answer to sibling wrapping. Would also let the row use `<text>` — which
      savvy-progress does, with `font-variant-numeric: tabular-nums`. Big change:
      it gives up the surface's own font and layout. *Hard. Decide deliberately.*
- [ ] ⚠ **C8. Segmented meter variant.** 14 segments of 8 units with 13 gaps of 4
      = exactly 164, so every edge lands on an even coordinate. Countable rather
      than proportional. Costs 24% of the ink to gaps, and quantisation lies at
      the low end — "3% left" and "0% left" would look the same. *Medium, and
      probably not worth it over the continuous bar.*
- [ ] ✅ **C9. `Raster` for the terminal.** A cell grid of `[codePoint, fg, bg]`,
      repainted by `$.ui.blit` with no render pass — the terminal's answer to the
      `Svg` gap, where Tower currently falls back to dot strings. Terminal only.
      *Hard.*
- [ ] ✅ **C10. Button affordances.** `hotkey` (and **a bare digit answers a band
      Button from an empty composer** — no focus ceremony), `plain`, `variant`,
      `dimColor`, `role: 'dismiss'`, and **children** so a whole row is one
      pressable thing. *Easy each.*
- [ ] ✅ **C11. `Code` with `format: 'diff'`.** The engine's own highlighter with
      add/remove colouring — a real diff segment if B5 lands. *Medium.*
- [ ] ✅ **C12. Size to rows, not just columns.** Tower reads `bodyColumns` and
      ignores `maxRows` and `scroll`, so it cannot tell whether its tree is being
      shown whole or scrolled. `scroll` says exactly which rows are on screen.
      *Medium.*

---

## D. Features — high value, harder

- [ ] ⚠ **D1. Git branch and in-progress operation** — `main ⚠ rebase`, ~16 cols.
      **No shell needed**: `$.session.repo()` for the root, then `$.fs.read` of
      `.git/HEAD`, and `$.fs.exists` on `MERGE_HEAD`, `rebase-merge/`,
      `CHERRY_PICK_HEAD`. Refresh on `classic.CwdChanged`. Ahead/behind counts are
      **not** reachable this way — only "in sync / diverged". *Medium–hard:
      worktrees, packed-refs, submodules.*
- [ ] ⚠ **D2. Background work chip** — `bg 2 · shell, workflow`, ~16 cols.
      `classic.Stop` carries `background_tasks` and `session_crons`, exposed
      nowhere else. **Structural caveat**: `Stop` fires only at turn end and
      nothing reports a task's completion, so the chip is a turn-boundary
      snapshot and will sometimes show a task that already exited. Label it
      honestly. *Medium–hard.*
- [ ] ✅ **D3. What is eating the context** — `ctx 62% · MCP 38k` **(N)**.
      Same `breakdown: 'summary'` call as B2, then `mcpTools`, `memoryFiles`,
      `skills`. Name only the single worst offender — the whole breakdown is a
      pane, not a band. *Medium.*
- [ ] ⚠ **D4. Other live sessions sharing your window** — `3 sessions`, ~12 cols.
      Each session writes a heartbeat into `$.store` under its own session id;
      every session counts recent ones. This is the honest fix for the projection
      bug in A3. *Hard: last-writer-wins, no change notification, stale sweeping.*
- [ ] ✅ **D5. Take the engine's cache figures instead of computing them.**
      `classic.PreModelSwitch` carries `prompt_cache_warm`, `cache_ttl` and
      `estimated_cache_write_usd` — the engine's **own** re-cache cost, where
      Tower derives one from its price table. *Medium.*
- [ ] ✅ **D6. Use `$.agent.list()` as the agent roster.** The authoritative live
      list with `status` including `waiting`, covering runs Tower never saw spawn.
      Tower builds its own from `agent.spawn` hooks. *Medium.*
- [ ] ✅ **D7. Live turn phase from the `Spinner` component.** Hooking
      `ui.render` on `Spinner` gives `mode`: requesting / responding / **thinking**
      / tool-input / tool-use. Tower has only a boolean. *Medium.*
- [ ] ✅ **D8. Compaction state.** The `session.compact` event carries
      `trigger`, and **`'precompute'` warns compaction is imminent** —
      an early warning, not just an after-the-fact notice. *Medium.*
- [ ] ✅ **D9. Rate limited / overloaded, as it happens.** `classic.StopFailure`
      carries an error kind including `rate_limit` and `overloaded`. *Easy–medium.*
- [ ] ⚠ **D10. Replace marker-file polling with `classic.FileChanged`.** Tower
      polls `.buildstatus.json` every 2 seconds via `$.fs.read`. This event may
      remove the poll entirely — **verify which files the engine actually
      watches; the typings do not say.** *Medium.*
- [ ] ✅ **D11. Per-tool wall time.** `classic.PostToolUse` carries `duration_ms`,
      which `tool.call` alone does not give. Would sharpen the agents pane.
      *Easy.*

---

## E. Second surfaces — places to put things that are not the band

- [ ] ✅ **E1. `$.ui.status`** — one pinned line per plugin under the prompt,
      independent of the band and costing it no columns. *Easy.*
- [ ] ✅ **E2. `PromptHint`'s `tail`** — a writable one-line append slot under
      the prompt, drawn dim at the end of the engine's own line. *Easy.*
- [ ] ✅ **E3. `SessionMode`'s `modes`** — a hook can **add** a label to the dim
      list in the prompt footer. The cheapest way to put one word on screen.
      *Easy.*
- [ ] ✅ **E4. `$.ui.toast`** — transient alerts for a threshold crossing,
      without consuming a band row. *Easy.*

Not listed: `$.ui.notify` (OS notifications). It works, but you removed
notification features from this plugin deliberately.

---

## F. Explicitly rejected — reasons, so they stay rejected

- **A live current-tool readout** (`▸ Bash npm test`). Duplicates the engine's
  spinner, changes several times a second, and `$.ui.invalidate` is capped at
  10 redraws/second — a treadmill to show a laggy, usually-stale answer. The
  agents *pane* is the right home, which is where it already is.
- **`breakdown: 'full'`.** Makes a real token-count API call: latency and money,
  on a band that promises to cost nothing. It is the *accurate* one, which is
  the trap. Only ever `'summary'`.
- **Model name and permission-mode chips.** The engine draws the model beside
  the prompt and has a `SessionMode` component for mode labels. Effort (B4) is
  the exception because nothing else shows it.
- **Anything resembling `git status`.** Walking the worktree on a timer. B5 is
  the cheap event-driven substitute.
- **Cross-session awareness via MCP.** `list_sessions` would answer D4 directly
  and would silently do nothing in auto mode — worse than not shipping it.
- **`$.tool.register` so the model reports its own progress.** The most elegant
  code in savvy-progress, and wrong here: it costs tokens per call, depends on
  the model remembering, and contradicts Tower's one promise — that every figure
  is the engine's own.
- **Rainbow state ramps, full-pill radius on meters, visible texture, hard
  offset drop shadows, bevel-everything, outer glow instead of contrast.** All
  date a drawing instantly.
- **A test/lint status bar.** It is the build bar again. Fold it into the
  existing bar's source priority rather than stacking a second one.

---

## If you only tick three

**A1** (the ticker, which costs every idle session a redraw every 30 seconds),
**B2** (compaction distance, which also fixes a number currently wrong), and
**B1** (stalled agents, where the data is already computed and merely dropped).
All three are cheap, and two of them are fixes rather than additions.
