/**
 * The band's drawings, as SVG source.
 *
 * Only the graphical surfaces take these; the terminal keeps the text forms,
 * which is why every drawing here has one that says the same thing. Nothing
 * touches the engine or the clock: a render calls it, so it stays arithmetic
 * and string building.
 *
 * Three rules hold throughout.
 *
 * No text in the markup. A drawing is handed to the surface as an image, so a
 * glyph inside it would be set in a font the surface did not choose and would
 * sit wrong beside the row's own words. Shapes here, words as Text.
 *
 * Everything is drawn at twice the size it is shown at. A gradient across six
 * device pixels bands badly; across twelve it does not, and the surface
 * downsamples for free.
 *
 * Nothing reaches the markup unchecked. Colours go through `rgb`, which only
 * ever emits three integers, and figures go through `clamp`. A reading that
 * is out of scale cannot overdraw its track, and a colour that is not a
 * colour cannot become markup.
 */

/** Shown size in CSS pixels, and the 2× box the shapes are drawn in. */
const METER_W = 84
const METER_H = 14
const ORB = 11
const MARK = 13
const SCALE = 2

type Rgb = readonly [number, number, number]

/** `#e8954a` and `#e84` alike; anything else is a mid grey rather than markup. */
function parse(color: string): Rgb {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim())
  if (m === null) return [136, 136, 136]
  const h = m[1] as string
  const full = h.length === 3 ? h.replace(/./g, c => c + c) : h
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

/** The only way a colour becomes markup: three integers, nothing else. */
function rgb(c: Rgb, alpha = 1): string {
  const [r, g, b] = c.map(n => Math.max(0, Math.min(255, Math.round(n)))) as unknown as Rgb
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/** Towards white at `amount`, for the lit face of a surface. */
function lift(c: Rgb, amount: number): Rgb {
  return c.map(n => n + (255 - n) * amount) as unknown as Rgb
}

/** Towards black at `amount`, for the face turned away from the light. */
function drop(c: Rgb, amount: number): Rgb {
  return c.map(n => n * (1 - amount)) as unknown as Rgb
}

function clamp(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}

/**
 * Ids have to be unique per drawing: several are laid in one row, and a
 * surface that inlines them would otherwise have two `#fill` to choose from
 * and would pick one for both.
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
 * One window's meter: a channel cut into the bar with a lit bead sitting in
 * it. The track darkens towards its top edge and the bead lightens towards
 * its own, which is what reads as depth — a groove and something raised in
 * it, lit from above.
 */
export function capsule(leftPercent: number, color: string): string {
  const id = uid()
  const base = parse(color)
  const W = METER_W * SCALE
  const H = METER_H * SCALE
  const pad = 4
  const h = H - pad * 2
  const r = h / 2
  const w = (clamp(leftPercent) / 100) * (W - 2)

  const bead =
    w <= 1
      ? ''
      : [
          `<rect x="1" y="${pad}" width="${w.toFixed(2)}" height="${h}" rx="${r}" fill="url(#${id}b)"/>`,
          // The specular: brightest along the upper third, gone by the middle.
          `<rect x="2.5" y="${pad + 1.5}" width="${Math.max(0, w - 3).toFixed(2)}" height="${(h / 2 - 1).toFixed(2)}"`,
          ` rx="${((h / 2 - 1) / 2).toFixed(2)}" fill="url(#${id}s)"/>`,
          // A thread of the colour's own light along the bottom, so the bead
          // sits in the groove rather than on top of the bar.
          `<rect x="3" y="${(pad + h - 1.5).toFixed(2)}" width="${Math.max(0, w - 4).toFixed(2)}" height="1"`,
          ` rx="0.5" fill="${rgb(lift(base, 0.45), 0.55)}"/>`,
        ].join('')

  return svg(
    METER_W,
    METER_H,
    [
      '<defs>',
      `<linearGradient id="${id}t" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0" stop-color="rgba(0,0,0,0.55)"/>`,
      `<stop offset="1" stop-color="rgba(255,255,255,0.07)"/>`,
      '</linearGradient>',
      `<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0" stop-color="${rgb(lift(base, 0.38))}"/>`,
      `<stop offset="0.5" stop-color="${rgb(base)}"/>`,
      `<stop offset="1" stop-color="${rgb(drop(base, 0.3))}"/>`,
      '</linearGradient>',
      `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0" stop-color="rgba(255,255,255,0.40)"/>`,
      `<stop offset="1" stop-color="rgba(255,255,255,0)"/>`,
      '</linearGradient>',
      '</defs>',
      `<rect x="0" y="${pad - 1}" width="${W}" height="${h + 2}" rx="${r + 1}" fill="url(#${id}t)"/>`,
      bead,
    ].join(''),
  )
}

export const CAPSULE_SIZE = { width: METER_W, height: METER_H } as const

/**
 * A lit sphere, for a state that is one word: the highlight sits up and left,
 * the colour deepens away from it, and a touch of the colour bounces back off
 * the bottom edge. Small, but unmistakably round.
 */
export function orb(color: string): string {
  const id = uid()
  const base = parse(color)
  const S = ORB * SCALE
  const c = S / 2
  const r = c - 1

  return svg(
    ORB,
    ORB,
    [
      '<defs>',
      `<radialGradient id="${id}g" cx="0.35" cy="0.3" r="0.8">`,
      `<stop offset="0" stop-color="${rgb(lift(base, 0.55))}"/>`,
      `<stop offset="0.55" stop-color="${rgb(base)}"/>`,
      `<stop offset="1" stop-color="${rgb(drop(base, 0.45))}"/>`,
      '</radialGradient>',
      `<radialGradient id="${id}h" cx="0.5" cy="0.5" r="0.5">`,
      `<stop offset="0" stop-color="rgba(255,255,255,0.75)"/>`,
      `<stop offset="1" stop-color="rgba(255,255,255,0)"/>`,
      '</radialGradient>',
      '</defs>',
      // The colour pooling under the sphere, which is what seats it.
      `<ellipse cx="${c}" cy="${(S - 1.5).toFixed(2)}" rx="${(r * 0.7).toFixed(2)}" ry="1.2" fill="${rgb(base, 0.25)}"/>`,
      `<circle cx="${c}" cy="${c}" r="${r}" fill="url(#${id}g)"/>`,
      `<ellipse cx="${(c - r * 0.3).toFixed(2)}" cy="${(c - r * 0.38).toFixed(2)}" rx="${(r * 0.42).toFixed(2)}" ry="${(r * 0.3).toFixed(2)}" fill="url(#${id}h)"/>`,
    ].join(''),
  )
}

export const ORB_SIZE = { width: ORB, height: ORB } as const

/**
 * The mod's own mark: three rising blocks, each with a lit top face and a
 * shaded right one, so it reads as built rather than drawn. It gives the row
 * an owner, which is the question a person actually asks when two mods put
 * the same figures in the same place.
 */
export function mark(color: string): string {
  const id = uid()
  const base = parse(color)
  const S = MARK * SCALE
  const w = 5
  const gap = 3
  const x0 = (S - (w * 3 + gap * 2)) / 2
  const heights = [8, 14, 20]

  const block = (i: number) => {
    const x = x0 + i * (w + gap)
    const h = heights[i] as number
    const y = S - 3 - h
    return [
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="url(#${id}f)"/>`,
      // The top face catches the light; the right edge turns away from it.
      `<rect x="${x}" y="${y}" width="${w}" height="1.6" rx="0.8" fill="${rgb(lift(base, 0.6), 0.9)}"/>`,
      `<rect x="${x + w - 1.2}" y="${y + 1}" width="1.2" height="${h - 1}" fill="${rgb(drop(base, 0.4), 0.55)}"/>`,
    ].join('')
  }

  return svg(
    MARK,
    MARK,
    [
      '<defs>',
      `<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0" stop-color="${rgb(lift(base, 0.25))}"/>`,
      `<stop offset="1" stop-color="${rgb(drop(base, 0.25))}"/>`,
      '</linearGradient>',
      '</defs>',
      block(0),
      block(1),
      block(2),
    ].join(''),
  )
}

export const MARK_SIZE = { width: MARK, height: MARK } as const
