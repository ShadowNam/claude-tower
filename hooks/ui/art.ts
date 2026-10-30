import { BG, EMPTY } from './theme'

/**
 * The band's drawings, as SVG source.
 *
 * `AbovePrompt` is raised on the terminal and desktop only, so these are for
 * the desktop; the terminal keeps the text forms, which is why every drawing
 * here has one that says the same thing. The agents pane uses them too, and it
 * is drawn on every surface. Nothing touches the engine or the clock: a render
 * calls these, so they stay arithmetic and string building.
 *
 * Five rules hold throughout, and all five were learned by getting them wrong.
 *
 * **Two user units is the smallest feature.** Shapes are authored at 2× and
 * shown at 1×, so two units is one device pixel on an ordinary monitor. A
 * 1-unit line is half a pixel: it does not render faint, it renders as mud.
 * Two-unit lines go on even coordinates so they land on the pixel grid.
 *
 * **A drawing paints its own floor.** Alpha over whatever happens to be behind
 * means the drawing inverts the moment something else is behind it. The floor
 * is opaque BG, so each of these is self-contained.
 *
 * **The top of a lit surface is darker than its specular.** The topmost sliver
 * is the edge turning away from the light; the highlight sits just below it.
 * Brightest-at-the-very-top with a hard-edged white pill over it is the one
 * thing that dates a drawing, and it is what this file used to do.
 *
 * **Within one gradient, hold the colour and vary only the alpha.** Crossing
 * hue and alpha at once passes through a muddy grey with a luminance dip. Two
 * stacked gradients cost nothing.
 *
 * **No glyph inside a drawing.** It would be set in a font the surface did not
 * choose. The shapes are here; the words stay Text elements beside them.
 */

/** Shown size in CSS pixels, and the 2× box the shapes are drawn in. */
const METER_W = 84
const METER_H = 14
const ORB = 11
const MARK = 13
const SCALE = 2

/** The meter's geometry, in user units. */
const TRACK_X = 2
const TRACK_Y = 6
const TRACK_W = METER_W * SCALE - TRACK_X * 2
const TRACK_H = 16
/** A third of the height, not half: see `capsule`. */
const TRACK_R = 5
/** How far the fill's head throws its shadow forward. */
const CAST = 12

type Rgb = readonly [number, number, number]

/** `#e8893c` and `#e83` alike; anything else is a mid grey rather than markup. */
function parse(color: string): Rgb {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim())
  if (m === null) return [136, 136, 136]
  const h = m[1] as string
  const full = h.length === 3 ? h.replace(/./g, c => c + c) : h
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

/** The only way a colour becomes markup: six hex digits, nothing else. */
function hex(c: Rgb): string {
  return (
    '#' +
    c
      .map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Towards white, for a lit face. */
function lift(c: Rgb, amount: number): Rgb {
  return c.map(n => n + (255 - n) * amount) as unknown as Rgb
}

/** Towards black, for a face turned away from the light. */
function drop(c: Rgb, amount: number): Rgb {
  return c.map(n => n * (1 - amount)) as unknown as Rgb
}

function clamp(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}

/**
 * Ids must be unique per drawing: several sit in one row, and a surface that
 * inlines them would otherwise have two `#body` to choose from.
 */
let seq = 0
function uid(): string {
  seq = (seq + 1) % 100_000
  return `t${seq.toString(36)}`
}

function svg(w: number, h: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w * SCALE} ${h * SCALE}" ` +
    `width="${w}" height="${h}">${body}</svg>`
  )
}

/**
 * The lit profile of a rounded surface, as five stops.
 *
 * Dark lip, specular, body, core shadow, bounce. The first stop being darker
 * than the second is the whole of what separates this from a cheap gradient:
 * it is the edge rolling away from the light, and without it the brightest
 * part of the shape is its topmost pixel, which nothing in the world looks
 * like.
 */
function profile(id: string, base: Rgb): string {
  const stops: readonly (readonly [number, Rgb])[] = [
    [0, drop(base, 0.22)],
    [0.16, lift(base, 0.34)],
    [0.46, base],
    [0.82, drop(base, 0.26)],
    [1, lift(base, 0.1)],
  ]
  return (
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    stops.map(([at, c]) => `<stop offset="${at}" stop-color="${hex(c)}"/>`).join('') +
    '</linearGradient>'
  )
}

/**
 * One window's meter: a channel with a lit fill in it, read left to right.
 *
 * Three things here are not decoration.
 *
 * The **rim** is the only thing that says how long the scale is. Without it
 * the empty track sits at 1.17:1 against the band — invisible — and a meter
 * at 8% is an orange nub floating in nothing, with no way to read the
 * fraction. It is drawn in EMPTY, at 1.77:1.
 *
 * The **square-ended fill clipped to a rounded track** keeps the reading
 * linear. A rounded fill shorter than its own corner diameter degenerates
 * into a lens whose length no longer encodes the value — which happened below
 * 12%, precisely the range a usage meter exists for.
 *
 * The **head** is where the dimensionality goes: a shadow thrown forward onto
 * the empty floor, and a bright leading edge. It is the one edge in the whole
 * drawing that carries the reading, so it gets the budget.
 */
export function capsule(leftPercent: number, color: string): string {
  const id = uid()
  const base = parse(color)
  const fill = (clamp(leftPercent) / 100) * TRACK_W
  const floor = parse(BG)
  const rim = parse(EMPTY)

  const head =
    fill <= 0
      ? ''
      : [
          `<rect x="${(TRACK_X + fill).toFixed(2)}" y="${TRACK_Y}" width="${CAST}" height="${TRACK_H}" fill="url(#${id}c)"/>`,
          `<rect x="${(TRACK_X + fill - 2).toFixed(2)}" y="${TRACK_Y}" width="2" height="${TRACK_H}" fill="#ffffff" fill-opacity="0.26"/>`,
        ].join('')

  return svg(
    METER_W,
    METER_H,
    [
      '<defs>',
      `<clipPath id="${id}k"><rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_R}"/></clipPath>`,
      // The floor is opaque, so the drawing never depends on what is behind it.
      `<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0" stop-color="${hex(drop(floor, 0.4))}"/>`,
      `<stop offset="0.55" stop-color="${hex(drop(floor, 0.15))}"/>`,
      `<stop offset="1" stop-color="${hex(lift(floor, 0.1))}"/>`,
      '</linearGradient>',
      profile(`${id}b`, base),
      // Cast forward from the head onto the empty floor.
      `<linearGradient id="${id}c" x1="0" y1="0" x2="1" y2="0">`,
      '<stop offset="0" stop-color="#000000" stop-opacity="0.5"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity="0"/>',
      '</linearGradient>',
      // The groove's top lip darkens whatever sits in it, fill and floor alike.
      `<linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1">`,
      '<stop offset="0" stop-color="#000000" stop-opacity="0.45"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity="0"/>',
      '</linearGradient>',
      // One glass cover over the whole instrument, not over the fill: an arc of
      // a far larger ellipse, so it is thick mid-span and thin at both ends.
      // userSpaceOnUse because the ellipse's own box is not the artwork.
      `<linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="0" y1="${TRACK_Y}" x2="0" y2="${TRACK_Y + 9}">`,
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0.26"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      '</linearGradient>',
      // Sub-perceptual dither: breaks a contour before it can form.
      `<pattern id="${id}d" width="4" height="4" patternUnits="userSpaceOnUse">`,
      '<rect x="0" y="0" width="1" height="1" fill="#ffffff" fill-opacity="0.05"/>',
      '<rect x="2" y="2" width="1" height="1" fill="#000000" fill-opacity="0.05"/>',
      '</pattern>',
      '</defs>',
      `<g clip-path="url(#${id}k)">`,
      `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" fill="url(#${id}f)"/>`,
      fill <= 0
        ? ''
        : `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${fill.toFixed(2)}" height="${TRACK_H}" fill="url(#${id}b)"/>`,
      `<ellipse cx="${METER_W}" cy="2" rx="100" ry="13" fill="url(#${id}s)"/>`,
      head,
      `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="7" fill="url(#${id}l)"/>`,
      `<rect x="${TRACK_X}" y="${TRACK_Y + TRACK_H - 2}" width="${TRACK_W}" height="2" fill="#ffffff" fill-opacity="0.07"/>`,
      `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" fill="url(#${id}d)"/>`,
      // Quarter notches: a scale, without a glyph.
      '<g fill="#000000" fill-opacity="0.3" shape-rendering="crispEdges">',
      `<rect x="42" y="${TRACK_Y}" width="2" height="${TRACK_H}"/>`,
      `<rect x="84" y="${TRACK_Y}" width="2" height="${TRACK_H}"/>`,
      `<rect x="124" y="${TRACK_Y}" width="2" height="${TRACK_H}"/>`,
      '</g>',
      '</g>',
      // SVG has no inside stroke, so inset by half the width.
      `<rect x="${TRACK_X + 1}" y="${TRACK_Y + 1}" width="${TRACK_W - 2}" height="${TRACK_H - 2}" rx="${TRACK_R - 1}" fill="none" stroke="${hex(rim)}" stroke-width="2"/>`,
    ].join(''),
  )
}

export const CAPSULE_SIZE = { width: METER_W, height: METER_H } as const

/**
 * A lit sphere for a state that is one word.
 *
 * The **rim arc** on the shadow side is what stops it dissolving into the
 * band: on a dark ground the turned-away limb and the background are the same
 * value, so without a rim you get a smudge, not a sphere. The **specular is
 * one small dot** — it used to be 42% of the diameter at near-white, which
 * made two states that mean opposite things land within ΔE 5 of each other.
 * At eleven pixels the colour is the only thing the shape can say, so nothing
 * is allowed to wash it out.
 *
 * `shape` gives the failure state a silhouette of its own. Green and red are
 * the one pair no hex can separate for a deuteranope, so the distinction
 * cannot rest on hue.
 */
export function orb(color: string, shape: 'round' | 'alert' = 'round'): string {
  const id = uid()
  const base = parse(color)
  const S = ORB * SCALE
  const c = S / 2
  const r = 8

  const body =
    shape === 'alert'
      ? `<path d="M${c} ${c - r}L${c + r} ${c}L${c} ${c + r}L${c - r} ${c}Z" fill="url(#${id}b)"/>`
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="url(#${id}b)"/>`

  // The lit limb, from upper-left round to lower-right, straddling the edge.
  const rim =
    shape === 'alert'
      ? `<path d="M${c - r} ${c}L${c} ${c - r}L${c + r} ${c}" fill="none" stroke="${hex(lift(base, 0.5))}" stroke-opacity="0.5" stroke-width="2" stroke-linejoin="round"/>`
      : `<path d="M${(c + r * 0.64).toFixed(2)} ${(c - r * 0.77).toFixed(2)} A${r} ${r} 0 0 1 ${(c - r * 0.84).toFixed(2)} ${(c + r * 0.56).toFixed(2)}" fill="none" stroke="${hex(lift(base, 0.5))}" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>`

  return svg(
    ORB,
    ORB,
    [
      '<defs>',
      // A gradient to transparent on a circle is an exact blur, not an
      // approximation of one — and needs no filter.
      `<radialGradient id="${id}h" gradientUnits="userSpaceOnUse" cx="${c}" cy="${c}" r="${c}">`,
      `<stop offset="0.7" stop-color="${hex(base)}" stop-opacity="0.34"/>`,
      `<stop offset="1" stop-color="${hex(base)}" stop-opacity="0"/>`,
      '</radialGradient>',
      `<radialGradient id="${id}b" cx="0.36" cy="0.32" r="0.78">`,
      `<stop offset="0" stop-color="${hex(lift(base, 0.28))}"/>`,
      `<stop offset="0.42" stop-color="${hex(base)}"/>`,
      `<stop offset="0.78" stop-color="${hex(drop(base, 0.28))}"/>`,
      `<stop offset="1" stop-color="${hex(drop(base, 0.52))}"/>`,
      '</radialGradient>',
      `<radialGradient id="${id}s">`,
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      '</radialGradient>',
      '</defs>',
      `<circle cx="${c}" cy="${c}" r="${c}" fill="url(#${id}h)"/>`,
      body,
      rim,
      // The colour's own light coming back off the lower-left.
      `<circle cx="${(c - r * 0.45).toFixed(2)}" cy="${(c + r * 0.48).toFixed(2)}" r="2.2" fill="${hex(lift(base, 0.15))}" fill-opacity="0.3"/>`,
      `<circle cx="${(c - r * 0.35).toFixed(2)}" cy="${(c - r * 0.42).toFixed(2)}" r="2.6" fill="url(#${id}s)"/>`,
    ].join(''),
  )
}

export const ORB_SIZE = { width: ORB, height: ORB } as const

/**
 * The mod's own mark, which has to survive as a favicon.
 *
 * One silhouette, not three bars. At thirteen pixels, three shapes with two
 * gaps between them is six pixels of ink split five ways — detail the display
 * cannot resolve, which reads as dirt rather than as detail. The bevel is a
 * thick stroke of the same path clipped to itself, so only its inner half
 * shows, then darkened along the two edges facing away from the light.
 */
export function mark(color: string): string {
  const id = uid()
  const base = parse(color)
  const path = 'M11 4h4l2 18H9z'

  return svg(
    MARK,
    MARK,
    [
      '<defs>',
      `<clipPath id="${id}k"><path d="${path}"/></clipPath>`,
      `<linearGradient id="${id}f" x1="0" y1="0" x2="0.35" y2="1">`,
      `<stop offset="0" stop-color="${hex(lift(base, 0.34))}"/>`,
      `<stop offset="1" stop-color="${hex(drop(base, 0.26))}"/>`,
      '</linearGradient>',
      '</defs>',
      `<path d="${path}" fill="url(#${id}f)"/>`,
      `<g clip-path="url(#${id}k)">`,
      `<path d="${path}" fill="none" stroke="#ffffff" stroke-opacity="0.34" stroke-width="4"/>`,
      '<path d="M15 4l2 18H9" fill="none" stroke="#000000" stroke-opacity="0.38" stroke-width="4"/>',
      '</g>',
    ].join(''),
  )
}

export const MARK_SIZE = { width: MARK, height: MARK } as const
