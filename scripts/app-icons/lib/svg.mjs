/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Serialises a scene (see raster.mjs) to standalone SVG, so the art can be
// opened in any editor and so Icon Composer gets vector layers.

import { resample } from './bitmap.mjs'
import { fmt } from './geometry.mjs'
import { encodePNG } from './png.mjs'

/** The longest side an embedded bitmap keeps in SVG. */
const EMBED_MAX = 512

/** An image op's bitmap as a PNG data URL at the size it is drawn (capped), tinted when the op says. */
function embed(op) {
  const k = Math.min(1, EMBED_MAX / Math.max(op.w, op.h))
  const w = Math.max(1, Math.ceil(op.w * k))
  const h = Math.max(1, Math.ceil(op.h * k))
  const pm = resample(op.bitmap, w, h, 0, 0, w, h, op.src)
  const px = new Uint8Array(w * h * 4)
  for (let i = 0; i < pm.length; i += 4) {
    const a = pm[i + 3]
    px[i + 3] = Math.round(Math.min(1, a) * 255)
    if (a <= 0) continue
    const c = op.tint ? op.tint : [pm[i] / a, pm[i + 1] / a, pm[i + 2] / a]
    for (let j = 0; j < 3; j++) px[i + j] = Math.round(Math.min(1, Math.max(0, c[j])) * 255)
  }
  return `data:image/png;base64,${encodePNG(w, h, px).toString('base64')}`
}

function colour([r, g, b]) {
  const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function stopsXML(stops) {
  return stops
    .map((s) => {
      const op = s.color[3] < 1 ? ` stop-opacity="${fmt(s.color[3], 3)}"` : ''
      return `<stop offset="${fmt(s.at, 4)}" stop-color="${colour(s.color)}"${op}/>`
    })
    .join('')
}

function paintXML(paint, id, defs) {
  if (paint.type === 'solid') {
    const op = paint.color[3] < 1 ? ` fill-opacity="${fmt(paint.color[3], 3)}"` : ''
    return `fill="${colour(paint.color)}"${op}`
  }
  if (paint.type === 'linear') {
    const { x1, y1, x2, y2 } = paint
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}">${stopsXML(paint.stops)}</linearGradient>`
    )
    return `fill="url(#${id})"`
  }
  if (paint.type === 'radial') {
    const { cx, cy, r } = paint
    defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}">${stopsXML(paint.stops)}</radialGradient>`
    )
    return `fill="url(#${id})"`
  }
  throw new Error(`Unknown paint ${paint.type}`)
}

/**
 * `prefix` keeps ids unique when several SVGs are inlined in one page.
 * `digits` is the coordinate precision.
 */
export function sceneToSVG(scene, w, h, { prefix = 'a', digits = 2, title } = {}) {
  const defs = []
  let body = []
  let n = 0
  for (const op of scene) {
    const id = `${prefix}${n++}`
    const rule = op.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''
    if (op.op === 'fill') {
      const opacity = op.opacity != null && op.opacity < 1 ? ` opacity="${fmt(op.opacity, 3)}"` : ''
      let clip = ''
      if (op.clip) {
        defs.push(`<clipPath id="${id}c"><path d="${op.clip.toSVG(digits)}"${op.clipRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`)
        clip = ` clip-path="url(#${id}c)"`
      }
      body.push(`<path d="${op.path.toSVG(digits)}"${rule} ${paintXML(op.paint, id, defs)}${opacity}${clip}/>`)
    } else if (op.op === 'shadow') {
      defs.push(
        `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${fmt(op.sigma, 3)}"/></filter>`
      )
      const p = op.path.translate(op.dx ?? 0, op.dy ?? 0)
      const op1 = op.color[3] < 1 ? ` fill-opacity="${fmt(op.color[3], 3)}"` : ''
      body.push(`<path d="${p.toSVG(digits)}"${rule} fill="${colour(op.color)}"${op1} filter="url(#${id})"/>`)
    } else if (op.op === 'clip') {
      defs.push(`<clipPath id="${id}"><path d="${op.path.toSVG(digits)}"${op.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`)
      body = [`<g clip-path="url(#${id})">${body.join('')}</g>`]
    } else if (op.op === 'erase') {
      defs.push(
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/><path d="${op.path.toSVG(digits)}"${rule} fill="#000"/></mask>`
      )
      body = [`<g mask="url(#${id})">${body.join('')}</g>`]
    } else if (op.op === 'image' || op.op === 'halo') {
      const at = `x="${fmt(op.x)}" y="${fmt(op.y)}" width="${fmt(op.w)}" height="${fmt(op.h)}" preserveAspectRatio="none"`
      if (op.op === 'image') {
        const opacity = op.opacity != null && op.opacity < 1 ? ` opacity="${fmt(op.opacity, 3)}"` : ''
        body.push(`<image href="${embed(op)}" ${at}${opacity}/>`)
      } else {
        // The rim: the bitmap's shape grown and filled with one colour.
        const blur = op.sigma ? `<feGaussianBlur in="grow" stdDeviation="${fmt(op.sigma, 3)}" result="grow"/>` : ''
        defs.push(
          `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feMorphology in="SourceAlpha" operator="dilate" radius="${fmt(op.radius, 3)}" result="grow"/>${blur}<feFlood flood-color="${colour(op.color)}" flood-opacity="${fmt(op.color[3], 3)}"/><feComposite operator="in" in2="grow"/></filter>`
        )
        body.push(`<image href="${embed({ ...op, tint: [0, 0, 0] })}" ${at} filter="url(#${id})"/>`)
      }
    }
  }
  const t = title ? `<title>${title}</title>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    t +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    `</svg>\n`
  )
}
