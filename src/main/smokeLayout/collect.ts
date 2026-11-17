/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The layout checker's in-page half: a script body (for Chrome.js, which
// wraps it in a function and JSON-encodes the result) that walks the visible
// DOM and returns a LayoutSnapshot for check.ts. Hidden, zero-opacity,
// aria-hidden, inert and [data-layout-ignore] subtrees are left out, as are
// textless decorative layers (absolutely positioned, pointer-events: none) and
// visually hidden screen-reader text. Resize seams (role=separator) straddle
// edges on purpose, so they do not count as controls.

export const COLLECT_SCRIPT = String.raw`
const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=switch], [role=checkbox], [role=radio], [role=option], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])'
const LEAF = new Set(['svg', 'img', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'picture', 'object', 'embed', 'audio', 'math'])
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'head'])
const g = document.createElement('canvas').getContext('2d')
const nodes = []
const round = (v) => Math.round(v * 10) / 10
const desc = (el) => {
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter((c) => c && !/^(is-|has-)/.test(c)).slice(0, 2)
  if (cls.length) return '.' + cls.join('.')
  const role = el.getAttribute('role')
  if (role) return tag + '[role=' + role + ']'
  if (el.id && /^[a-z][\w-]*$/i.test(el.id)) return tag + '#' + el.id
  return tag
}
const textParts = (el) => {
  const parts = []
  for (const c of el.childNodes) {
    if (c.nodeType === 3) { if (c.nodeValue.trim()) parts.push(c) }
    else if (c.nodeType === 1 && !LEAF.has(c.tagName.toLowerCase()) && c.getAttribute('aria-hidden') !== 'true' && getComputedStyle(c).display === 'inline' && c.textContent.trim()) parts.push(c)
  }
  return parts
}
const range = document.createRange()
/** Where the own text is drawn (unclipped), or null. */
const textBox = (parts) => {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const c of parts) {
    range.selectNodeContents(c)
    for (const q of range.getClientRects()) {
      if (q.width === 0 && q.height === 0) continue
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom)
    }
  }
  return l > r ? null : { x: round(l), y: round(t), w: round(r - l), h: round(b - t) }
}
const widestWord = (cs, text) => {
  try { g.font = cs.font || (cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily) } catch {}
  const ls = parseFloat(cs.letterSpacing) || 0
  const upper = cs.textTransform === 'uppercase'
  let max = 0
  for (const w of text.split(' ').slice(0, 80)) {
    const word = upper ? w.toUpperCase() : w
    const m = g.measureText(word).width + ls * word.length
    if (m > max) max = m
  }
  return Math.round(max)
}
const walk = (el, p) => {
  if (nodes.length >= 12000) return
  const tag = el.tagName.toLowerCase()
  if (SKIP.has(tag)) return
  if (el.hasAttribute('data-layout-ignore') || el.getAttribute('aria-hidden') === 'true' || el.inert) return
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return
  if ((cs.position === 'absolute' || cs.position === 'fixed') && cs.pointerEvents === 'none' && !el.textContent.trim()) return
  if (cs.display === 'contents') {
    for (const c of el.children) walk(c, p)
    return
  }
  const b = el.getBoundingClientRect()
  // Visually hidden text for screen readers (a 1 px clipped box) is not laid out for the eye.
  if (b.width <= 2 && b.height <= 2 && (cs.overflowX !== 'visible' || cs.clip !== 'auto' || cs.clipPath !== 'none')) return
  const parts = LEAF.has(tag) ? [] : textParts(el)
  const own = parts.map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim()
  const tb = own ? textBox(parts) : null
  const label = own || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || ''
  const i = nodes.length
  const node = {
    p, end: i + 1, sel: desc(el), tag, text: label.replace(/\s+/g, ' ').trim().slice(0, 80), own: Boolean(own),
    x: round(b.left), y: round(b.top), w: round(b.width), h: round(b.height),
    sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
    pw: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
    ox: cs.overflowX, oy: cs.overflowY, disp: cs.display, pos: cs.position, to: cs.textOverflow, ws: cs.whiteSpace,
    clamp: Boolean(cs.webkitLineClamp && cs.webkitLineClamp !== 'none'),
    brk: cs.overflowWrap === 'anywhere' || cs.overflowWrap === 'break-word' || cs.wordBreak === 'break-all' || cs.wordBreak === 'break-word',
    inter: el.matches(INTERACTIVE) && el.getAttribute('role') !== 'separator', fs: parseFloat(cs.fontSize) || 0, minc: own ? widestWord(cs, own) : 0,
    tx: tb ? tb.x : round(b.left), ty: tb ? tb.y : round(b.top), tw: tb ? tb.w : round(b.width), th: tb ? tb.h : round(b.height),
  }
  nodes.push(node)
  if (!LEAF.has(tag)) for (const c of el.children) walk(c, i)
  node.end = nodes.length
}
walk(document.body, -1)
const root = document.documentElement
return { vw: root.clientWidth, vh: root.clientHeight, docW: root.scrollWidth, rootOy: getComputedStyle(root).overflowY, nodes }
`

/** Waits until the page stops changing (element count and size the same for three polls), up to `maxMs`. */
export const SETTLE_SCRIPT = String.raw`
return (async () => {
  try { await document.fonts.ready } catch {}
  const sig = () => document.getElementsByTagName('*').length + ':' + document.body.scrollHeight + ':' + document.body.scrollWidth
  let last = sig(), same = 0
  const start = Date.now()
  while (same < 3 && Date.now() - start < __MAX__) {
    await new Promise((r) => setTimeout(r, 120))
    const now = sig()
    same = now === last ? same + 1 : 0
    last = now
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return true
})()
`
