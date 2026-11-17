/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PageTweakMessage, PickerStrings } from '@shared/tweaks'
import { describeNode, selectorFor, type SelectorNode } from '@shared/tweaksSelector'

// The picker (TWK-02): picking elements on the page to hide, started from
// site info or apex://tweaks. A full-window layer in a closed shadow root
// takes the pointer while it is up, so the page sees no hovers or clicks, and
// finds what is under the pointer with elementsFromPoint (frames and shadow
// hosts included). Click or Enter hides the outlined element; ↑ and ↓ widen
// and narrow it, ← and → step to its siblings; ⌘Z or Ctrl+Z, or Undo, puts
// the last one back; Esc or Done finishes. Main stores each pick as a selector
// on the site's tweak and sends the new rules back, which is what hides it.
// The words come from main in the app language. Colours are the picker's own
// tokens, light and dark with the system scheme, as the page's CSS can't reach them.

export interface PickerDeps {
  send(message: PageTweakMessage): void
  onEnd(): void
}

export interface Picker {
  update(count: string, announce: string): void
  stop(): void
}

const STYLE = `
:host { --p-accent: #6a4bff; --p-on-accent: #ffffff; --p-fill: rgba(106, 75, 255, 0.16); --p-surface: #ffffff; --p-text: #1d1c1a; --p-muted: #5f5d58; --p-border: rgba(0, 0, 0, 0.14); --p-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); }
@media (prefers-color-scheme: dark) {
  :host { --p-accent: #9d87ff; --p-on-accent: #17142b; --p-fill: rgba(157, 135, 255, 0.2); --p-surface: #2b2a28; --p-text: #f3f1ec; --p-muted: #b7b3aa; --p-border: rgba(255, 255, 255, 0.16); --p-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
}
* { box-sizing: border-box; }
.stage { position: fixed; inset: 0; cursor: crosshair; outline: none; background: transparent; }
.box { position: fixed; left: 0; top: 0; width: 0; height: 0; border: 2px solid var(--p-accent); border-radius: 4px; background: var(--p-fill); pointer-events: none; display: none; }
.box[data-on] { display: block; }
.tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; max-width: min(360px, 80vw); padding: 2px 8px; border-radius: 6px; background: var(--p-accent); color: var(--p-on-accent); font: 600 11px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.box[data-low] .tag { bottom: auto; top: 100%; margin: 4px 0 0; }
.bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px); padding: 10px 10px 10px 16px; border: 1px solid var(--p-border); border-radius: 14px; background: var(--p-surface); color: var(--p-text); box-shadow: var(--p-shadow); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: default; }
.text { display: grid; gap: 2px; min-width: 0; }
.hint { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.keys { margin: 0; color: var(--p-muted); font-size: 12px; overflow-wrap: anywhere; }
.count { flex: none; color: var(--p-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
button { flex: none; height: 30px; padding: 0 12px; border: 1px solid var(--p-border); border-radius: 8px; background: transparent; color: var(--p-text); font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; }
button.primary { border-color: transparent; background: var(--p-accent); color: var(--p-on-accent); }
button:focus-visible, .stage:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .box { transition: transform 70ms ease-out, width 70ms ease-out, height 70ms ease-out; } }
`

const SKIP = new Set(['html', 'body', 'head'])

/** A DOM element as the selector builder reads it. */
export function selectorNode(el: Element): SelectorNode {
  const same = (): Element[] => (el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.localName === el.localName) : [el])
  return {
    tag: el.localName,
    id: el.id,
    classes: Array.from(el.classList),
    attr: (name) => el.getAttribute(name),
    get parent() {
      return el.parentElement ? selectorNode(el.parentElement) : null
    },
    get nthOfType() {
      return same().indexOf(el) + 1
    },
    get ofType() {
      return same().length
    },
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function shadowStyle(root: ShadowRoot): void {
  try {
    // A constructed sheet is CSSOM, so the page's style-src policy doesn't stop it.
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(STYLE)
    root.adoptedStyleSheets = [sheet]
  } catch {
    root.append(el('style', '', STYLE))
  }
}

export function startPicker(strings: PickerStrings, deps: PickerDeps): Picker {
  const previousFocus = document.activeElement as HTMLElement | null
  const host = document.createElement('apex-tweak-picker')
  host.setAttribute('style', 'all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;')
  const root = host.attachShadow({ mode: 'closed' })
  shadowStyle(root)

  const stage = el('div', 'stage')
  stage.tabIndex = -1
  stage.setAttribute('role', 'application')
  stage.setAttribute('aria-label', strings.title)
  stage.setAttribute('aria-describedby', 'p-hint p-keys')
  const box = el('div', 'box')
  box.setAttribute('aria-hidden', 'true')
  const tag = el('div', 'tag')
  box.append(tag)
  const bar = el('div', 'bar')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', strings.title)
  const text = el('div', 'text')
  const hint = el('p', 'hint', strings.hint)
  hint.id = 'p-hint'
  const keys = el('p', 'keys', strings.keys)
  keys.id = 'p-keys'
  text.append(hint, keys)
  const count = el('span', 'count', strings.count)
  count.setAttribute('role', 'status')
  const undo = el('button', '', strings.undo)
  undo.type = 'button'
  const done = el('button', 'primary', strings.done)
  done.type = 'button'
  bar.append(text, count, undo, done)
  const live = el('div', 'sr')
  live.setAttribute('aria-live', 'assertive')
  root.append(stage, box, bar, live)
  document.documentElement.append(host)

  let current: Element | null = null
  /** The narrower elements ↑ left, so ↓ walks back down the same way. */
  let trail: Element[] = []
  let frame = 0
  let stopped = false

  const usable = (node: Element | null): Element | null => {
    let n = node
    // A part of an SVG drawing stands for the whole drawing.
    while (n && n.parentElement && n.closest('svg') && n.localName !== 'svg') n = n.closest('svg')
    return n && n !== host && !SKIP.has(n.localName) && n.isConnected ? n : null
  }
  const under = (x: number, y: number): Element | null => usable(document.elementsFromPoint(x, y).find((n) => n !== host) ?? null)

  const draw = (): void => {
    frame = 0
    if (!current || !current.isConnected) {
      box.removeAttribute('data-on')
      return
    }
    const r = current.getBoundingClientRect()
    box.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`
    box.style.width = `${Math.max(0, Math.round(r.width))}px`
    box.style.height = `${Math.max(0, Math.round(r.height))}px`
    box.toggleAttribute('data-low', r.top < 28)
    tag.textContent = describeNode(selectorNode(current), '')
    box.setAttribute('data-on', '')
  }
  const redraw = (): void => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  const pick = (node: Element | null, keepTrail = false): void => {
    if (!keepTrail) trail = []
    current = usable(node)
    redraw()
  }

  const hideCurrent = (): void => {
    if (!current) return
    const node = selectorNode(current)
    const selector = selectorFor(node, (sel) => document.querySelectorAll(sel).length)
    if (!selector) return
    const words = (current.textContent ?? '').slice(0, 200)
    deps.send({ kind: 'hide', selector, label: describeNode(node, words) })
    current = null
    trail = []
    redraw()
  }

  const onMove = (e: PointerEvent): void => {
    const next = under(e.clientX, e.clientY)
    if (next !== current) pick(next)
  }
  const onDown = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!current) pick(under(e.clientX, e.clientY))
    hideCurrent()
  }
  const inBar = (e: Event): boolean => e.composedPath().includes(bar)
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    let handled = true
    if (e.key === 'Escape') stop(true)
    else if (mod && e.key.toLowerCase() === 'z') deps.send({ kind: 'undo' })
    else if (e.key === 'ArrowUp') {
      const up = current?.parentElement ?? null
      if (current && usable(up)) {
        trail.push(current)
        pick(up, true)
      }
    } else if (e.key === 'ArrowDown') {
      const down = trail.pop() ?? current?.firstElementChild ?? null
      if (down) pick(down, true)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const side = e.key === 'ArrowLeft' ? current?.previousElementSibling : current?.nextElementSibling
      if (side) pick(side)
    } else if ((e.key === 'Enter' || e.key === ' ') && !inBar(e)) hideCurrent()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  const stop = (tell: boolean): void => {
    if (stopped) return
    stopped = true
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', redraw, true)
    window.removeEventListener('resize', redraw)
    if (frame) cancelAnimationFrame(frame)
    host.remove()
    if (tell) deps.send({ kind: 'done' })
    deps.onEnd()
    try {
      previousFocus?.focus?.({ preventScroll: true })
    } catch {
      // The element went away; focus stays on the page.
    }
  }

  stage.addEventListener('pointermove', onMove)
  stage.addEventListener('pointerdown', onDown)
  stage.addEventListener('mousedown', onDown)
  stage.addEventListener('click', onClick)
  stage.addEventListener('contextmenu', onDown)
  undo.addEventListener('click', () => deps.send({ kind: 'undo' }))
  done.addEventListener('click', () => stop(true))
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', redraw, true)
  window.addEventListener('resize', redraw)

  // Start on what's in the middle of the window, so the keys have something to move.
  pick(under(window.innerWidth / 2, window.innerHeight / 3))
  stage.focus({ preventScroll: true })

  return {
    update(nextCount, announce) {
      count.textContent = nextCount
      live.textContent = announce
    },
    stop: () => stop(false),
  }
}
