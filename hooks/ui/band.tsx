import { totalsOf } from '../core/agents'
import { headlineOf, othersOf, viewOf } from '../core/builds'
import { at, dots, since, tokens, until, usd } from '../core/fmt'
import { CAPSULE_SIZE, capsule, MARK_SIZE, mark, ORB_SIZE, orb } from './art'
import type { Feature } from '../core/kinds'
import { rewarmCost } from '../core/prices'
import { readAgents, readBuilds, readTick, readUsage } from '../core/state'
import { cacheView, TTL_MIN } from '../core/usage'
import { BAD, BG, DIM, EMPTY, INK, OK, ORANGE, TEXT, WARN, YELLOW } from './theme'

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
    const view = wantsUsage ? cacheView(u.cache, now) : null
    const windowList = wantsUsage ? u.windows : []

    // The agents chip doubles as the panel's fallback: a pane opened unasked
    // needs room it may not get, and this row always has some.
    const agents = wantsAgents ? totalsOf(await readAgents($), now) : null
    const busy = agents !== null && agents.running > 0

    const builds = wantsBuilds ? await readBuilds($) : []
    const head = headlineOf(builds, now)
    const build = head === null ? null : viewOf(head, now)
    const chips = head === null ? [] : othersOf(builds, head, now)


    // Nothing to report from any of the four.
    const quiet = windowList.length === 0 && view === null && !busy && build === null

    // The engine hands over the context it is carrying at session.start but
    // the rate-limit windows only on a later measurement, so a fresh session
    // has figures without having windows. Drawing nothing there is what makes
    // a loaded mod look like one that never installed, so the row stays and
    // carries what is known.
    const bare = windowList.length === 0 && view === null && !busy && build === null
    const knowsLedger = u.ledger.window > 0 || u.ledger.usd !== null

    if (quiet && !(wantsUsage && knowsLedger)) return next(e)

    // Other mods' bands draw under this one. The engine's own placeholder is
    // not nestable, so it is dropped rather than wrapped.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below =
      drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // The terminal's table still lists Svg, so ask the surface, not the table.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const isWide = columns >= WIDE_AT
    const isStacked = !isWide && columns >= STACKED_AT
    const cells = isWide || isStacked ? CELLS : TIGHT_CELLS

    const label = (
      <Box key="label" flexShrink={0} marginRight={2} flexDirection="row" alignItems="center">
        {Svg === null ? null : (
          <Box marginRight={1}>
            <Svg source={mark(ORANGE)} alt="Tower" {...MARK_SIZE} />
          </Box>
        )}
        <Text color={TEXT} bold>USAGE</Text>
      </Box>
    )

    const wideWindow = (w: UsageWindow, i: number) => {
      const p = partOf(w, now, cells)
      return (
        <Box key={`w${i}`} flexDirection="row" flexShrink={0} marginRight={3}>
          <Text color={DIM} bold>{p.name} </Text>
          {Svg === null ? (
            <>
              <Text color={p.color}>{p.on}</Text>
              <Text color={EMPTY}>{p.off}</Text>
            </>
          ) : (
            <Svg source={capsule(p.left, p.color)} alt={`${p.left}% left`} {...CAPSULE_SIZE} />
          )}
          <Text color={p.color} bold> {p.left}% left</Text>
          {p.isLow ? <Text backgroundColor={BAD} color={INK} bold>{' LOW '}</Text> : null}
          {p.reset === '' ? null : <Text color={DIM}> · {p.reset}</Text>}
          {p.empty === '' ? null : <Text color={WARN} bold> · out ~{p.empty}</Text>}
        </Box>
      )
    }

    const blockWindow = (w: UsageWindow, i: number) => {
      const p = partOf(w, now, cells)
      return (
        <Box key={`w${i}`} flexDirection="column" flexShrink={0} marginRight={3}>
          <Box flexDirection="row" alignItems="center">
            <Text color={DIM} bold>{p.name} </Text>
            {Svg === null ? (
              <>
                <Text color={p.color}>{p.on}</Text>
                <Text color={EMPTY}>{p.off}</Text>
              </>
            ) : (
              <Svg source={capsule(p.left, p.color)} alt={`${p.left}% left`} {...CAPSULE_SIZE} />
            )}
          </Box>
          <Box flexDirection="row">
            <Text color={p.color} bold>{p.left}% left</Text>
            {p.isLow ? <Text backgroundColor={BAD} color={INK} bold>{' LOW '}</Text> : null}
          </Box>
          {p.reset === '' ? null : <Text color={DIM}>resets {p.reset}</Text>}
          {p.empty === '' ? null : <Text color={WARN} bold>out ~{p.empty}</Text>}
        </Box>
      )
    }

    const windows = windowList.map(isWide ? wideWindow : blockWindow)


    const crew =
      busy && agents !== null ? (
        <Box key="crew" flexDirection="row" flexShrink={0} marginRight={3} alignItems="center">
          {Svg === null ? null : <Svg source={orb(OK)} alt="warm" {...ORB_SIZE} />}
          <Text color={OK} bold> {agents.running} running</Text>
          {agents.failed > 0 ? <Text color={BAD} bold> · {agents.failed} failed</Text> : null}
          <Text color={DIM}> · {agents.costUsd === null ? '$?' : usd(agents.costUsd)}</Text>
          <Text color={DIM}> /tower-agents</Text>
        </Box>
      ) : null

    // The cache: how long it stays warm, or what re-sending the context costs.
    let cache = null
    if (view !== null) {
      if (view.mode === 'warm') {
        cache = (
          <Box key="cache" flexDirection="row" flexShrink={0} marginRight={3}>
            {Svg === null ? (
              <Text backgroundColor={OK} color={INK} bold>{' WARM '}</Text>
            ) : (
              <Box flexDirection="row" alignItems="center">
                <Svg source={orb(OK)} alt="warm" {...ORB_SIZE} />
                <Text color={OK} bold> WARM</Text>
              </Box>
            )}
            <Text color={DIM}> {Math.max(0, TTL_MIN - view.idleMin)}m left</Text>
          </Box>
        )
      } else {
        const cost = rewarmCost(view.model, view.tokens)
        cache = (
          <Box key="cache" flexDirection="row" flexShrink={0} marginRight={3}>
            {Svg === null ? (
              <Text backgroundColor={WARN} color={INK} bold>{' COLD '}</Text>
            ) : (
              <Box flexDirection="row" alignItems="center">
                <Svg source={orb(WARN)} alt="cold" {...ORB_SIZE} />
                <Text color={WARN} bold> COLD</Text>
              </Box>
            )}
            <Text color={DIM}> {since(view.idleMs)} idle</Text>
            <Text color={DIM}> · </Text>
            <Text color={TEXT} bold>{cost === null ? '$?' : usd(cost)}</Text>
            <Text color={DIM}> to re-send</Text>
          </Box>
        )
      }
    }

    // Normally a wide-terminal extra; with no windows to draw it is the row's
    // only content, so width stops deciding.
    const ctx =
      (columns >= CTX_AT || bare) && u.ledger.window > 0 ? (
        <Box key="ctx" flexDirection="row" flexShrink={0} marginRight={3}>
          <Text color={DIM}>ctx </Text>
          <Text color={TEXT}>{Math.round((u.ledger.tokens / u.ledger.window) * 100)}%</Text>
          <Text color={DIM}> of {tokens(u.ledger.window)}</Text>
        </Box>
      ) : null

    const cost =
      u.ledger.usd === null ? null : (
        <Box key="cost" flexDirection="row" flexShrink={0}>
          <Text color={TEXT} bold>{usd(u.ledger.usd)}</Text>
          <Text color={DIM}> session</Text>
        </Box>
      )

    // Said once, while the windows are still unknown: it tells the difference
    // between a mod with no news and a mod that is not there.
    const waiting = bare ? (
      <Box key="waiting" flexDirection="row" flexShrink={0} marginRight={3}>
        <Text color={DIM}>windows not measured yet · /tower</Text>
      </Box>
    ) : null

    const row = (
      <Box key="row" flexDirection="row" paddingX={1}>
        {label}
        {windows}
        {crew}
        {cache}
        {ctx}
        {cost}
        {waiting}
      </Box>
    )

    // Narrow: the cache and the cost get a line of their own under the blocks.
    // With no windows there is nothing to stack, so the one row serves at any
    // width.
    const rows =
      isWide || isStacked || bare
        ? [row]
        : [
            <Box key="row" flexDirection="row" paddingX={1}>
              {label}
              {windows}
            </Box>,
            <Box key="tail" flexDirection="row" paddingX={1}>
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
            <Text color={TEXT} bold>BUILD</Text>
          </Box>
          {b.state === 'running' ? (
            <Box flexDirection="row" flexShrink={0}>
              {bar === null ? null : <Text color={OK}>{bar.on}</Text>}
              {bar === null ? null : <Text color={EMPTY}>{bar.off}</Text>}
              {est.progress === null ? null : (
                <Text color={OK} bold> {Math.round(est.progress * 100)}%</Text>
              )}
              <Text color={est.stage === 'normal' ? TEXT : WARN} bold> {build.eta}</Text>
              <Text color={DIM}> {MARK[est.confidence] ?? ''} · {build.elapsed} elapsed</Text>
            </Box>
          ) : b.state === 'failed' ? (
            <Box flexDirection="row" flexShrink={0}>
              <Text backgroundColor={BAD} color={INK} bold>{' ✗ failed '}</Text>
              <Text color={DIM}> after {build.elapsed} · {b.tool}</Text>
            </Box>
          ) : (
            <Box flexDirection="row" flexShrink={0}>
              <Text backgroundColor={OK} color={INK} bold>{' ✓ built '}</Text>
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" backgroundColor={BG}>
          {rows}
          {buildRows}
        </Box>
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a band that fails to draw must not take the prompt with it
}
