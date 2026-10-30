import type { EngineInterface } from 'claude-code'

import type { Feature, Options } from './kinds'
import { notify } from './notify'
import { readTank, writeTank } from './state'
import { runWatchdog } from './watchdog'

import type { Tank, TankAlert, TankInstance, TankQueue, TankTask } from '../../types'

/**
 * Tank, watched from inside the session.
 *
 * `$.mcp.call` dials a connected MCP server with the engine's own credentials
 * and no permission prompt, so the panel polls Tank directly: no model turn,
 * no tokens spent, and no need for the plugin to hold any of Tank's bearer
 * tokens itself. That last point is why this goes through MCP rather than
 * Tank's HTTP API, which would need credentials the mod has no business
 * reading out of a config file.
 */

export const PANE = 'tower-tank'
/** While anything is running. */
const FAST_MS = 60_000
/** When every instance is idle. */
const SLOW_MS = 5 * 60_000
/** Alerts kept before the oldest go. */
const MAX_ALERTS = 50

/** The server names to poll, from the person's config. */
export function serversOf(options: Options): readonly string[] {
  const raw = options['tankServers']
  if (Array.isArray(raw)) return raw.map(String).filter(s => s !== '')
  if (typeof raw === 'string' && raw !== '') return raw.split(',').map(s => s.trim()).filter(s => s !== '')
  return []
}

/** An MCP result carries its payload either structured or as text. Take either. */
export function jsonOf(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return null
  const r = result as { structuredContent?: unknown; content?: unknown }
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') {
        try {
          return JSON.parse(text) as unknown
        } catch {
          // Not every block is JSON; the next one may be.
        }
      }
    }
  }
  return null
}

function taskOf(row: unknown): TankTask | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  const id = String(r['id'] ?? r['task'] ?? '')
  if (id === '') return null
  return {
    id,
    title: String(r['title'] ?? ''),
    project: String(r['project'] ?? ''),
    status: String(r['status'] ?? ''),
    updated: String(r['updated'] ?? ''),
  }
}

function tasksOf(rows: unknown): TankTask[] {
  return Array.isArray(rows) ? rows.map(taskOf).filter((t): t is TankTask => t !== null) : []
}

function queuesOf(rows: unknown): TankQueue[] {
  if (!Array.isArray(rows)) return []
  return rows.map(row => {
    const r = (row ?? {}) as Record<string, unknown>
    // Tank leaves a count out entirely when it is zero.
    const items = (r['items'] ?? {}) as Record<string, unknown>
    return {
      project: String(r['project'] ?? ''),
      state: String(r['state'] ?? ''),
      done: Number(items['done'] ?? 0),
      failed: Number(items['failed'] ?? 0),
      pending: Number(items['pending'] ?? 0),
      nowOrNext: typeof r['now_or_next'] === 'string' ? r['now_or_next'] : undefined,
    }
  })
}

/** One instance's overview, turned into what the panel draws. */
export function instanceOf(name: string, payload: unknown, now: number): TankInstance {
  const p = (payload ?? {}) as Record<string, unknown>
  return {
    name,
    ok: true,
    active: tasksOf(p['active']),
    waiting: tasksOf(p['waiting_for_user']),
    failed: tasksOf(p['failed_last_24h']),
    queues: queuesOf(p['build_queues']),
    checkedAt: now,
  }
}

/** How far through a queue is, counting a failed item as resolved. */
export function queueProgress(q: TankQueue): number | null {
  const total = q.done + q.failed + q.pending
  return total === 0 ? null : (q.done + q.failed) / total
}

/**
 * What is worth telling the person about.
 *
 * A task waiting for input is the highest-value thing Tank knows: work has
 * stopped and only a person can start it again. A failure is next. An
 * instance that will not answer is third, and is reported separately from a
 * failure because the causes are nothing alike.
 */
export function alertsOf(instances: readonly TankInstance[], now: number): TankAlert[] {
  const out: TankAlert[] = []
  for (const i of instances) {
    if (!i.ok) {
      out.push({ kind: 'unreachable', instance: i.name, text: i.error ?? 'did not answer', at: now })
      continue
    }
    for (const t of i.waiting) {
      out.push({ kind: 'waiting', instance: i.name, taskId: t.id, text: `${t.project}: ${t.title}`, at: now })
    }
    for (const t of i.failed) {
      out.push({ kind: 'failed', instance: i.name, taskId: t.id, text: `${t.project}: ${t.title}`, at: now })
    }
  }
  return out
}

/** Alerts already raised keep their first-seen time and their seen flag. */
export function mergeAlerts(prev: readonly TankAlert[], next: readonly TankAlert[]): TankAlert[] {
  const key = (a: TankAlert): string => `${a.kind}|${a.instance}|${a.taskId ?? a.text}`
  const known = new Map(prev.map(a => [key(a), a]))
  const merged = next.map(a => {
    const was = known.get(key(a))
    return was === undefined ? a : { ...a, at: was.at, seen: was.seen }
  })
  return merged.slice(-MAX_ALERTS)
}

/** True when anything on this instance is running. */
export function isBusy(i: TankInstance): boolean {
  return i.active.length > 0 || i.queues.some(q => q.state === 'running')
}

/** One poll of one instance. A box that will not answer is recorded, not thrown. */
export async function pollOne($: EngineInterface, name: string, now: number): Promise<TankInstance> {
  try {
    const result = await $.mcp.call(name, 'tank_overview', {})
    const payload = jsonOf(result)
    if (payload === null) {
      return { name, ok: false, error: 'no readable answer', active: [], waiting: [], failed: [], queues: [], checkedAt: now }
    }
    return instanceOf(name, payload, now)
  } catch (err) {
    const text = err instanceof Error ? err.message : 'did not answer'
    return { name, ok: false, error: text.slice(0, 120), active: [], waiting: [], failed: [], queues: [], checkedAt: now }
  }
}

/** Every instance, then the alerts that fall out of what they said. */
export async function pollTank(
  $: EngineInterface,
  options: Options,
  servers: readonly string[],
  now: number,
): Promise<number> {
  const instances: TankInstance[] = []
  for (const name of servers) instances.push(await pollOne($, name, now))

  const fresh = alertsOf(instances, now)
  let raised: TankAlert[] = []

  await writeTank($, prev => {
    const merged = mergeAlerts(prev.alerts, fresh)
    // Only an alert that was not already standing is worth a message.
    const was = new Set(prev.alerts.map(a => `${a.kind}|${a.instance}|${a.taskId ?? a.text}`))
    raised = merged.filter(a => !was.has(`${a.kind}|${a.instance}|${a.taskId ?? a.text}`))
    return { ...prev, instances, alerts: merged }
  })

  for (const alert of raised) {
    const event = alert.kind === 'waiting' ? 'tank.waiting' : alert.kind === 'failed' ? 'tank.failed' : 'tank.unreachable'
    if (alert.kind === 'resumed') continue
    await notify($, options, event, `${alert.instance}|${alert.taskId ?? alert.text}`, {
      project: alert.instance,
      detail: alert.text,
    })
  }

  // Only when the person has asked for it, and only inside the watchdog's own
  // hard limits. It does nothing at all in the default `alert` mode.
  for (const instance of instances) {
    if (!instance.ok || instance.failed.length === 0) continue
    const resumed = await runWatchdog($, options, instance.name, instance.failed, now)
    if (resumed.length === 0) continue
    await writeTank($, prev => ({
      ...prev,
      alerts: [
        ...prev.alerts,
        ...resumed.map(
          (id): TankAlert => ({ kind: 'resumed', instance: instance.name, taskId: id, text: `resumed ${id}`, at: now }),
        ),
      ].slice(-MAX_ALERTS),
    }))
  }

  return instances.some(isBusy) ? FAST_MS : SLOW_MS
}

/** The poll loop, started from boot and running on its own from then on. */
export async function startTank($: EngineInterface, options: Options): Promise<void> {
  if (options.tankPanel !== true) return
  const servers = serversOf(options)
  if (servers.length === 0) return

  await $.command.register({
    name: 'tower-tank',
    description: 'Open or close the Tank panel.',
  })

  const loop = async (): Promise<void> => {
    const now = await $.clock.now()
    let wait: number = SLOW_MS
    try {
      wait = await pollTank($, options, servers, now)
    } catch {
      // A failed round is not worth stopping the loop over.
    }
    $.clock.after(wait, () => {
      void loop()
    })
  }
  void loop()
}

/** How many alerts are still unseen, which is what the band shows. */
export function unseenOf(tank: Tank): number {
  return tank.alerts.filter(a => a.seen !== true).length
}

export const registerTank: Feature = (on, options) => {
  if (options.tankPanel !== true) return

  on('command.run', { command: 'tower-tank' }, async $ => {
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'Tank panel closed.' }
    }
    const placed = await $.ui.open({ id: PANE, title: 'Tank' })
    if (placed.isPlaced === false) {
      const tank = await readTank($)
      const lines = tank.instances.map(i =>
        i.ok ? `  ${i.name}: ${isBusy(i) ? 'busy' : 'idle'}, ${i.waiting.length} waiting` : `  ${i.name}: ${i.error ?? 'unreachable'}`,
      )
      return { text: ['No room for the panel at this width.', ...lines].join('\n') }
    }
    // Opening it is as good as reading it.
    await writeTank($, prev => ({ ...prev, alerts: prev.alerts.map(a => ({ ...a, seen: true })) }))
    return { text: '' }
  })
}
