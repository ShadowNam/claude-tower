import { dots, since } from '../core/fmt'
import type { Feature } from '../core/kinds'
import { readTank, readTick, writeTank } from '../core/state'
import { isBusy, PANE, queueProgress } from '../core/tank'
import { BAD, DIM, EMPTY, OK, TEXT, WARN } from './theme'

import type { TankInstance } from '../../types'

/**
 * The Tank panel: what each instance is doing, what is waiting on a person,
 * what failed, and how far the build queues are.
 *
 * Tank reports times as words ("13m ago") rather than as timestamps, so
 * nothing here computes an age from them. Elapsed figures come from when
 * Tower itself last saw a thing, which is a fact it owns.
 */
export const registerTankPane: Feature = (on, options) => {
  if (options.tankPanel !== true) return

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const tank = await readTank($)
    await readTick($)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    if (tank.instances.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={DIM}>Waiting for the first answer from Tank.</Text>
        </Box>
      )
    }

    const line = (i: TankInstance) => {
      const busy = isBusy(i)
      const task = i.active[0]
      const pending = i.queues.reduce((sum, q) => sum + q.pending, 0)
      return (
        <Box key={`i-${i.name}`} flexDirection="row">
          <Box width={12} flexShrink={0}>
            <Text color={TEXT} bold wrap="truncate-end">{i.name}</Text>
          </Box>
          {!i.ok ? (
            <Text color={BAD}>{'●'} {i.error ?? 'unreachable'}</Text>
          ) : busy ? (
            <Box flexDirection="row">
              <Text color={OK}>{'●'} busy</Text>
              {task === undefined ? null : (
                <Text color={DIM} wrap="truncate-end"> · {task.project} · {task.title}</Text>
              )}
            </Box>
          ) : (
            <Text color={DIM}>{'○'} idle</Text>
          )}
          <Box flexGrow={1} />
          {pending > 0 ? <Text color={DIM}>{pending} queued</Text> : null}
        </Box>
      )
    }

    const waiting = tank.instances.flatMap(i => i.waiting.map(t => ({ i, t })))
    const failed = tank.instances.flatMap(i => i.failed.map(t => ({ i, t })))
    const queues = tank.instances.flatMap(i => i.queues.filter(q => q.pending + q.done + q.failed > 0))

    const section = (title: string, color: string, rows: unknown[]) =>
      rows.length === 0
        ? null
        : [
            <Box key={`h-${title}`} flexDirection="row" marginTop={1}>
              <Text color={color} bold>{title}</Text>
            </Box>,
            ...rows,
          ]

    const oldest = tank.instances.reduce((at, i) => Math.min(at, i.checkedAt), now)

    return (
      <Box flexDirection="column" paddingX={1}>
        {tank.instances.map(line)}

        {section(
          'NEEDS YOU',
          WARN,
          waiting.map(({ i, t }) => (
            <Box key={`w-${t.id}`} flexDirection="row">
              <Text color={DIM}>{i.name} · </Text>
              <Text color={TEXT} wrap="truncate-end">{t.project}: {t.title}</Text>
            </Box>
          )),
        )}

        {section(
          'FAILED IN THE LAST DAY',
          BAD,
          failed.map(({ i, t }) => (
            <Box key={`f-${t.id}`} flexDirection="row">
              <Text color={DIM}>{i.name} · </Text>
              <Text color={TEXT} wrap="truncate-end">{t.project}: {t.title}</Text>
            </Box>
          )),
        )}

        {section(
          'QUEUES',
          DIM,
          queues.map((q, n) => {
            const p = queueProgress(q)
            const bar = p === null ? null : dots(p * 100, 10)
            return (
              <Box key={`q-${n}`} flexDirection="row">
                <Box width={16} flexShrink={0}>
                  <Text color={TEXT} wrap="truncate-end">{q.project}</Text>
                </Box>
                {bar === null ? null : <Text color={OK}>{bar.on}</Text>}
                {bar === null ? null : <Text color={EMPTY}>{bar.off}</Text>}
                <Text color={DIM}> {q.done} done</Text>
                {q.failed > 0 ? <Text color={BAD}> {q.failed} failed</Text> : null}
                {q.pending > 0 ? <Text color={DIM}> {q.pending} pending</Text> : null}
              </Box>
            )
          }),
        )}

        <Box key="foot" flexDirection="row" marginTop={1}>
          <Text color={DIM}>checked {since(now - oldest)} ago</Text>
          <Box flexGrow={1} />
          <Button
            key="seen"
            label="Mark seen"
            onPress={() => {
              void writeTank($, prev => ({ ...prev, alerts: prev.alerts.map(a => ({ ...a, seen: true })) }))
            }}
          />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a pane whose tree fails to validate is closed; never risk it
}
