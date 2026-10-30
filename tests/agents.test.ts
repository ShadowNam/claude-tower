import { expect, test } from 'claude-code/testing'

import { detailOf, MAIN, totalsOf, tree } from '../hooks/core/agents'
import { shortModel, windowOf } from '../hooks/core/models'
import { costOf } from '../hooks/core/prices'

import type { AgentRun } from '../types'

const T0 = 1_800_000_000_000

const run = (over: Partial<AgentRun> & { id: string }): AgentRun => ({
  type: 'Explore',
  description: over.id,
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: T0,
  contextTokens: 0,
  contextMax: 200_000,
  isWindowKnown: true,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  steps: 0,
  lastStepAt: T0,
  toolErrors: 0,
  touched: [],
  ...over,
})

test('an unnamed model is assumed to hold the common window, and says so', async () => {
  // The mistake worth avoiding: reporting a 200K model at a fifth of its fill.
  expect(windowOf('claude-opus-5-5')).toEqual({ tokens: 200_000, isKnown: true })
  expect(windowOf('claude-sonnet-5-5')).toEqual({ tokens: 1_000_000, isKnown: true })

  const guess = windowOf('some-future-model')
  expect(guess.tokens).toBe(200_000)
  expect(guess.isKnown).toBe(false)
})

test('a model the price table does not name costs nothing it can claim', async () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  expect(costOf('claude-opus-5-5', usage)).toBe(4)
  expect(costOf('some-future-model', usage)).toBe(null)
})

test('runs nest under the loop that spawned them', async () => {
  const rows = tree([
    run({ id: MAIN, type: MAIN }),
    run({ id: 'a1', agentId: 'a1', parentId: MAIN }),
    run({ id: 'a2', agentId: 'a2', parentId: 'a1' }),
    run({ id: 'a3', agentId: 'a3', parentId: MAIN }),
  ])

  expect(rows.map(r => r.run.id).join(',')).toBe('main,a1,a2,a3')
  expect(rows.map(r => r.depth).join(',')).toBe('0,1,2,1')
})

test('a run whose parent was never seen still gets a row', async () => {
  const rows = tree([run({ id: MAIN, type: MAIN }), run({ id: 'orphan', agentId: 'orphan', parentId: 'gone' })])
  expect(rows.map(r => r.run.id).join(',')).toBe('main,orphan')
})

test('one unpriced run makes the total unknown rather than wrong', async () => {
  const totals = totalsOf(
    [run({ id: 'a1', agentId: 'a1', costUsd: 1.5 }), run({ id: 'a2', agentId: 'a2', costUsd: null })],
    T0,
  )
  expect(totals.costUsd).toBe(null)
})

test('wall time and agent time tell parallel work from serial', async () => {
  const MIN = 60_000
  // Two runs, each ten minutes, started together: twenty agent-minutes in ten.
  const together = totalsOf(
    [
      run({ id: 'a1', agentId: 'a1', startedAt: T0, endedAt: T0 + 10 * MIN, status: 'done' }),
      run({ id: 'a2', agentId: 'a2', startedAt: T0, endedAt: T0 + 10 * MIN, status: 'done' }),
    ],
    T0 + 10 * MIN,
  )
  expect(together.wallMs).toBe(10 * MIN)
  expect(together.agentMs).toBe(20 * MIN)

  // The same two, one after the other: the same agent time, twice the wall.
  const serial = totalsOf(
    [
      run({ id: 'a1', agentId: 'a1', startedAt: T0, endedAt: T0 + 10 * MIN, status: 'done' }),
      run({ id: 'a2', agentId: 'a2', startedAt: T0 + 10 * MIN, endedAt: T0 + 20 * MIN, status: 'done' }),
    ],
    T0 + 20 * MIN,
  )
  expect(serial.wallMs).toBe(20 * MIN)
  expect(serial.agentMs).toBe(20 * MIN)
})

test('the main row is counted in cost but not in the agent timings', async () => {
  const totals = totalsOf([run({ id: MAIN, type: MAIN, costUsd: 5 })], T0)
  expect(totals.costUsd).toBe(5)
  expect(totals.running).toBe(0)
  expect(totals.wallMs).toBe(0)
})

test('a row says what its tool is working on', async () => {
  expect(detailOf('Bash', { command: 'npm   run \n build' })).toBe('npm run build')
  expect(detailOf('Edit', { file_path: 'src/app.ts' })).toBe('src/app.ts')
  expect(detailOf('Grep', { pattern: 'TODO' })).toBe('TODO')
  expect(detailOf('Read', {})).toBe('')

  const long = detailOf('Bash', { command: 'x'.repeat(200) })
  expect(long.length).toBe(60)
  expect(long.endsWith('…')).toBe(true)
})

test('a model id is shortened to what fits a row', async () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5')
})
