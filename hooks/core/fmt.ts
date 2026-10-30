/**
 * Formatting helpers. A draw does this much arithmetic and no more: no I/O,
 * no awaits beyond reading state, because renders run on every redraw.
 */

/** `3s`, `1m 04s`, `2h 09m`. */
export function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** How long until an ISO time: `21m`, `5h 18m`, `5d 18h`, or `resetting`. */
export function until(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Local wall-clock time, `16:40`, for an answer worth looking at a clock for. */
export function at(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Money, kept short: `$2.14`, `$0.42`, or a marker below a cent. */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/** `940`, `223k`, `1.2M`. */
export function tokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A dotted bar: filled for what is left, faint for what is spent. */
export function dots(percentLeft: number, cells: number): { on: string; off: string } {
  const n = Math.max(0, Math.min(cells, Math.round((percentLeft / 100) * cells)))
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

/** The panels the person has switched on, in the order the UI shows them. */
export function panelsOf(options: Readonly<Record<string, unknown>>): string[] {
  const all: readonly (readonly [string, string])[] = [
    ['usageBand', 'usage'],
    ['agentsPanel', 'agents'],
    ['buildBar', 'build'],
    ['tankPanel', 'tank'],
  ]
  return all.filter(([key]) => options[key] === true).map(([, label]) => label)
}
