import { expect, test } from 'claude-code/testing'

import { alertsOf, instanceOf, isBusy, jsonOf, mergeAlerts, queueProgress, serversOf } from '../hooks/core/tank'

import type { TankInstance } from '../types'

const T0 = 1_800_000_000_000

/** What tank_overview answers, trimmed to the shape the panel reads. */
const OVERVIEW = {
  active: [{ id: 'a12eaaee', title: 'working rules', status: 'running', updated: '13m ago', project: 'web-app' }],
  waiting_for_user: [{ id: 'bb11', title: 'which approach?', status: 'awaiting_input', updated: '2m ago', project: 'api' }],
  failed_last_24h: [],
  build_queues: [
    { project: 'game', state: 'done', items: { done: 9, failed: 1, pending: 4 }, now_or_next: 'Q10: sim core' },
    // Tank leaves a count out entirely when it is zero.
    { project: 'designer', state: 'idle', items: { pending: 4 } },
  ],
}

test('an answer is read whether it comes structured or as text', async () => {
  expect(jsonOf({ structuredContent: { a: 1 } })).toEqual({ a: 1 })
  expect(jsonOf({ content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 2 })
  // A block that is not JSON does not stop the next one being read.
  expect(jsonOf({ content: [{ text: 'not json' }, { text: '{"a":3}' }] })).toEqual({ a: 3 })
  expect(jsonOf({ content: [] })).toBe(null)
  expect(jsonOf(null)).toBe(null)
})

test('an overview becomes an instance, with the missing counts read as zero', async () => {
  const i = instanceOf('tank', OVERVIEW, T0)
  expect(i.ok).toBe(true)
  expect(i.active.length).toBe(1)
  expect(i.waiting[0]?.project).toBe('api')
  expect(i.queues[0]?.done).toBe(9)
  expect(i.queues[1]?.done).toBe(0)
  expect(i.queues[1]?.failed).toBe(0)
  expect(i.queues[1]?.pending).toBe(4)
  expect(isBusy(i)).toBe(true)
})

test('a queue is as far along as the items it has resolved', async () => {
  // Nine done and one failed out of fourteen: ten resolved.
  expect(queueProgress({ project: 'p', state: 'done', done: 9, failed: 1, pending: 4 })).toBe(10 / 14)
  expect(queueProgress({ project: 'p', state: 'idle', done: 0, failed: 0, pending: 0 })).toBe(null)
})

test('what needs a person is told apart from what merely broke', async () => {
  const good = instanceOf('tank', OVERVIEW, T0)
  const down: TankInstance = {
    name: 'maxi',
    ok: false,
    error: 'did not answer',
    active: [],
    waiting: [],
    failed: [],
    queues: [],
    checkedAt: T0,
  }

  const alerts = alertsOf([good, down], T0)
  expect(alerts.filter(a => a.kind === 'waiting').length).toBe(1)
  expect(alerts.filter(a => a.kind === 'unreachable').length).toBe(1)
  // An unreachable box says nothing about its tasks, so none are claimed.
  expect(alerts.filter(a => a.instance === 'maxi' && a.kind !== 'unreachable').length).toBe(0)
})

test('an alert already seen stays seen, and keeps when it first appeared', async () => {
  const first = alertsOf([instanceOf('tank', OVERVIEW, T0)], T0)
  const acknowledged = first.map(a => ({ ...a, seen: true }))
  const later = alertsOf([instanceOf('tank', OVERVIEW, T0 + 60_000)], T0 + 60_000)

  const merged = mergeAlerts(acknowledged, later)
  expect(merged[0]?.seen).toBe(true)
  expect(merged[0]?.at).toBe(T0)
})

test('the instances to watch are read from the config either way round', async () => {
  expect(serversOf({ tankServers: ['tank', 'maxi'] })).toEqual(['tank', 'maxi'])
  expect(serversOf({ tankServers: 'tank, tank-prod' })).toEqual(['tank', 'tank-prod'])
  expect(serversOf({})).toEqual([])
})
