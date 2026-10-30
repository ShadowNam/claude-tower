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
  /**
   * Features that threw while starting, as `name: reason`. A feature that
   * fails is skipped alone and named here, so `/tower` can say why a panel is
   * missing rather than the mod going quietly dark.
   */
  failures: readonly string[]
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
/**
 * What the engine says about compaction, or null until it has said.
 *
 * `window` and the compaction window are not the same number: the typings say
 * the compaction window "may be smaller than `window`", and compaction fires
 * against the smaller one. Dividing by the wrong one understates how close the
 * session is to being compacted, which is the single decision this figure
 * drives.
 */
export type Compaction = {
  /** The window compaction actually measures against. */
  max: number
  /** Tokens in use, as the breakdown estimates them. */
  used: number
  /** Where auto-compaction fires, when it is on and the engine names it. */
  firesAt: number | null
  isEnabled: boolean
  /** The raw breakdown, kept so a drawing can name the heaviest thing in it. */
  breakdown?: unknown
}

export type Usage = {
  windows: readonly UsageWindow[]
  /** The cache's real lifetime once the engine has said; an hour until then. */
  cacheTtlMs?: number
  /** False while the lifetime is still Tower's assumption rather than a fact. */
  isTtlLearned?: boolean
  /** The engine's own estimate of re-caching, where it has given one. */
  rewarmUsd?: number | null
  /** Null until a measurement has carried a breakdown. */
  compaction: Compaction | null
  cache: CacheFacts | null
  ledger: Ledger
  /** Recent readings per window kind, trailing and capped. */
  samples: Readonly<Record<string, readonly Sample[]>>
}

/**
 * What this session changed, as Tower watched it happen.
 *
 * Not a working tree: it cannot see an edit made outside the session and does
 * not un-count a reverted file. Named `session edits` wherever it is drawn,
 * because the name is the only thing stopping it being read as `git status`.
 */
export type Edits = {
  files: readonly string[]
  added: number
  removed: number
  /** The most recent edit as a diff hunk; only the last one is kept. */
  last?: string
}

/** A turn that ended badly, as the engine named it. */
export type Fault = {
  /** The engine's own kind: `rate_limit`, `overloaded`, and the rest. */
  kind: string
  at: number
}

/** What the turn is doing, in the band's words. */
export type Phase = 'thinking' | 'asking' | 'writing' | 'tool'

/** Work still running outside the turn, as the engine last listed it. */
export type Background = {
  count: number
  /** The kinds in it: shell, subagent, monitor, workflow. */
  kinds: readonly string[]
  /** Prompts scheduled to fire later. */
  scheduled: number
  /** When the list was taken; it is a turn-boundary snapshot, not live. */
  at: number
}

/**
 * The repository the session is working in.
 *
 * `sync` is deliberately coarse. Ahead/behind counts need the commit graph,
 * which is not reachable from reading `.git` files, so this says whether the
 * local and remote refs match and never a number.
 */
export type Repo = {
  branch: string
  isDetached: boolean
  /** main, master, production, a release branch: a stray commit matters more. */
  isProtected: boolean
  /** rebasing, merging, cherry-picking, and the rest; null when the tree is settled. */
  midway: string | null
  sync: 'synced' | 'diverged' | 'unknown'
}

/** The heaviest thing in the context that is not the conversation. */
export type Weight = { name: string; tokens: number }

/** The task list as the band shows it. */
export type Plan = {
  /** Kept so a later advance, which names no steps, can be applied to them. */
  steps: readonly { content: string; status: string }[]
  done: number
  total: number
  /** The step in progress, truncated; empty when none is marked. */
  now: string
  finished: boolean
}

/** How fast the model has been answering, and whether that is unusual. */
export type Rate = {
  /** Recent turns' tokens per second, trailing and capped. */
  recent: readonly number[]
  /** Consecutive slow turns; one slow turn is noise. */
  slowRuns: number
  isSlow: boolean
  /** The last turn's rate, or null before one could be measured. */
  perSecond: number | null
}

/** What the session knows about its own shape, beyond the usage figures. */
export type Shape = {
  /** Null until a turn long enough to measure has finished. */
  rate: Rate | null
  /** What the turn is doing, from the engine's own spinner. */
  phase?: Phase
  /** Null when nothing is in flight; a snapshot taken at a turn boundary. */
  background?: Background | null
  /** Null outside a repository, or before the first read. */
  repo?: Repo | null
  /** How many of your sessions are alive, this one included. */
  sessions?: number
  /** The effort the turn ran at, after any silent downgrade. */
  effort: string
  /** Set while a compaction is running, or expected. */
  compacting: 'running' | 'soon' | null
  fault: Fault | null
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
  /** Summed tool execution time, as the engine reports it per call. */
  toolMs: number
  /**
   * True for a run the engine listed that Tower never saw start — its figures
   * are absent rather than zero, and a drawing must not read them as real.
   */
  isUnwatched?: boolean
  /** What the last finished tool took, for the row to name. */
  lastToolMs?: number
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
      edits: Edits
      shape: Shape
      plan: Plan | null
      /** A layout pressed on the band; empty means the setting decides. */
      picked: string
    }
  }
}
