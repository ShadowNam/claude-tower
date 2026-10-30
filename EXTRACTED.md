# Tower — extracted features, for building elsewhere

Everything here was built inside a Claude Code mod called Tower and then taken
out of it. It is self-contained: the code, the types, the settings, the wiring
and the reasoning behind the parts that look arbitrary. Hand this whole file to
a fresh session and it has what it needs to rebuild any of it.

Extracted 2026-10-30. Four groups:

| Group | What it does | Needs |
|---|---|---|
| **WhatsApp notifications** | Sends a message when something you cared about changed | An MCP WhatsApp gateway |
| **Tank** | Polls self-hosted AI coding dashboards, shows what each is doing | Tank MCP servers |
| **Tank watchdog** | Resumes remote tasks killed by a transient failure | Tank, plus the notifier |
| **GitHub Actions** | Live CI run progress for a build bar | A GitHub token |

---

## Before building anything: three constraints that shaped all of this

**1. `$.mcp.call` is refused in `auto` permission mode.** The server-side
classifier judges a tool call against the model request that asked for it. A
mod's call belongs to no request — it comes from a timer or a slash command —
so it gets no verdict and fails closed:

> the server-side auto mode classifier gave no verdict for `<tool>`: the request
> that produced this action did not ask for one

WhatsApp, Tank and the watchdog **all** go through `$.mcp.call`. In auto mode
all three are dead, and no setting changes that. Whatever gets built on this
code, say so in its README rather than letting someone rediscover it.

**2. Naming an MCP server has two spellings and the obvious one is often
wrong.** A server configured by hand (`claude mcp add`, `.mcp.json`) answers to
the name it was given — `tank`, `tank-prod`. A claude.ai connector answers to
its **id**, not its title: a connector called "WhatsApp Gateway" is addressed as
`aa465f29-...`, the same string its tools carry
(`mcp__aa465f29-..._whatsapp_send_message`). The title does not resolve. This
cost a full debugging round.

**3. `$.process.*` is CLI-only.** It does nothing in the desktop app, so there
is no shelling out for a git branch or SHA. The GitHub code below reads the
remote through `$.session.repo` for exactly this reason.

---

## Four engine rules the code's shape depends on

These are not style. Break one and `claude plugin validate` refuses the module.

1. An `atom` is only followed by the static scan **within the file that reads or
   updates it**. All state lives behind helper functions in a single
   `state.ts`, not imported across files.
2. `$` crossing a module boundary is only followed into a **declared function**,
   never a const arrow, and the parameter must be spelled `$`. Every
   `export async function thing($: EngineInterface, ...)` below is written that
   way for this reason, not by preference.
3. An event may be registered **once without a matcher** per module. One module
   owns `session.start` and fans out to each feature's `start*` function; the
   features cannot hook it themselves.
4. A `ui.render` hook may not write state and must do no I/O. Collectors write
   pre-formatted values into state; drawings only read.

---

## The settings these features own

Merge into the host manifest's `userConfig`. `githubToken` is marked sensitive
so it lands in the OS keychain rather than a settings file.

```json
{
  "tankPanel": {
    "type": "boolean",
    "title": "Tank panel",
    "description": "Show activity, queue depth and health across your Tank instances.",
    "default": false
  },
  "tankServers": {
    "type": "string",
    "title": "Tank instances",
    "description": "The MCP server names of the Tank boxes to watch, one per entry, as /mcp lists them. Tower dials them with the engine's own connection, so it never needs their tokens.",
    "multiple": true,
    "default": [
      "tank"
    ]
  },
  "notifyEnabled": {
    "type": "boolean",
    "title": "Send WhatsApp notifications",
    "description": "The master switch. While this is off nothing is ever sent, whatever else is set. Messages go only to your own number, only from fixed templates.",
    "default": false
  },
  "whatsappServer": {
    "type": "string",
    "title": "WhatsApp MCP server",
    "description": "The name of your WhatsApp gateway as /mcp lists it. Tower dials it with the engine's own connection, so it never holds your gateway key.",
    "default": ""
  },
  "notifyLevel": {
    "type": "string",
    "title": "Notification level",
    "description": "Milestones sends what needs you: failures, stopped agents, a spent rate limit, and anything on Tank waiting for an answer. Verbose adds successes and warnings. Silent sends nothing.",
    "options": [
      "silent",
      "milestones",
      "verbose",
      "debug"
    ],
    "default": "silent"
  },
  "quietHours": {
    "type": "string",
    "title": "Quiet hours",
    "description": "Local time range during which messages are held and delivered as one morning digest. Empty disables quiet hours.",
    "default": "22:00-07:00"
  },
  "tankWatchdog": {
    "type": "string",
    "title": "Tank watchdog",
    "description": "alert surfaces stalled or failed jobs and waits for you. resume also retries transient failures automatically, capped and logged.",
    "options": [
      "off",
      "alert",
      "resume"
    ],
    "default": "alert"
  },
  "githubToken": {
    "type": "string",
    "title": "GitHub token",
    "description": "A token with Actions read access, so the build bar can follow CI runs for this repository. Stored in your operating system's keychain, never in a settings file. Leave empty to not watch CI at all.",
    "sensitive": true,
    "default": ""
  }
}
```

---

# Group 1 — WhatsApp notifications


### `notify.ts`

The whole feature: the event list, the levels, the throttles, quiet hours, the fixed message templates and the single `$.mcp.call` that sends. Everything below the sending is pure policy, which is why it can be tested without an engine.

<sub>331 lines — was `salvage/hooks/notify.ts`</sub>

```ts
import type { EngineInterface } from 'claude-code'

import { reasonOf, redact } from './fmt'
import type { Feature, Options } from './kinds'

/**
 * WhatsApp notifications.
 *
 * This is the only part of Tower that does something irreversible, and the
 * engine hands it a sharp tool: `$.mcp.call` dials the gateway with no
 * permission prompt. So the safety is built in rather than relied upon:
 *
 *  - It is off until the person turns it on, and silent even then.
 *  - It only ever sends to their own number. A different recipient is not a
 *    setting, because a setting could come from a repository file.
 *  - Every message is a fixed template filled with local facts. Nothing a
 *    model composed is ever sent, so a prompt injection has nothing to say.
 *  - The first send is a slash command the person runs themselves.
 *
 * Everything below the sending is policy, and policy is pure and tested.
 */

export type NotifyEvent =
  | 'build.failed'
  | 'build.finished'
  | 'agent.failed'
  | 'agent.finished'
  | 'ratelimit.near'
  | 'ratelimit.hit'
  | 'tank.waiting'
  | 'tank.failed'
  | 'tank.unreachable'
  | 'tank.resumed'
  | 'test'

/** What each level sends. A level is a starting point, not a cage. */
const MILESTONES: readonly NotifyEvent[] = [
  'build.failed',
  'agent.failed',
  'ratelimit.hit',
  'tank.waiting',
  'tank.failed',
  'tank.unreachable',
  'tank.resumed',
]

const VERBOSE: readonly NotifyEvent[] = [
  ...MILESTONES,
  'build.finished',
  'agent.finished',
  'ratelimit.near',
]

const LEVELS: Readonly<Record<string, readonly NotifyEvent[]>> = {
  silent: [],
  milestones: MILESTONES,
  verbose: VERBOSE,
  debug: VERBOSE,
}

/** Sent however quiet things are, because they mean work has stopped. */
const URGENT: readonly NotifyEvent[] = ['tank.waiting', 'ratelimit.hit']

/** The same thing is not worth saying twice inside this long. */
const COOLDOWN_MS = 5 * 60_000
/** Nor is a repeat of the identical message inside this long. */
const DEDUPE_MS = 30 * 60_000
/** Per session, and per day. */
const SESSION_CAP = 15
const DAY_CAP = 60
/** A message nobody would act on any more is dropped rather than sent late. */
const EXPIRY_MS: Readonly<Record<string, number>> = {
  'build.failed': 30 * 60_000,
  'build.finished': 30 * 60_000,
  'tank.waiting': 2 * 60 * 60_000,
  'ratelimit.hit': 60 * 60_000,
}
const DEFAULT_EXPIRY_MS = 2 * 60 * 60_000

export type Policy = {
  /** When each event-and-subject was last sent. */
  sent: Readonly<Record<string, number>>
  /** How many went out today, and which day that was. */
  day: string
  dayCount: number
}

export const EMPTY_POLICY: Policy = { sent: {}, day: '', dayCount: 0 }

export type Decision = { send: boolean; reason: string }

export function levelOf(options: Options): string {
  const raw = String(options['notifyLevel'] ?? 'silent')
  return raw in LEVELS ? raw : 'silent'
}

/** Whether this level asks for this event at all. */
export function wants(level: string, event: NotifyEvent): boolean {
  if (event === 'test') return true
  return (LEVELS[level] ?? []).includes(event)
}

/** `YYYY-MM-DD` in local time, for the daily cap. */
export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Whether `at` falls inside a quiet range like `22:00-07:00`. A range that
 * wraps past midnight is the normal case, so it is the one handled first.
 */
export function inQuietHours(range: string, at: number): boolean {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim())
  if (m === null) return false
  const mins = (h: string | undefined, min: string | undefined): number => Number(h ?? 0) * 60 + Number(min ?? 0)
  const from = mins(m[1], m[2])
  const to = mins(m[3], m[4])
  const d = new Date(at)
  const now = d.getHours() * 60 + d.getMinutes()
  return from <= to ? now >= from && now < to : now >= from || now < to
}

/**
 * Whether this message goes now. Everything that would hold it back is
 * checked in one place so the reason can be reported rather than guessed at.
 */
export function decide(
  policy: Policy,
  level: string,
  quiet: string,
  event: NotifyEvent,
  subject: string,
  now: number,
  sessionCount: number,
): Decision {
  if (event !== 'test') {
    if (!wants(level, event)) return { send: false, reason: `${level} does not send ${event}` }

    const today = dayOf(now)
    const dayCount = policy.day === today ? policy.dayCount : 0
    if (dayCount >= DAY_CAP) return { send: false, reason: 'daily cap reached' }
    if (sessionCount >= SESSION_CAP) return { send: false, reason: 'session cap reached' }

    const key = `${event}|${subject}`
    const last = policy.sent[key]
    if (last !== undefined && now - last < DEDUPE_MS) return { send: false, reason: 'already said recently' }

    const lastOfKind = policy.sent[event]
    if (lastOfKind !== undefined && now - lastOfKind < COOLDOWN_MS) {
      return { send: false, reason: 'too soon after the last one of these' }
    }

    if (quiet !== '' && inQuietHours(quiet, now) && !URGENT.includes(event)) {
      return { send: false, reason: 'quiet hours' }
    }
  }
  return { send: true, reason: 'sent' }
}

/** Mark a message as sent, so the next decision knows. */
export function record(policy: Policy, event: NotifyEvent, subject: string, now: number): Policy {
  const today = dayOf(now)
  return {
    sent: { ...policy.sent, [`${event}|${subject}`]: now, [event]: now },
    day: today,
    dayCount: (policy.day === today ? policy.dayCount : 0) + 1,
  }
}

export type Facts = {
  project?: string
  session?: string
  detail?: string
  extra?: string
}

const CLOCK = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The message, from a fixed template. Every field is a local fact, truncated
 * and redacted: nothing a model wrote and nothing from a web page can reach
 * a recipient through here.
 */
export function render(event: NotifyEvent, facts: Facts, at: number): string {
  const where = facts.project === undefined ? '' : ` · ${facts.project}`
  const who = facts.session === undefined ? '' : ` · #${facts.session}`
  const detail = redact(String(facts.detail ?? '')).slice(0, 180)
  const extra = redact(String(facts.extra ?? '')).slice(0, 120)
  const time = CLOCK(at)

  switch (event) {
    case 'build.failed':
      return `*Build failed*${where}${who}\n${detail}\n_${extra}_\n${time}`
    case 'build.finished':
      return `*Build OK*${where}${who}\n${detail}\n${time}`
    case 'agent.failed':
      return `*Agent stopped*${where}${who}\n${detail}\n_${extra}_\n${time}`
    case 'agent.finished':
      return `*Agents done*${where}${who}\n${detail}\n${time}`
    case 'ratelimit.near':
      return `*Usage ${detail}*${who}\n${extra}\n${time}`
    case 'ratelimit.hit':
      return `*Rate limit reached*${who}\n${detail}\n${time}`
    case 'tank.waiting':
      return `*Tank needs you*${where}\n${detail}\nReply in Tank or open the task.\n${time}`
    case 'tank.failed':
      return `*Tank task failed*${where}\n${detail}\n_${extra}_\n${time}`
    case 'tank.unreachable':
      return `*Tank unreachable*${where}\n${detail}\n${time}`
    case 'tank.resumed':
      return `*Watchdog resumed a task*${where}\n${detail}\n${extra}\n${time}`
    case 'test':
      return `*Tower is connected*\nThis is the test message. Notifications will arrive here.\n${time}`
  }
}

/** Whether sending is possible at all: switched on, and told where to send. */
export function canSend(options: Options): { ok: boolean; why: string } {
  if (options['notifyEnabled'] !== true) return { ok: false, why: 'notifications are switched off' }
  const server = String(options['whatsappServer'] ?? '')
  if (server === '') return { ok: false, why: 'no WhatsApp server is configured' }
  return { ok: true, why: '' }
}

/** Per session, held in the module rather than the store: it is a session count. */
let sessionCount = 0

/**
 * Send one message, if policy allows it. Returns what happened, so a caller
 * can say so rather than wonder.
 *
 * `to` is never passed: the gateway sends to the person's own number when it
 * is left out, and not passing it is what makes a wrong recipient impossible.
 */
export async function notify(
  $: EngineInterface,
  options: Options,
  event: NotifyEvent,
  subject: string,
  facts: Facts,
): Promise<Decision> {
  const able = canSend(options)
  if (!able.ok) return { send: false, reason: able.why }

  const now = await $.clock.now()
  const level = levelOf(options)
  const quiet = String(options['quietHours'] ?? '')

  let policy = EMPTY_POLICY
  try {
    const raw = await $.store.get('notify:policy')
    if (typeof raw === 'object' && raw !== null) policy = { ...EMPTY_POLICY, ...(raw as Policy) }
  } catch {
    // A store that will not answer costs throttling, so fail closed instead.
    return { send: false, reason: 'could not read the send history' }
  }

  const verdict = decide(policy, level, quiet, event, subject, now, sessionCount)
  if (!verdict.send) return verdict

  const text = render(event, facts, now)
  try {
    await $.mcp.call(String(options['whatsappServer']), 'whatsapp_send_message', { text, wait: false })
  } catch (err) {
    return { send: false, reason: reasonOf(err, 600, 'the gateway refused') }
  }

  sessionCount += 1
  try {
    await $.store.set('notify:policy', record(policy, event, subject, now))
  } catch {
    // The message went; losing the record only risks one repeat.
  }
  return { send: true, reason: 'sent' }
}

/** How long a message of this kind stays worth sending. */
export function expiryOf(event: NotifyEvent): number {
  return EXPIRY_MS[event] ?? DEFAULT_EXPIRY_MS
}

/** Registers the command. Called from the mod's one session.start hook. */
export async function startNotify($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'tower-notify',
    description: 'Show what Tower would send on WhatsApp, or send the test message.',
    argumentHint: '[test]',
  })
}

/**
 * `/tower-notify` reports what is set, and `/tower-notify test` sends the one
 * message Tower will not send by itself. The first send being a command the
 * person runs is the whole consent story: they see the setup, then they send.
 */
export const registerNotify: Feature = (on, options) => {
  on('command.run', { command: 'tower-notify' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim()
    const able = canSend(options)
    const level = levelOf(options)
    const quiet = String(options['quietHours'] ?? '')

    if (args === 'test') {
      if (!able.ok) return { text: `Cannot send: ${able.why}. Set it up in /config, under Tower.` }
      const sent = await notify($, options, 'test', 'test', {})
      return {
        text: sent.send
          ? 'Test message sent to your own number. If it arrives, notifications are working.'
          : `Not sent: ${sent.reason}`,
      }
    }

    return {
      text: [
        'Tower notifications',
        '',
        `  state      ${able.ok ? 'ready' : able.why}`,
        `  level      ${level}${level === 'silent' ? ' (nothing is sent)' : ''}`,
        `  quiet      ${quiet === '' ? 'off' : quiet}`,
        `  sent       ${sessionCount} this session`,
        '',
        'Messages only ever go to your own number, and only from fixed templates.',
        'Run /tower-notify test to send the first one yourself.',
      ].join('\n'),
    }
  })
}
```


### The rules that are deliberately not settings

These are the reason this code can be trusted with an irreversible action.
Keep them wherever it lands.

**The recipient is not a setting.** `to` is never passed to the gateway, which
falls back to the account's own number. A setting could be written by a file in
a repository; the absence of one cannot.

**Every message is a fixed template** filled with local facts. Nothing a model
composed is ever sent, so a prompt injection has nothing to say through it.

**Anything key-shaped is stripped** before a message is built.

**The first message is one the person sends themselves**, through a slash
command. This is also what catches a wrong server name — a wrong name fails
silently on every automatic send, so without a manual first send you learn
about it only by noticing the silence.

**Throttles:** five minutes between messages of a kind, thirty before an
identical one repeats, fifteen per session, sixty per day, two-hour expiry on a
message that could not be sent promptly.

### Where it was called from

Four call sites, removed with the feature. Revive only those whose events the
new plugin can actually see.

| Event | Fired from | When |
|---|---|---|
| `ratelimit.hit` | a `session.measure` hook | a window reaches 100% |
| `ratelimit.near` | the same | a window reaches 90% |
| `build.failed` / `build.finished` | a `tool.call` hook, after the call resolves | a build long enough to be worth telling about |
| `agent.failed` | a `turn.complete` hook | a subagent stops without answering |
| `tank.resumed` | the watchdog | every resume |

---

# Group 2 — Tank


### `tank.ts`

Polling, the alert model and the panel's data. `pollOne` dials `tank_overview` through `$.mcp.call`. Note `jsonOf`: an MCP answer arrives either as `structuredContent` or as text blocks that may or may not be JSON, and one block failing to parse must not stop the next being read.

<sub>273 lines — was `salvage/hooks/tank.ts`</sub>

```ts
import type { EngineInterface } from 'claude-code'

import { reasonOf } from './fmt'
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
    // Redacted, because a Tank URL carries a bearer token and an error that
    // quotes the request would otherwise put it in the panel and the store.
    const text = reasonOf(err, 400, 'did not answer')
    return { name, ok: false, error: text, active: [], waiting: [], failed: [], queues: [], checkedAt: now }
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
```



### `pane-tank.tsx`

The pane. Note the width guard: an auto-opened pane needs room it may not get, so `$.ui.open` resolves `{ isPlaced }` and there is a text fallback for when it does not.

<sub>138 lines — was `salvage/hooks/pane-tank.tsx`</sub>

```tsx
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
```



### `types.d.ts`

Add `tank: Tank` to the host's `PluginState` entry. `claude plugin validate` holds every `$.state` key the module names to this contract.

<sub>61 lines — was `salvage/types.d.ts`</sub>

```ts
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
```


### Two behaviours worth keeping

**An unreachable instance claims nothing about its tasks.** When a poll fails
the instance is marked not-ok with its reason, and its task lists stay empty. It
never shows as "idle", which would read as "nothing to do" when the truth is "no
idea".

**Polling follows the work:** 60 seconds while anything is running, 5 minutes
when everything is idle.

---

# Group 3 — Tank watchdog


### `watchdog.ts`

Resumes a remote task killed by a transient failure. Three modes: `off`, `alert` (tell me, change nothing) and `resume`.

<sub>186 lines — was `salvage/hooks/watchdog.ts`</sub>

```ts
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
```


### Limits that cannot be configured away

A watchdog that can be talked into retrying anything is a way to burn a budget
overnight. These are hard-coded on purpose, and the reasoning survives the move:

- **transient failures only** — connection lost, a 5xx, a restart
- **never** on `main`, `master`, `prod`, `production` or a release branch
- **twice per task, ever** — the count lives in `$.store`, so restarting the
  session does not reset it
- five minutes apart, at most five an hour across everything
- every resume sends a message, so it can never work quietly

---

# Group 4 — GitHub Actions


### `ci.ts`

Reads the repository from `$.session.repo`, finds the newest workflow run on the current branch and reports its progress with per-step detail. **Never executed in anger** — the token was never set in the session this came from, so treat it as a solid starting point rather than proven code.

<sub>176 lines — was `hooks/core/ci.ts`</sub>

```ts
import type { EngineInterface } from 'claude-code'

import { projectOf } from './builds'
import { writeBuilds } from './state'

import type { Build, BuildState } from '../../types'

/**
 * GitHub Actions is the one source that reports real progress for free.
 *
 * The moment a job starts, GitHub publishes its whole `steps` array from the
 * workflow file, each with a status and exact timestamps. That gives a
 * denominator and a numerator with no cooperation from anyone, which nothing
 * running locally does.
 *
 * Polling is cheap because of ETags: a 304 does not count against the hourly
 * rate limit, so a run can be watched closely without spending anything.
 */

/** While a run is active. */
const FAST_MS = 10_000
/** When nothing is happening. */
const SLOW_MS = 120_000
/** A run older than this is not worth showing. */
const RECENT_MS = 30 * 60_000

export type Step = { name: string; status: string; conclusion: string | null }

/** `owner/name` from a git remote, or null when it is not a GitHub one. */
export function repoOf(remote: string | null): string | null {
  if (remote === null) return null
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (m === null) return null
  const owner = m[1]
  const name = m[2]
  return owner === undefined || name === undefined ? null : `${owner}/${name}`
}

/** GitHub's own words for where a run is, in ours. */
export function stateOf(status: string, conclusion: string | null): BuildState {
  if (status !== 'completed') return 'running'
  if (conclusion === 'success') return 'succeeded'
  if (conclusion === 'cancelled' || conclusion === 'skipped') return 'cancelled'
  return 'failed'
}

/**
 * How far a job is, weighted by nothing but step counts.
 *
 * Steps can be added mid-run by composite actions, so the denominator is
 * recounted every poll rather than remembered. A step that was skipped took
 * no time and must not count as progress.
 */
export function progressOf(steps: readonly Step[]): { progress: number; step: string } | null {
  const real = steps.filter(s => s.conclusion !== 'skipped')
  if (real.length === 0) return null
  const done = real.filter(s => s.status === 'completed').length
  const current = real.find(s => s.status === 'in_progress')
  const progress = Math.max(0, Math.min(1, (done + (current === undefined ? 0 : 0.5)) / real.length))
  return { progress, step: current?.name ?? `${done}/${real.length} steps` }
}

/** The first failing step of a run, which is the only one worth naming. */
export function failingStepOf(steps: readonly Step[]): string | null {
  return steps.find(s => s.conclusion === 'failure')?.name ?? null
}

type Cached = { etag: string | null; at: number }
const cache = new Map<string, Cached>()

async function get(
  $: EngineInterface,
  url: string,
  token: string,
): Promise<{ body: unknown; notModified: boolean } | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  }
  const known = cache.get(url)
  if (known?.etag != null) headers['If-None-Match'] = known.etag

  try {
    const res = await $.http.fetch(url, { headers })
    if (res.status === 304) return { body: null, notModified: true }
    if (!res.ok) return null
    const etag = res.headers['etag'] ?? res.headers['ETag'] ?? null
    cache.set(url, { etag, at: Date.now() })
    return { body: JSON.parse(res.text) as unknown, notModified: false }
  } catch {
    // A network that will not answer costs a refresh, not the session.
    return null
  }
}

/**
 * One poll: the newest workflow run, and if it is recent, its jobs' steps.
 * Returns how long to wait before the next one.
 */
export async function pollCi($: EngineInterface, repo: string, token: string, now: number): Promise<number> {
  const runs = await get($, `https://api.github.com/repos/${repo}/actions/runs?per_page=1`, token)
  if (runs === null) return SLOW_MS
  if (runs.notModified) return FAST_MS

  const list = (runs.body as { workflow_runs?: unknown })?.workflow_runs
  const run = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined
  if (run === undefined) return SLOW_MS

  const id = String(run['id'] ?? '')
  const status = String(run['status'] ?? '')
  const conclusion = run['conclusion'] === null ? null : String(run['conclusion'] ?? '')
  const startedAt = Date.parse(String(run['run_started_at'] ?? run['created_at'] ?? ''))
  if (id === '' || Number.isNaN(startedAt)) return SLOW_MS

  const state = stateOf(status, conclusion)
  // A finished run from hours ago is history, not status.
  if (state !== 'running' && now - startedAt > RECENT_MS) return SLOW_MS

  let progress: number | undefined
  let step: string | undefined
  let errorLine: string | undefined

  const jobs = await get($, `https://api.github.com/repos/${repo}/actions/runs/${id}/jobs`, token)
  if (jobs !== null && !jobs.notModified) {
    const rows = (jobs.body as { jobs?: unknown })?.jobs
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    const steps = Array.isArray(first?.['steps'])
      ? (first['steps'] as Record<string, unknown>[]).map(s => ({
          name: String(s['name'] ?? ''),
          status: String(s['status'] ?? ''),
          conclusion: s['conclusion'] === null ? null : String(s['conclusion'] ?? ''),
        }))
      : []
    const where = progressOf(steps)
    if (where !== null) {
      progress = where.progress
      step = where.step
    }
    const failing = failingStepOf(steps)
    if (failing !== null) errorLine = `failed at step: ${failing}`
  }

  const build: Build = {
    id: `ci:${id}`,
    key: `ci:${repo}`,
    tool: 'github',
    target: String(run['name'] ?? 'workflow'),
    project: projectOf(repo),
    version: `#${String(run['run_number'] ?? '')}`,
    state,
    origin: 'ci',
    startedAt,
    endedAt: state === 'running' ? undefined : now,
    lastSeenAt: now,
    progress,
    step,
    errorLine,
    url: typeof run['html_url'] === 'string' ? run['html_url'] : undefined,
    runs: [],
  }

  await writeBuilds($, prev => [...prev.filter(b => b.id !== build.id), build].slice(-8))
  return state === 'running' ? FAST_MS : SLOW_MS
}

/** Where to poll, and whether we can: null when there is no repo or no token. */
export async function ciTargetOf($: EngineInterface, token: string): Promise<string | null> {
  if (token === '') return null
  try {
    const repo = await $.session.repo()
    return repo === null ? null : repoOf(repo.remote)
  } catch {
    return null
  }
}
```


### How it was wired

From the host's `session.start`, after the marker-file watcher. The loop
re-arms itself with an interval the poll chooses, rather than running on a fixed
timer:

```ts
// CI needs a token the person supplied; without one there is nothing to
// watch and nothing is attempted.
const token = String(options.githubToken ?? '')
const repo = await ciTargetOf($, token)
if (repo === null) return

// The interval follows the run: close while something is happening, slow
// when nothing is. A 304 costs nothing against the rate limit either way.
const loop = async (): Promise<void> => {
  const now = await $.clock.now()
  let wait = 120_000
  try {
    wait = await pollCi($, repo, token, now)
  } catch {
    // One failed poll is not worth stopping the loop over.
  }
  $.clock.after(wait, () => {
    void loop()
  })
}
void loop()
```

### What it needs from the host

- `githubToken` in `userConfig`, `"sensitive": true`
- `$.session.repo` for the remote, `$.http.fetch` for the API
- a `Build` record and a `writeBuilds` state helper to write progress into

If the new plugin has no build model, `pollCi` needs its tail rewritten. The
parts worth keeping are the ETag handling, the adaptive interval, the mapping
from GitHub's status/conclusion pair to a single state, and the step parsing
that finds the first failing step and ignores skipped ones.

---

## Testing any of this

The policy in all four groups is pure and can be tested without an engine —
that separation is the point of splitting policy from the calls. The parked
tests live in the Tower repository under `salvage/tests/*.spec.ts`; rename them
to `*.test.ts` once they have a plugin to run against and point their imports at
wherever the code lands.

```
claude plugin test <folder>       # run the tests
claude plugin validate <folder>   # check the module the way the engine will
```

`validate` is the one that catches the four engine rules above, and its output
lists every event the module hooks and every `$` call it makes — useful on its
own for seeing what a module actually touches.
