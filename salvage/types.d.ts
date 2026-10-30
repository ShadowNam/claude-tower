/**
 * The state contract the Tank panel and the watchdog need.
 *
 * Merge this back into the host plugin's `types/index.d.ts`, and add
 * `tank: Tank` to its `PluginState` entry; `claude plugin validate` holds
 * every `$.state` key the module names to that contract.
 */

/** A task on a Tank instance, as its overview lists one. */
export type TankTask = {
  id: string
  title: string
  project: string
  status: string
  /** Tank reports this as words ("13m ago"), not a time. */
  updated: string
}

/** A build queue on a Tank project: the one place Tank gives a real fraction. */
export type TankQueue = {
  project: string
  state: string
  done: number
  failed: number
  pending: number
  nowOrNext?: string
}

export type TankInstance = {
  /** The MCP server's name, which is what the person calls the box. */
  name: string
  /** False when the last poll did not come back. */
  ok: boolean
  error?: string
  active: readonly TankTask[]
  waiting: readonly TankTask[]
  failed: readonly TankTask[]
  queues: readonly TankQueue[]
  checkedAt: number
  /** When this instance was first seen busy with the current task. */
  busySince?: number
}

export type TankAlertKind = 'waiting' | 'failed' | 'unreachable' | 'resumed'

export type TankAlert = {
  kind: TankAlertKind
  instance: string
  taskId?: string
  text: string
  at: number
  /** Set once the person has seen it, so it stops shouting. */
  seen?: boolean
}

export type Tank = {
  instances: readonly TankInstance[]
  alerts: readonly TankAlert[]
  /** Resume attempts per task, kept so a restart cannot reset the cap. */
  resumes: Readonly<Record<string, number>>
}
