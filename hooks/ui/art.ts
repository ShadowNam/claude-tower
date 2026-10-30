/**
 * The band's drawings, as SVG source.
 *
 * Only the graphical surfaces take these; the terminal keeps the dot strings,
 * which is why every drawing here has a text form that says the same thing.
 * Nothing in this file touches the engine or the clock: a render calls it, so
 * it stays arithmetic and string building.
 *
 * Text is deliberately absent from the markup. A drawing is handed to the
 * surface as an image, so any glyph inside it would be set in a font the
 * surface did not choose and would sit wrong beside the row's own words.
 * The shapes are drawn here; the words stay Text elements.
 */

/** The meter's box, in CSS pixels. */
const METER_W = 76
const METER_H = 10
const TRACK_H = 6
const TRACK_Y = (METER_H - TRACK_H) / 2
const RADIUS = TRACK_H / 2

/** The mark's box: square, and small enough to sit on one row. */
const MARK = 12

/** `#e8954a` → `#e8954a`, and anything unexpected → a safe literal. */
function hex(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888'
}

/** A percentage pinned to the track, so a stale reading cannot overdraw it. */
function clamp(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}

/**
 * One window's meter: a rounded track with the part still unspent filled in.
 *
 * It reads as a bar rather than a row of dots, which is the whole point, and
 * at a glance the length says what the number says.
 */
export function meter(leftPercent: number, color: string, track: string): string {
  const left = clamp(leftPercent)
  const fill = (left / 100) * METER_W
  const body =
    fill <= 0
      ? ''
      : `<rect x="0" y="${TRACK_Y}" width="${fill.toFixed(2)}" height="${TRACK_H}" rx="${RADIUS}" fill="${hex(color)}"/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${METER_W} ${METER_H}" width="${METER_W}" height="${METER_H}">`,
    `<rect x="0" y="${TRACK_Y}" width="${METER_W}" height="${TRACK_H}" rx="${RADIUS}" fill="${hex(track)}"/>`,
    body,
    '</svg>',
  ].join('')
}

export const METER_SIZE = { width: METER_W, height: METER_H } as const

/**
 * The band's own mark: three rising bars, the shape the mod is named for.
 *
 * It gives the row an owner at a glance, which is what a person is really
 * asking when two mods draw the same figures in the same place.
 */
export function mark(color: string): string {
  const c = hex(color)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK} ${MARK}" width="${MARK}" height="${MARK}">`,
    `<rect x="1" y="7" width="2.5" height="4" rx="0.6" fill="${c}"/>`,
    `<rect x="4.75" y="4" width="2.5" height="7" rx="0.6" fill="${c}"/>`,
    `<rect x="8.5" y="1" width="2.5" height="10" rx="0.6" fill="${c}"/>`,
    '</svg>',
  ].join('')
}

export const MARK_SIZE = { width: MARK, height: MARK } as const
