import { PANE, totalsOf } from '../core/agents'
import { headlineOf, othersOf, viewOf } from '../core/builds'
import { at, dots, since, tokens, until, usd } from '../core/fmt'
import { CAPSULE_SIZE, capsule, MARK_SIZE, mark, ORB_SIZE, orb } from './art'
import type { Feature } from '../core/kinds'
import { rewarmCost } from '../core/prices'
import { heaviestOf } from '../core/engine'
import { FAULT_MS, faultWord } from '../core/shape'
import { readAgents, readBuilds, readEdits, readPlan, readShape, readTick, readUsage } from '../core/state'
import { cacheView, headroom, TTL_MIN } from '../core/usage'
import { BAD, BG, COLD, DIM, EMPTY, INK, OK, ORANGE, TEXT, WARN, YELLOW } from './theme'

import type { UsageWindow } from '../../types'

/** Everything on one row. */
const WIDE_AT = 110
/** Each window as a small block of its own. */
const STACKED_AT = 72
/** How much of the context window is worth a word. */
const CTX_AT = 130
/** Below this much left, the window says so loudly. */
const LOW_AT = 15

const CELLS = 10
const TIGHT_CELLS = 6

const NAMES: Readonly<Record<string, string>> = {
  seven_day: '7D',
  five_hour: '5H',
  spend_limit: 'SPEND',
}

const COLORS: Readonly<Record<string, string>> = {
  seven_day: ORANGE,
  five_hour: YELLOW,
}

/** How sure the estimate is, said in a mark as well as in its precision. */
const MARK: Readonly<Record<string, string>> = {
  high: '◆',
  medium: '◈',
  low: '◇',
}

type Part = {
  left: number
  name: string
  color: string
  on: string
  off: string
  reset: string
  empty: string
  isLow: boolean
}

function partOf(w: UsageWindow, now: number, cells: number): Part {
  const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
  const bar = dots(left, cells)
  return {
    left,
    name: NAMES[w.kind] ?? w.kind.toUpperCase(),
    color: COLORS[w.kind] ?? TEXT,
    on: bar.on,
    off: bar.off,
    reset: until(w.resetsAt, now),
    empty: w.emptyAt === null ? '' : at(w.emptyAt),
    isLow: left < LOW_AT,
  }
}

/**
 * The usage band: how much of each window is left, when each resets, whether
 * the window is on course to run out before it does, whether the prompt cache
 * is warm, and what the engine says the session has cost.
 *
 * Every figure is the engine's own. The band reads and draws, so it costs
 * nothing to run and nothing to keep open.
 */
export const registerBand: Feature = (on, options) => {
  const wantsUsage = options.usageBand === true
  const wantsAgents = options.agentsPanel === true
  const wantsBuilds = options.buildBar === true
  if (!wantsUsage && !wantsAgents && !wantsBuilds) return

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const u = await readUsage($)
    // Reading the ticker makes this draw a reader of it, so each bump redraws.
    await readTick($)

    const now = await $.clock.now()
    const view = wantsUsage ? cacheView(u.cache, now, u.cacheTtlMs) : null
    const windowList = wantsUsage ? u.windows : []

    // The agents chip doubles as the panel's fallback: a pane opened unasked
    // needs room it may not get, and this row always has some.
    const agents = wantsAgents ? totalsOf(await readAgents($), now) : null
    const busy = agents !== null && agents.running > 0

    const edits = wantsUsage ? await readEdits($) : null
    const shape = wantsUsage ? await readShape($) : null
    const fault =
      shape?.fault != null && now - shape.fault.at < FAULT_MS ? faultWord(shape.fault.kind) : null

    const plan = wantsUsage ? await readPlan($) : null
    const builds = wantsBuilds ? await readBuilds($) : []
    const head = headlineOf(builds, now)
    const build = head === null ? null : viewOf(head, now)
    const chips = head === null ? [] : othersOf(builds, head, now)


    // Nothing to report from any of the four.
    const hasEdits = edits !== null && edits.files.length > 0
    const quiet =
      windowList.length === 0 && view === null && !busy && build === null && fault === null

    // The engine hands over the context it is carrying at session.start but
    // the rate-limit windows only on a later measurement, so a fresh session
    // has figures without having windows. Drawing nothing there is what makes
    // a loaded mod look like one that never installed, so the row stays and
    // carries what is known.
    const bare = windowList.length === 0 && view === null && !busy && build === null
    const knowsLedger = u.ledger.window > 0 || u.ledger.usd !== null

    // Against the window compaction measures, where the engine has named one:
    // it may be smaller than the model's, and the smaller one is what fires.
    const ctxMax = u.compaction?.max ?? u.ledger.window
    const ctxUsed = u.compaction?.used ?? u.ledger.tokens
    const ctxPercent = ctxMax > 0 ? Math.round((ctxUsed / ctxMax) * 100) : null
    const left = headroom(u.compaction)
    // Named only when one non-conversation thing is a real share of the
    // window: "something is using 400 tokens" is not worth a column.
    const heavy = heaviestOf(u.compaction?.breakdown)
    const hog = heavy !== null && ctxMax > 0 && heavy.tokens / ctxMax > 0.12 ? heavy : null

    if (quiet && !(wantsUsage && knowsLedger)) return next(e)

    // Other mods' bands draw under this one. The engine's own placeholder is
    // not nestable, so it is dropped rather than wrapped.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below =
      drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The terminal's table still lists Svg, so ask the surface, not the table.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    // What the band may take before the engine starts scrolling it. The build
    // rows and the plan row are the ones that can be given up.
    const maxRows = typeof e.props.maxRows === 'number' && e.props.maxRows > 0 ? e.props.maxRows : 99
    const isWide = columns >= WIDE_AT
    const isStacked = !isWide && columns >= STACKED_AT
    const cells = isWide || isStacked ? CELLS : TIGHT_CELLS

    const label = (
      <Box key="label" flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
        {Svg === null ? null : (
          <Box marginRight={1}>
            <Svg source={mark(ORANGE)} alt="Tower" {...MARK_SIZE} />
          </Box>
        )}
        <Text color={TEXT} weight="bold">USAGE</Text>
      </Box>
    )

    const wideWindow = (w: UsageWindow, i: number) => {
      const p = partOf(w, now, cells)
      return (
        <Box key={`w${i}`} flexDirection="row" flexShrink={0}>
          <Text color={DIM} weight="bold">{p.name} </Text>
          {Svg === null ? (
            <>
              <Text color={p.color}>{p.on}</Text>
              <Text color={EMPTY}>{p.off}</Text>
            </>
          ) : (
            <Svg source={capsule(p.left, p.color, `${p.name}: ${p.left}% left${p.reset === '' ? '' : `, ${p.reset}`}`)} alt={`${p.left}% left`} {...CAPSULE_SIZE} />
          )}
          <Text color={p.color} weight="bold" tabular> {p.left}% left</Text>
          {p.isLow ? <Text backgroundColor={BAD} color={INK} weight="bold">{' LOW '}</Text> : null}
          {p.reset === '' ? null : <Text color={DIM}> · {p.reset}</Text>}
          {p.empty === '' ? null : <Text color={WARN} weight="bold"> · out ~{p.empty}</Text>}
          {/* Drawn over the row rather than in it, so hovering moves nothing. */}
          <Box
            position="absolute"
            top={1}
            left={0}
            display="none"
            hover={{ scope: `w${i}`, display: 'flex' }}
            flexDirection="column"
            paddingX={1}
            borderStyle="round"
            borderColor={p.color}
            backgroundColor={BG}
          >
            <Text color={p.color} weight="bold">{p.name} · {Math.round(w.percentUsed)}% used</Text>
            {p.reset === '' ? null : <Text color={DIM}>resets {p.reset}</Text>}
            <Text color={p.empty === '' ? DIM : WARN}>
              {p.empty === '' ? 'not on course to run out' : `on course to run out ~${p.empty}`}
            </Text>
          </Box>
        </Box>
      )
    }

    const blockWindow = (w: UsageWindow, i: number) => {
      const p = partOf(w, now, cells)
      return (
        <Box key={`w${i}`} flexDirection="column" flexShrink={0}>
          <Box flexDirection="row" alignItems="center">
            <Text color={DIM} weight="bold">{p.name} </Text>
            {Svg === null ? (
              <>
                <Text color={p.color}>{p.on}</Text>
                <Text color={EMPTY}>{p.off}</Text>
              </>
            ) : (
              <Svg source={capsule(p.left, p.color, `${p.name}: ${p.left}% left${p.reset === '' ? '' : `, ${p.reset}`}`)} alt={`${p.left}% left`} {...CAPSULE_SIZE} />
            )}
          </Box>
          <Box flexDirection="row">
            <Text color={p.color} weight="bold" tabular>{p.left}% left</Text>
            {p.isLow ? <Text backgroundColor={BAD} color={INK} weight="bold">{' LOW '}</Text> : null}
          </Box>
          {p.reset === '' ? null : <Text color={DIM}>resets {p.reset}</Text>}
          {p.empty === '' ? null : <Text color={WARN} weight="bold">out ~{p.empty}</Text>}
        </Box>
      )
    }

    const windows = windowList.map(isWide ? wideWindow : blockWindow)


    // A press is a later event, not part of this draw, so it may do what a
    // render may not.
    const openAgents = () => {
      void $.ui.open({ id: PANE, title: 'Tower agents' })
    }

    const crew =
      busy && agents !== null ? (
        <Box key="crew" flexDirection="row" flexShrink={0} alignItems="center">
          {Svg === null ? null : (
            <Svg source={orb(agents.failed > 0 ? BAD : agents.stalled > 0 ? WARN : OK, agents.failed > 0 ? 'alert' : 'round', agents.stalled === 0)} alt="running" {...ORB_SIZE} />
          )}
          <Text color={OK} weight="bold"> {agents.running} running</Text>
          {agents.stalled > 0 ? (
            <Text color={WARN} weight="bold" tabular> · {agents.stalled} stalled {since(agents.stalledMs)}</Text>
          ) : null}
          {agents.failed > 0 ? <Text color={BAD} weight="bold"> · {agents.failed} failed</Text> : null}
          <Text color={DIM}> · {agents.costUsd === null ? '$?' : usd(agents.costUsd)}</Text>
          <Button key="open-agents" hotkey="1" plain dimColor onPress={openAgents}>
            <Text dimColor>/tower-agents</Text>
          </Button>
        </Box>
      ) : null

    // The cache: how long it stays warm, or what re-sending the context costs.
    let cache = null
    if (view !== null) {
      if (view.mode === 'warm') {
        cache = (
          <Box key="cache" flexDirection="row" flexShrink={0}>
            {Svg === null ? (
              <Text backgroundColor={OK} color={INK} weight="bold">{' WARM '}</Text>
            ) : (
              <Box flexDirection="row" alignItems="center">
                <Svg source={orb(OK)} alt="warm" {...ORB_SIZE} />
                <Text color={OK} weight="bold"> WARM</Text>
              </Box>
            )}
            <Text color={DIM} tabular> {view.leftMin}m left{u.isTtlLearned === true ? '' : '?'}</Text>
          </Box>
        )
      } else {
        // The engine's own estimate where it has given one; ours otherwise.
        const cost = u.rewarmUsd ?? rewarmCost(view.model, view.tokens)
        cache = (
          <Box key="cache" flexDirection="row" flexShrink={0}>
            {Svg === null ? (
              <Text backgroundColor={COLD} color={INK} weight="bold">{' COLD '}</Text>
            ) : (
              <Box flexDirection="row" alignItems="center">
                <Svg source={orb(COLD)} alt="cold" {...ORB_SIZE} />
                <Text color={COLD} weight="bold"> COLD</Text>
              </Box>
            )}
            <Text color={DIM} tabular> {since(view.idleMs)} idle</Text>
            <Text color={DIM}> · </Text>
            <Text color={TEXT} weight="bold" tabular>{cost === null ? '$?' : usd(cost)}</Text>
            <Text color={DIM}> to re-send</Text>
          </Box>
        )
      }
    }

    // Normally a wide-terminal extra; with no windows to draw it is the row's
    // only content, so width stops deciding.
    const ctx =
      (columns >= CTX_AT || bare) && ctxPercent !== null ? (
        <Box key="ctx" flexDirection="row" flexShrink={0}>
          <Text color={DIM}>ctx </Text>
          <Text color={ctxPercent >= 90 ? WARN : TEXT} tabular>{ctxPercent}%</Text>
          {left === null ? (
            <Text color={DIM}> of {tokens(u.compaction?.max ?? u.ledger.window)}</Text>
          ) : (
            <Text color={DIM}> · compact in ~{tokens(left)}</Text>
          )}
        </Box>
      ) : null

    const cost =
      u.ledger.usd === null ? null : (
        <Box key="cost" flexDirection="row" flexShrink={0}>
          <Text color={TEXT} weight="bold" tabular>{usd(u.ledger.usd)}</Text>
          <Text color={DIM}> session</Text>
        </Box>
      )

    // Said once, while the windows are still unknown: it tells the difference
    // between a mod with no news and a mod that is not there.
    const waiting = bare ? (
      <Box key="waiting" flexDirection="row" flexShrink={0}>
        <Text color={DIM}>windows not measured yet · /tower</Text>
      </Box>
    ) : null

    // A failed turn outranks everything: the session stopped, and nothing
    // else on screen says why.
    const alarm =
      fault === null ? null : (
        <Box key="fault" flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
          {Svg === null ? null : <Svg source={orb(BAD, 'alert')} alt="failed" {...ORB_SIZE} />}
          <Text backgroundColor={BAD} color={INK} weight="bold">{` ${fault.toUpperCase()} `}</Text>
        </Box>
      )

    const compacting =
      shape?.compacting == null ? null : (
        <Box key="compacting" flexShrink={0}>
          <Text color={WARN} weight="bold">
            {shape.compacting === 'soon' ? 'COMPACTING SOON' : 'COMPACTING'}
          </Text>
        </Box>
      )

    // A turn-boundary snapshot, so it says bg and a count rather than
    // claiming anything is definitely still running.
    const bg = shape?.background ?? null
    const bgChip =
      bg === null ? null : (
        <Box key="bg" flexDirection="row" flexShrink={0}>
          {bg.count > 0 ? <Text color={DIM}>bg </Text> : null}
          {bg.count > 0 ? <Text color={TEXT} tabular>{bg.count}</Text> : null}
          {bg.count > 0 && bg.kinds.length > 0 ? <Text color={DIM}> {bg.kinds.join(', ')}</Text> : null}
          {bg.scheduled > 0 ? (
            <Text color={DIM}>{bg.count > 0 ? ' · ' : ''}{bg.scheduled} scheduled</Text>
          ) : null}
        </Box>
      )

    const repo = shape?.repo ?? null
    const repoChip =
      repo === null ? null : (
        <Box key="repo" flexDirection="row" flexShrink={0} alignItems="center">
          {repo.midway === null ? null : (
            <Text backgroundColor={WARN} color={INK} weight="bold">{` ${repo.midway.toUpperCase()} `}</Text>
          )}
          <Text
            color={repo.midway !== null ? WARN : repo.isProtected ? YELLOW : DIM}
            weight={repo.isProtected || repo.midway !== null ? 'bold' : 'regular'}
            wrap="truncate-end"
          >
            {repo.midway === null ? '' : ' '}
            {repo.isDetached ? `detached ${repo.branch}` : repo.branch}
          </Text>
          {repo.sync === 'diverged' ? <Text color={DIM}> ↕</Text> : null}
        </Box>
      )

    const sessionsChip =
      shape?.sessions === undefined || shape.sessions < 2 ? null : (
        <Box key="sessions" flexDirection="row" flexShrink={0}>
          <Text color={TEXT} tabular>{shape.sessions}</Text>
          <Text color={DIM}> sessions</Text>
        </Box>
      )

    const phaseChip =
      shape?.phase === undefined || !busy ? null : (
        <Box key="phase" flexShrink={0}>
          <Text color={DIM}>{shape.phase}</Text>
        </Box>
      )

    const slowChip =
      shape?.rate == null || !shape.rate.isSlow || shape.rate.perSecond === null ? null : (
        <Box key="slow" flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
          <Text backgroundColor={WARN} color={INK} weight="bold">{' API SLOW '}</Text>
          <Text color={DIM} tabular>{Math.round(shape.rate.perSecond)} tok/s</Text>
        </Box>
      )

    const effortChip =
      shape?.effort === undefined || shape.effort === '' || shape.effort === 'medium' ? null : (
        <Box key="effort" flexShrink={0}>
          <Text color={DIM}>{shape.effort}</Text>
        </Box>
      )

    const editChip =
      !hasEdits || edits === null ? null : (
        <Box key="edits" flexDirection="row" flexShrink={0}>
          <Text color={DIM}>edits </Text>
          <Text color={TEXT} tabular>{edits.files.length}</Text>
          <Text color={DIM}> {edits.files.length === 1 ? 'file' : 'files'} </Text>
          <Text color={OK} tabular>+{edits.added}</Text>
          <Text color={BAD} tabular> −{edits.removed}</Text>
        </Box>
      )

    const row = (
      <Box key="row" flexDirection="row" paddingX={1} gap={3} alignItems="center">
        {alarm}
        {compacting}
        {slowChip}
        {label}
        {windows}
        {crew}
        {cache}
        {ctx}
        {hog === null ? null : (
          <Box key="hog" flexDirection="row" flexShrink={0}>
            <Text color={WARN} tabular>{tokens(hog.tokens)}</Text>
            <Text color={DIM} wrap="truncate-end"> {hog.name}</Text>
          </Box>
        )}
        {editChip}
        {bgChip}
        {cost}
        {sessionsChip}
        {repoChip}
        {effortChip}
        {phaseChip}
        {waiting}
      </Box>
    )

    const planRow =
      plan === null || plan.total === 0 || plan.finished ? null : (
        <Box key="plan" flexDirection="row" paddingX={1} gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Text color={TEXT} weight="bold">PLAN</Text>
          </Box>
          {Svg === null ? null : (
            <Svg
              source={capsule((plan.done / plan.total) * 100, YELLOW, `${plan.done} of ${plan.total} done`)}
              alt={`${plan.done} of ${plan.total}`}
              {...CAPSULE_SIZE}
            />
          )}
          <Text color={YELLOW} weight="bold" tabular>{plan.done}/{plan.total}</Text>
          {plan.now === '' ? null : <Text color={DIM} wrap="truncate-end"> · {plan.now}</Text>}
        </Box>
      )

    // Narrow: the cache and the cost get a line of their own under the blocks.
    // With no windows there is nothing to stack, so the one row serves at any
    // width.
    const rows =
      isWide || isStacked || bare
        ? [row]
        : [
            <Box key="row" flexDirection="row" paddingX={1} gap={3} alignItems="center">
              {label}
              {windows}
            </Box>,
            <Box key="tail" flexDirection="row" paddingX={1} gap={3} alignItems="center">
                    {crew}
              {cache}
              {cost}
            </Box>,
          ]

    // The build takes rows of its own under the usage row: one state line,
    // and one naming what is being built. Never more than one build at a
    // time — several stacked bars is what gets a band dismissed.
    const buildRows: unknown[] = []
    if (build !== null) {
      const b = build.build
      const est = build.estimate
      const bar = est.progress === null ? null : dots(est.progress * 100, 12)
      const faster =
        b.state === 'succeeded' && est.baselineMs !== null && b.endedAt !== undefined
          ? est.baselineMs - (b.endedAt - b.startedAt)
          : null

      buildRows.push(
        <Box key="build" flexDirection="row" paddingX={1}>
          <Box flexShrink={0} marginRight={2}>
            <Text color={TEXT} weight="bold">BUILD</Text>
          </Box>
          {b.state === 'running' ? (
            <Box flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
              {est.progress === null || Svg === null ? (
                <>
                  {bar === null ? null : <Text color={OK}>{bar.on}</Text>}
                  {bar === null ? null : <Text color={EMPTY}>{bar.off}</Text>}
                </>
              ) : (
                <Svg
                  source={capsule(est.progress * 100, OK, `${b.project}: ${build.eta}`, true)}
                  alt={`${Math.round(est.progress * 100)}% built`}
                  {...CAPSULE_SIZE}
                />
              )}
              {est.progress === null ? null : (
                <Text color={OK} weight="bold" tabular>{Math.round(est.progress * 100)}%</Text>
              )}
              <Text color={est.stage === 'normal' ? TEXT : WARN} weight="bold"> {build.eta}</Text>
              <Text color={DIM}> {MARK[est.confidence] ?? ''} · {build.elapsed} elapsed</Text>
            </Box>
          ) : b.state === 'failed' ? (
            <Box flexDirection="row" flexShrink={0}>
              <Text backgroundColor={BAD} color={INK} weight="bold">{' ✗ failed '}</Text>
              <Text color={DIM}> after {build.elapsed} · {b.tool}</Text>
            </Box>
          ) : (
            <Box flexDirection="row" flexShrink={0}>
              <Text backgroundColor={OK} color={INK} weight="bold">{' ✓ built '}</Text>
              <Text color={DIM}> in {build.elapsed}</Text>
              {faster !== null && Math.abs(faster) > 2_000 ? (
                <Text color={DIM}> · {since(Math.abs(faster))} {faster > 0 ? 'faster' : 'slower'} than usual</Text>
              ) : null}
            </Box>
          )}
          <Box flexGrow={1} />
          {chips.length > 0 ? <Text color={DIM}>+{chips.length} more</Text> : null}
        </Box>,
      )

      buildRows.push(
        <Box key="build-id" flexDirection="row" paddingX={1}>
          <Box flexShrink={0} marginRight={2}>
            <Text> </Text>
          </Box>
          <Text color={DIM} wrap="truncate-end">
            {build.title} · {b.target}
            {b.step === undefined ? '' : ` · ${'▸'} ${b.step}`}
          </Text>
        </Box>,
      )

      if (b.state === 'failed' && b.errorLine !== undefined && b.errorLine !== '') {
        buildRows.push(
          <Box key="build-err" flexDirection="row" paddingX={1}>
            <Box flexShrink={0} marginRight={2}>
              <Text> </Text>
            </Box>
            <Text color={BAD} wrap="truncate-end">{b.errorLine}</Text>
          </Box>,
        )
      }
    }

    // The engine scrolls a tree taller than the band's slot, which hides the
    // very rows that were added to be seen. So the optional rows are dropped
    // from the bottom until what is left fits.
    const optional: unknown[] = [...buildRows]
    if (planRow !== null) optional.push(planRow)
    const roomLeft = Math.max(0, maxRows - rows.length)
    const kept = optional.slice(0, roomLeft)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" backgroundColor={BG}>
          {rows}
          {kept}
        </Box>
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a band that fails to draw must not take the prompt with it
}
