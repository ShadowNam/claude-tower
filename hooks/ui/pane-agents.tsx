import { MAIN, PANE, runModel, STUCK_MS, totalsOf, tree } from '../core/agents'
import { since, tokens, usd } from '../core/fmt'
import type { Feature } from '../core/kinds'
import { readAgents, readPanel, readTick, readUsage, writePanel } from '../core/state'
import { CAPSULE_SIZE, capsule, ORB_SIZE, orb } from './art'
import { BAD, DIM, EMPTY, OK, TEXT, WARN } from './theme'

import type { AgentRun } from '../../types'

const BAR = 12
const GLYPH: Readonly<Record<string, string>> = { running: '●', done: '✓', failed: '✗' }
const COLOR: Readonly<Record<string, string>> = { running: OK, done: DIM, failed: BAD }

/** How full the context is, and whether that figure is known or assumed. */
function ctxOf(a: AgentRun, sessionWindow: number): { percent: number; isKnown: boolean } | null {
  const max = a.id === MAIN ? sessionWindow : a.contextMax
  if (max <= 0 || a.contextTokens <= 0) return null
  return { percent: Math.round((a.contextTokens / max) * 100), isKnown: a.isWindowKnown }
}

function bar(percent: number): { on: string; off: string } {
  const n = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)))
  return { on: '█'.repeat(n), off: '░'.repeat(BAR - n) }
}

/**
 * The agents panel: every loop in this session, nested under the loop that
 * spawned it, with what it is doing now, how full its context is, what it has
 * cost and how long it has run.
 *
 * Drawn in Box and Text rather than one drawing per row, so the surface does
 * the layout and a longer description cannot clip a row.
 */
export const registerAgentsPane: Feature = (on, options) => {
  if (options.agentsPanel !== true) return

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const list = await readAgents($)
    await readTick($)
    const panel = await readPanel($)
    const usage = await readUsage($)
    const now = await $.clock.now()

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The terminal's table still lists Svg, so ask the surface, not the table.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const totals = totalsOf(list, now)
    const rows = tree(list).filter(r => r.run.id !== MAIN || r.run.steps > 0)

    if (rows.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={DIM}>No agents have run in this session yet.</Text>
        </Box>
      )
    }

    const shown = panel.isDoneCollapsed ? rows.filter(r => r.run.status === 'running') : rows

    const header = (
      <Box key="head" flexDirection="row" paddingX={1}>
        <Text color={OK} bold>{totals.running} running</Text>
        <Text color={DIM}> · {totals.done} done</Text>
        {totals.failed > 0 ? <Text color={BAD} bold> · {totals.failed} failed</Text> : null}
        <Box flexGrow={1} />
        <Text color={TEXT} bold>{totals.costUsd === null ? '$?' : usd(totals.costUsd)}</Text>
      </Box>
    )

    const detail = (
      <Box key="detail" flexDirection="row" paddingX={1}>
        <Text color={DIM}>
          in {tokens(totals.input)} · out {tokens(totals.output)} · cache {tokens(totals.cache)}
        </Text>
      </Box>
    )

    // Wall time against summed agent time says whether the fan-out was real.
    const parallel =
      totals.wallMs > 0 && totals.agentMs > 0 ? (totals.agentMs / totals.wallMs).toFixed(1) : null
    const timing =
      totals.wallMs > 0 ? (
        <Box key="timing" flexDirection="row" paddingX={1}>
          <Text color={DIM}>
            wall {since(totals.wallMs)} · agents {since(totals.agentMs)}
          </Text>
          {parallel === null ? null : <Text color={DIM}> ({parallel}× parallel)</Text>}
        </Box>
      ) : null

    const controls = (
      <Box key="controls" flexDirection="row" paddingX={1}>
        <Button
          key="compact"
          label={panel.isCompact ? 'Expand' : 'Compact'}
          onPress={() => {
            void writePanel($, prev => ({ ...prev, isCompact: !prev.isCompact }))
          }}
        />
        <Text> </Text>
        <Button
          key="done"
          label={panel.isDoneCollapsed ? 'Show finished' : 'Hide finished'}
          onPress={() => {
            void writePanel($, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))
          }}
        />
      </Box>
    )

    const draw = (run: AgentRun, depth: number, i: number) => {
      const pad = '  '.repeat(Math.min(depth, 4))
      const elapsed = since((run.endedAt ?? now) - run.startedAt)
      const ctx = ctxOf(run, usage.ledger.window)
      const isStuck =
        run.status === 'running' && run.tool === undefined && now - run.lastStepAt > STUCK_MS && run.steps > 0

      const title = (
        <Box key={`t${i}`} flexDirection="row" alignItems="center">
          <Text color={DIM}>{pad}</Text>
          {Svg === null ? (
            <Text color={COLOR[run.status] ?? TEXT}>{GLYPH[run.status] ?? '●'} </Text>
          ) : (
            <Box marginRight={1}>
              <Svg source={orb(COLOR[run.status] ?? TEXT)} alt={run.status} {...ORB_SIZE} />
            </Box>
          )}
          <Text color={TEXT} wrap="truncate-end">{run.id === MAIN ? 'this session' : run.description}</Text>
          <Box flexGrow={1} />
          <Text color={DIM}>{runModel(run)}</Text>
        </Box>
      )

      if (panel.isCompact) return [title]

      const stats = (
        <Box key={`s${i}`} flexDirection="row" alignItems="center">
          <Text color={DIM}>{pad}  </Text>
          {ctx === null || Svg !== null ? null : <Text color={COLOR[run.status] ?? TEXT}>{bar(ctx.percent).on}</Text>}
          {ctx === null || Svg !== null ? null : <Text color={EMPTY}>{bar(ctx.percent).off}</Text>}
          {ctx === null || Svg === null ? null : (
            <Svg source={capsule(ctx.percent, COLOR[run.status] ?? TEXT)} alt={`context ${ctx.percent}%`} {...CAPSULE_SIZE} />
          )}
          {ctx === null ? null : (
            <Text color={ctx.percent >= 90 ? WARN : DIM}>
              {' '}ctx {ctx.isKnown ? '' : '~'}{ctx.percent}%
            </Text>
          )}
          <Text color={DIM}> · {run.costUsd === null ? '$?' : usd(run.costUsd)} · {elapsed}</Text>
          {run.toolErrors > 0 ? <Text color={BAD}> · {run.toolErrors} tool errors</Text> : null}
        </Box>
      )

      // What it is doing right now, or why it stopped.
      const activity =
        run.status === 'failed' && run.reason !== undefined ? (
          <Box key={`a${i}`} flexDirection="row">
            <Text color={DIM}>{pad}  </Text>
            <Text color={BAD}>stopped: {run.reason}</Text>
          </Box>
        ) : isStuck ? (
          <Box key={`a${i}`} flexDirection="row">
            <Text color={DIM}>{pad}  </Text>
            <Text color={WARN}>no request for {since(now - run.lastStepAt)}</Text>
          </Box>
        ) : run.tool !== undefined ? (
          <Box key={`a${i}`} flexDirection="row">
            <Text color={DIM}>{pad}  </Text>
            <Text color={TEXT}>{'▸'} {run.tool}</Text>
            {run.toolDetail === undefined || run.toolDetail === '' ? null : (
              <Text color={DIM} wrap="truncate-end"> {run.toolDetail}</Text>
            )}
          </Box>
        ) : run.touched.length > 0 ? (
          <Box key={`a${i}`} flexDirection="row">
            <Text color={DIM}>{pad}  {run.touched.length} files touched</Text>
          </Box>
        ) : null

      return [title, stats, activity]
    }

    return (
      <Box flexDirection="column">
        {header}
        {detail}
        {timing}
        <Box key="rows" flexDirection="column" paddingX={1}>
          {shown.flatMap((r, i) => draw(r.run, r.depth, i))}
        </Box>
        {controls}
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a pane whose tree fails to validate is closed; never risk it
}
