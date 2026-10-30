import type { EngineInterface } from 'claude-code'

import { projectOf } from './builds'
import { writeBuilds } from './state'

import type { Build, BuildState } from '../../types'

/**
 * A build that was started outside this session raises no hook and has no
 * output to read. The only way to know about it is for the build itself to
 * say, which is what this file is: a small agreed shape a build script
 * writes, and the band reads.
 *
 * Liveness comes from a heartbeat rather than from the file existing, so a
 * killed build does not leave a bar that never finishes.
 */

/** The file a build script writes, in the working directory. */
export const MARKER = '.buildstatus.json'
/** How often it is read while something is running. */
export const MARKER_MS = 2_000
/** Missing this many heartbeats means the writer is gone. */
const MISSED = 3
/** A marker left behind by an old run is ignored outright. */
const ANCIENT_MS = 24 * 60 * 60_000

export type Marker = {
  schema: number
  id?: string
  project?: string
  target?: string
  state?: string
  startedAt?: string
  updatedAt?: string
  heartbeatSec?: number
  progress?: number
  step?: { name?: string }
  version?: string
  error?: string | null
}

const STATES: Readonly<Record<string, BuildState>> = {
  running: 'running',
  queued: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * The file turned into a build, or null when it is not one we can trust:
 * the wrong schema, no start time, ancient, or a writer that has stopped
 * breathing.
 */
export function buildOf(raw: unknown, cwd: string, now: number): Build | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Marker
  if (m.schema !== 1) return null

  const startedAt = Date.parse(String(m.startedAt ?? ''))
  if (Number.isNaN(startedAt) || now - startedAt > ANCIENT_MS) return null

  const updatedAt = Date.parse(String(m.updatedAt ?? ''))
  const beat = (m.heartbeatSec ?? 5) * 1000
  const declared = STATES[String(m.state ?? 'running')] ?? 'running'

  // A running build whose writer has gone quiet is unknown, not running.
  const isLive = Number.isNaN(updatedAt) || now - updatedAt <= beat * MISSED
  const state: BuildState = declared === 'running' && !isLive ? 'stale' : declared

  const progress = typeof m.progress === 'number' && m.progress >= 0 && m.progress <= 1 ? m.progress : undefined

  return {
    id: `marker:${String(m.id ?? cwd)}`,
    key: `marker:${String(m.target ?? cwd)}`,
    tool: 'script',
    target: String(m.target ?? 'build'),
    project: typeof m.project === 'string' && m.project !== '' ? m.project : projectOf(cwd),
    version: typeof m.version === 'string' ? m.version : undefined,
    state,
    origin: 'marker',
    startedAt,
    endedAt: state === 'running' ? undefined : Number.isNaN(updatedAt) ? now : updatedAt,
    lastSeenAt: Number.isNaN(updatedAt) ? now : updatedAt,
    progress,
    step: typeof m.step?.name === 'string' ? m.step.name : undefined,
    errorLine: typeof m.error === 'string' && m.error !== '' ? m.error.slice(0, 140) : undefined,
    runs: [],
  }
}

/** One read of the marker file. Silent when there is not one. */
export async function pollMarker($: EngineInterface, cwd: string, now: number): Promise<void> {
  let raw: unknown
  try {
    const text = String(await $.fs.read(`${cwd}/${MARKER}`, { as: 'text' }))
    raw = JSON.parse(text) as unknown
  } catch {
    // No file, or a half-written one caught mid-rename: try again next tick.
    return
  }

  const build = buildOf(raw, cwd, now)
  if (build === null) return
  await writeBuilds($, prev => [...prev.filter(b => b.id !== build.id), build].slice(-8))
}

/** What `/tower-hook` prints: the smallest emitter that satisfies the reader. */
export const SNIPPET = `// Write this beside your build. Rename, never write in place:
// a half-written file read by the watcher is this pattern's one real failure.
const fs = require('fs')
const F = '.buildstatus.json'
const base = {
  schema: 1,
  id: process.pid + '',
  project: require('./package.json').name,
  version: require('./package.json').version,
  target: process.argv.slice(2).join(' ') || 'build',
  startedAt: new Date().toISOString(),
  heartbeatSec: 5,
}
function status(o) {
  const body = JSON.stringify({ ...base, ...o, updatedAt: new Date().toISOString() })
  fs.writeFileSync(F + '.tmp', body)
  fs.renameSync(F + '.tmp', F)
}
// status({ state: 'running', progress: 0.4, step: { name: 'bundling' } })
// status({ state: 'succeeded' })  /  status({ state: 'failed', error: 'first error line' })
module.exports = { status }`
