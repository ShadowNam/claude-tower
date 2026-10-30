import type { EngineInterface } from 'claude-code'

import { redact } from './builds'
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
    return { send: false, reason: gatewayReason(err) }
  }

  sessionCount += 1
  try {
    await $.store.set('notify:policy', record(policy, event, subject, now))
  } catch {
    // The message went; losing the record only risks one repeat.
  }
  return { send: true, reason: 'sent' }
}

/**
 * Room for the whole of what the gateway said.
 *
 * This was 80, which cut the engine's "no connected MCP tool … on a server
 * named …" exactly where it names the server — the one part of the message
 * that says what to change. A refusal is the only account a person gets of a
 * send that did not happen, so it is kept whole.
 */
const REASON_MAX = 240

/** What the gateway's refusal said, with anything key-shaped taken out. */
export function gatewayReason(err: unknown): string {
  if (!(err instanceof Error)) return 'the gateway refused'
  const clean = redact(err.message).replace(/\s+/g, ' ').trim()
  if (clean === '') return 'the gateway refused'
  return clean.length > REASON_MAX ? `${clean.slice(0, REASON_MAX - 1)}…` : clean
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
