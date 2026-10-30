import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AgentRun, AgentsPanel, Build, Diag, Edits, Plan, Shape, Usage } from '../../types'

/**
 * Every atom lives here, with the reads and writes that touch it: the engine's
 * scan follows `atom` only within the file that reads or updates it, so state
 * is reached through these helpers rather than by importing the atoms.
 *
 * The helpers are function declarations on purpose. Across an import the scan
 * follows `$` into a declared function only, never into a const arrow, and the
 * parameter must be spelled `$`.
 *
 * This state is the session's. It survives a hot reload and a compaction, and
 * is lost on restart; anything that must outlive the session goes to `$.store`.
 */
const diag = atom({ plugin: 'tower', key: 'diag' } as const, null as Diag | null)
const tick = atom({ plugin: 'tower', key: 'tick' } as const, 0)

/** One value for the whole band, so a measurement redraws it exactly once. */
export const EMPTY_USAGE: Usage = {
  windows: [],
  compaction: null,
  cache: null,
  ledger: { usd: null, tokens: 0, window: 0 },
  samples: {},
}

const usage = atom({ plugin: 'tower', key: 'usage' } as const, EMPTY_USAGE)

export function readDiag($: EngineInterface): Promise<Diag | null> {
  return read($, diag)
}

export async function writeDiag($: EngineInterface, fn: (prev: Diag | null) => Diag): Promise<void> {
  await update($, diag, fn)
}

/** Read while drawing so the draw becomes a reader, and each bump redraws it. */
export function readTick($: EngineInterface): Promise<number> {
  return read($, tick)
}

export async function bumpTick($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

export function readUsage($: EngineInterface): Promise<Usage> {
  return read($, usage)
}

export async function writeUsage($: EngineInterface, fn: (prev: Usage) => Usage): Promise<void> {
  await update($, usage, fn)
}

const agents = atom({ plugin: 'tower', key: 'agents' } as const, [] as readonly AgentRun[])

export const EMPTY_PANEL: AgentsPanel = { isCompact: false, isDoneCollapsed: false, autoOpened: false }

const panel = atom({ plugin: 'tower', key: 'panel' } as const, EMPTY_PANEL)

export function readAgents($: EngineInterface): Promise<readonly AgentRun[]> {
  return read($, agents)
}

export async function writeAgents(
  $: EngineInterface,
  fn: (prev: readonly AgentRun[]) => readonly AgentRun[],
): Promise<void> {
  await update($, agents, fn)
}

const builds = atom({ plugin: 'tower', key: 'builds' } as const, [] as readonly Build[])

export function readBuilds($: EngineInterface): Promise<readonly Build[]> {
  return read($, builds)
}

export async function writeBuilds(
  $: EngineInterface,
  fn: (prev: readonly Build[]) => readonly Build[],
): Promise<void> {
  await update($, builds, fn)
}





export function readPanel($: EngineInterface): Promise<AgentsPanel> {
  return read($, panel)
}

export async function writePanel($: EngineInterface, fn: (prev: AgentsPanel) => AgentsPanel): Promise<void> {
  await update($, panel, fn)
}

export const EMPTY_EDITS: Edits = { files: [], added: 0, removed: 0 }

const edits = atom({ plugin: 'tower', key: 'edits' } as const, EMPTY_EDITS)

export function readEdits($: EngineInterface): Promise<Edits> {
  return read($, edits)
}

export async function writeEdits($: EngineInterface, fn: (prev: Edits) => Edits): Promise<void> {
  await update($, edits, fn)
}

export const EMPTY_SHAPE: Shape = { rate: null, effort: '', compacting: null, fault: null }

const shape = atom({ plugin: 'tower', key: 'shape' } as const, EMPTY_SHAPE)

export function readShape($: EngineInterface): Promise<Shape> {
  return read($, shape)
}

export async function writeShape($: EngineInterface, fn: (prev: Shape) => Shape): Promise<void> {
  await update($, shape, fn)
}

const plan = atom({ plugin: 'tower', key: 'plan' } as const, null as Plan | null)

export function readPlan($: EngineInterface): Promise<Plan | null> {
  return read($, plan)
}

export async function writePlan($: EngineInterface, fn: (prev: Plan | null) => Plan | null): Promise<void> {
  await update($, plan, fn)
}
