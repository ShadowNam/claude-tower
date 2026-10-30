import type { EngineInterface } from 'claude-code'

import type { Options } from './kinds'
import { notify } from './notify'
import { jsonOf } from './tank'

import type { TankTask } from '../../types'

/**
 * Resuming a stalled Tank task, when the person has asked for that.
 *
 * This is the only thing Tower does that changes something outside itself, so
 * every limit here is a hard one, and all of them are checked before anything
 * is sent:
 *
 *  - Off unless the watchdog is set to `resume`. The default is `alert`.
 *  - Only for errors that are known to be transient. A task that failed on
 *    its own merits is left alone; retrying it would just burn tokens.
 *  - Never on a protected branch.
 *  - Two attempts per task, ever. The count lives in the store, so restarting
 *    the session cannot reset it — which is the whole point of a cap.
 *  - Five minutes between attempts on one task, five an hour across all.
 *  - Every resume sends a message, so an unattended loop cannot stay quiet.
 */

/** The failures that are worth another go: the machinery, not the work. */
const TRANSIENT =
  /API Error|Connection lost|connection reset|socket hang up|ECONNRESET|ETIMEDOUT|\b50[234]\b|server restart|timed out/i

/** Branches a watchdog has no business touching. */
const PROTECTED = /^(main|master|prod|production|release(\/.*)?)$/i

export const MAX_RESUMES = 2
const MIN_GAP_MS = 5 * 60_000
const HOUR_CAP = 5
const HOUR_MS = 60 * 60_000

/** What the watchdog says when it resumes something, verbatim. */
export const RESUME_MESSAGE =
  '[watchdog resume] Your session stopped with an error (API error, connection lost, or a restart). ' +
  'Check git status, git log and the branch, work out what landed and what did not, then carry on from there. ' +
  'Do not start over, and do not force-push.'

export type ResumeRecord = { count: number; last: number }

export type WatchdogState = {
  tasks: Readonly<Record<string, ResumeRecord>>
  /** When recent resumes happened, for the hourly cap across everything. */
  recent: readonly number[]
}

export const EMPTY_WATCHDOG: WatchdogState = { tasks: {}, recent: [] }

export function isTransient(error: string): boolean {
  return TRANSIENT.test(error)
}

export function isProtected(branch: string | undefined): boolean {
  return branch !== undefined && PROTECTED.test(branch.trim())
}

export type Verdict = { ok: boolean; why: string }

/**
 * Whether this task may be resumed now. Pure: every refusal has a reason the
 * panel and the log can repeat.
 */
export function mayResume(
  state: WatchdogState,
  mode: string,
  taskId: string,
  branch: string | undefined,
  error: string,
  now: number,
): Verdict {
  if (mode !== 'resume') return { ok: false, why: 'the watchdog only alerts' }
  if (!isTransient(error)) return { ok: false, why: 'the failure was not a transient one' }
  if (isProtected(branch)) return { ok: false, why: `${branch ?? 'that branch'} is protected` }

  const record = state.tasks[taskId]
  if (record !== undefined) {
    if (record.count >= MAX_RESUMES) return { ok: false, why: `already resumed ${record.count} times` }
    if (now - record.last < MIN_GAP_MS) return { ok: false, why: 'resumed very recently' }
  }

  const thisHour = state.recent.filter(at => now - at < HOUR_MS).length
  if (thisHour >= HOUR_CAP) return { ok: false, why: 'too many resumes in the last hour' }

  return { ok: true, why: 'transient failure, within every limit' }
}

/** Note that a resume happened, keeping only the last hour of timestamps. */
export function noteResume(state: WatchdogState, taskId: string, now: number): WatchdogState {
  const was = state.tasks[taskId]
  return {
    tasks: { ...state.tasks, [taskId]: { count: (was?.count ?? 0) + 1, last: now } },
    recent: [...state.recent.filter(at => now - at < HOUR_MS), now],
  }
}

async function loadState($: EngineInterface): Promise<WatchdogState> {
  try {
    const raw = await $.store.get('watchdog:resumes')
    if (typeof raw !== 'object' || raw === null) return EMPTY_WATCHDOG
    const s = raw as Partial<WatchdogState>
    return {
      tasks: typeof s.tasks === 'object' && s.tasks !== null ? s.tasks : {},
      recent: Array.isArray(s.recent) ? s.recent.filter(n => typeof n === 'number') : [],
    }
  } catch {
    // A cap that cannot be read is a cap that cannot be trusted: do nothing.
    return { tasks: {}, recent: Array.from({ length: HOUR_CAP }, () => Date.now()) }
  }
}

/** The task's branch and error, which the overview does not carry. */
async function detailOf(
  $: EngineInterface,
  server: string,
  taskId: string,
): Promise<{ branch?: string; error: string } | null> {
  try {
    const result = await $.mcp.call(server, 'tank_get_task', { task: taskId, turns: 1 })
    const payload = jsonOf(result)
    if (typeof payload !== 'object' || payload === null) return null
    const p = payload as Record<string, unknown>
    return {
      branch: typeof p['branch'] === 'string' ? p['branch'] : undefined,
      error: String(p['error'] ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * Look at each failed task and resume the ones that qualify. Returns what was
 * done, so the caller can report it rather than guess.
 */
export async function runWatchdog(
  $: EngineInterface,
  options: Options,
  server: string,
  failed: readonly TankTask[],
  now: number,
): Promise<readonly string[]> {
  const mode = String(options['tankWatchdog'] ?? 'alert')
  if (mode !== 'resume' || failed.length === 0) return []

  let state = await loadState($)
  const resumed: string[] = []

  for (const task of failed) {
    const detail = await detailOf($, server, task.id)
    if (detail === null) continue

    const verdict = mayResume(state, mode, task.id, detail.branch, detail.error, now)
    if (!verdict.ok) continue

    try {
      await $.mcp.call(server, 'tank_reply_to_task', { task: task.id, message: RESUME_MESSAGE })
    } catch {
      continue
    }

    state = noteResume(state, task.id, now)
    resumed.push(task.id)

    const attempt = state.tasks[task.id]?.count ?? 1
    await notify($, options, 'tank.resumed', `${server}|${task.id}`, {
      project: server,
      detail: `${task.project}: ${task.title}`,
      extra: `Attempt ${attempt} of ${MAX_RESUMES}. Reason: ${detail.error.slice(0, 80)}`,
    })
  }

  if (resumed.length > 0) {
    try {
      await $.store.set('watchdog:resumes', state)
    } catch {
      // Having resumed without recording it, the next poll may try again;
      // the per-task gap is what stops that becoming a loop.
    }
  }
  return resumed
}
