/** What the mod knows about itself: proves the load, and what `/tower` prints. */
export type Diag = {
  /** The mod's own version, from plugin.json. */
  version: string
  /** The engine build this session runs. */
  engine: string
  /** Where this session draws: terminal, desktop, vscode, mobile, or none. */
  surface: string
  /** Clock milliseconds when the module last loaded. */
  loadedAt: number
  /** How many times the module has loaded this session; a hot reload adds one. */
  reloads: number
  /** The panels switched on in the config, in display order. */
  panels: readonly string[]
}

/** One reading of a usage window, kept so a rate can be worked out from them. */
export type Sample = { at: number; percent: number }

/** A usage window as the band draws it. */
export type UsageWindow = {
  /** The engine's own name: `seven_day`, `five_hour`, `spend_limit`. */
  kind: string
  percentUsed: number
  /** ISO time the window resets, when the engine says. */
  resetsAt?: string
  /**
   * Clock milliseconds when this window is on course to be spent, or null when
   * it is not being spent fast enough to matter, when there is too little
   * history to say, or when it resets before it would run out.
   */
  emptyAt: number | null
}

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request, how much context the next request re-sends, and on which model.
 */
export type CacheFacts = {
  lastAt: number
  tokens: number
  window: number
  model: string | null
}

/** The engine's own figures for this session: its ledger, not our estimate. */
export type Ledger = {
  /** What the engine has billed this session, or null before it says. */
  usd: number | null
  tokens: number
  window: number
}

/** Everything the usage band draws, in one value so one write redraws it once. */
export type Usage = {
  windows: readonly UsageWindow[]
  cache: CacheFacts | null
  ledger: Ledger
  /** Recent readings per window kind, trailing and capped. */
  samples: Readonly<Record<string, readonly Sample[]>>
}

export type AgentStatus = 'running' | 'done' | 'failed'

/** One agent loop: the main session, or a subagent of it. */
export type AgentRun = {
  /** The engine's agent id once there is one, else the spawning tool call. */
  id: string
  agentId?: string
  /** The loop this one was spawned in; absent for the main session. */
  parentId?: string
  /** The subagent type, or `main` for the session itself. */
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  /** Why it ended, when it did not answer: the engine's own stop reason. */
  reason?: string
  startedAt: number
  endedAt?: number
  /** What the next request re-sends, as the last request measured it. */
  contextTokens: number
  /** The model's window; 0 for the main row, which reads the real one. */
  contextMax: number
  /** False when the window was assumed from the model id rather than known. */
  isWindowKnown: boolean
  /** Billed tokens kept apart, so the total means something. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Null once any request used a model the price table does not name. */
  costUsd: number | null
  /** Model requests made. */
  steps: number
  /** Clock ms of the last model request, for spotting a stall. */
  lastStepAt: number
  /** The tool it is running now, and what that tool is working on. */
  tool?: string
  toolDetail?: string
  /** Tool calls that came back an error. */
  toolErrors: number
  /** Distinct files read or written, newest last, capped. */
  touched: readonly string[]
}

export type AgentsPanel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  /** Set once the pane has opened itself, so it only ever does so once. */
  autoOpened: boolean
}

export type BuildState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale'

/** One finished run of the same build, for working out how long it takes. */
export type BuildRun = { at: number; ms: number }

export type Build = {
  /** The tool call that started it. */
  id: string
  /** What its history is filed under: project, target and whether it was cold. */
  key: string
  /** The build tool recognised from the command: vite, cargo, docker… */
  tool: string
  /** The command, tidied and capped. */
  target: string
  /** The directory it ran in, by name. */
  project: string
  /** From package.json, Cargo.toml and friends, when there is one. */
  version?: string
  state: BuildState
  startedAt: number
  endedAt?: number
  /** The first line of the failure, with anything secret taken out. */
  errorLine?: string
  /**
   * Where this build came from: a shell command in this session, a CI run, or
   * a marker file a build script writes.
   */
  origin: 'session' | 'ci' | 'marker'
  /** 0 to 1 when the source reports its own progress; absent when it does not. */
  progress?: number
  /** The step it is on, when the source names one. */
  step?: string
  /** Somewhere to open it: a CI run's page. */
  url?: string
  /** Last time anything confirmed this build still exists. */
  lastSeenAt: number
  /**
   * Past durations of this same build, newest last, copied in at the start.
   * The estimate is worked out while drawing, and a draw cannot read a store.
   */
  runs: readonly BuildRun[]
}

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

declare module 'claude-code' {
  interface PluginState {
    'tower': {
      diag: Diag | null
      /** Bumped by the ticker so countdowns stay current. */
      tick: number
      usage: Usage
      agents: readonly AgentRun[]
      panel: AgentsPanel
      builds: readonly Build[]
      tank: Tank
    }
  }
}
