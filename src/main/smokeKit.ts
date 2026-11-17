/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, nativeImage, webContents as allWebContents, type NativeImage, type WebContents } from 'electron'
import type { TabManager } from './tabs'

// Small helpers shared by the smoke test's parts: waiting, driving the
// chrome through its own preload API, and capturing the window as it looks
// on screen (the chrome plus the native page views drawn over it).

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what = 'the browser to be ready'): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}.`)
    await sleep(50)
  }
}

/** Drives the chrome renderer: scripts, IPC calls as the UI makes them, and DOM waits. */
export class Chrome {
  constructor(readonly ui: WebContents) {}

  /** Runs a script in the chrome and returns its JSON-safe result. */
  async js<T = unknown>(script: string): Promise<T> {
    // DOM nodes come back as true: React's fiber fields on them are circular.
    const raw: unknown = await this.ui.executeJavaScript(
      `Promise.resolve((() => { ${script} })()).then((v) => JSON.stringify(v === undefined ? null : v, (_k, x) => (x instanceof Node ? true : x)))`,
    )
    return JSON.parse(String(raw)) as T
  }

  /** A service call made through window.atelier.invoke, exactly as the UI makes it. Rejections keep main's message. */
  async invoke<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T> {
    const out = await this.js<{ ok: boolean; v?: T; e?: string }>(
      `return window.atelier.invoke(${JSON.stringify(service)}, ${JSON.stringify(method)}, ...${JSON.stringify(args)}).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String((e && e.message) || e) }))`,
    )
    if (!out.ok) throw new Error((out.e ?? 'failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    return out.v as T
  }

  /** Waits until a script returns something truthy, and returns it. */
  async until<T>(script: string, timeoutMs: number, what: string): Promise<T> {
    let value: T | null = null
    await waitFor(async () => {
      value = await this.js<T>(script).catch(() => null)
      return Boolean(value)
    }, timeoutMs, what)
    return value as T
  }

  /** Clicks the first visible, enabled button (or link) whose text or label matches, waiting for it to appear. */
  async click(pattern: RegExp, scope = 'document', timeoutMs = 5000): Promise<void> {
    await this.until<boolean>(
      `const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)})
       const root = ${scope}
       if (!root) return false
       const els = [...root.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"]')]
       const el = els.find((b) => b.getClientRects().length > 0 && !b.disabled && (re.test((b.textContent || '').trim()) || re.test(b.getAttribute('aria-label') || '')))
       if (!el) return false
       el.click()
       return true`,
      timeoutMs,
      `a button matching ${pattern}`,
    )
  }

  /** Types into a React-controlled field the way a user would (native setter, then an input event). */
  async type(selector: string, text: string): Promise<void> {
    const ok = await this.js<boolean>(`
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.focus()
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true`)
    assert(ok, `no field ${selector}`)
  }

  /** Presses Escape on the focused element (closes dialogs and sheets). */
  async escape(): Promise<void> {
    await this.js(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  }
}

/**
 * The document that draws `selector`: the window's interactive overlay tier
 * (confirmations, dialogs and sheets open there, OV-08) or the chrome itself
 * (the in-page fallback). Waits for it to appear.
 */
export async function docWith(chrome: Chrome, selector: string, timeoutMs: number, what: string, { overlayOnly = false }: { overlayOnly?: boolean } = {}): Promise<Chrome> {
  const owner = BrowserWindow.fromWebContents(chrome.ui)
  let found: Chrome = chrome
  await waitFor(async () => {
    const overlays = allWebContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('overlay=interactive') && (!owner || BrowserWindow.fromWebContents(wc) === owner || BrowserWindow.fromWebContents(wc) === null))
    // overlayOnly: the chrome can hold a matching element of its own (a hidden list, say).
    for (const doc of [...overlays.map((wc) => new Chrome(wc)), ...(overlayOnly ? [] : [chrome])]) {
      if (await doc.js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)) {
        found = doc
        return true
      }
    }
    return false
  }, timeoutMs, what)
  return found
}

/** The corner radius the page views are drawn with (what setLayout gave them), never a guess. */
export function pageRadius(layout: { radius?: number | null }): number {
  const r = layout.radius ?? 0
  return Number.isFinite(r) && r > 0 ? Math.round(r) : 0
}

/** Copies a page capture into the window bitmap at its bounds, leaving the rounded corners to the chrome. */
export function blit(target: Buffer, targetWidth: number, source: Buffer, bounds: { x: number; y: number; width: number; height: number }, radius: number): void {
  const { x: ox, y: oy, width, height } = bounds
  const targetHeight = target.length / 4 / targetWidth
  for (let y = 0; y < height; y++) {
    const ty = oy + y
    if (ty < 0 || ty >= targetHeight) continue
    for (let x = 0; x < width; x++) {
      const tx = ox + x
      if (tx < 0 || tx >= targetWidth) continue
      // Outside a rounded corner the chrome shows through.
      const cx = x < radius ? radius - x : x >= width - radius ? x - (width - radius - 1) : 0
      const cy = y < radius ? radius - y : y >= height - radius ? y - (height - radius - 1) : 0
      if (cx > 0 && cy > 0 && cx * cx + cy * cy > radius * radius) continue
      const s = (y * width + x) * 4
      const t = (ty * targetWidth + tx) * 4
      source.copy(target, t, s, s + 4)
    }
  }
}

/** The compositor can fail a capture now and then (UnknownVizError); a moment later it works. */
async function captureWithRetry(capture: () => Promise<NativeImage>, attempts = 4): Promise<NativeImage> {
  for (let i = 1; ; i++) {
    try {
      return await capture()
    } catch (err) {
      if (i >= attempts) throw err
      await sleep(250 * i)
    }
  }
}

/**
 * The window as it looks on screen, at 1x: the chrome's own capture plus
 * every visible page view composited at its bounds (the chrome's capture
 * leaves those areas empty, since native views draw above it).
 */
export async function captureWindow(ui: WebContents, tabs: TabManager): Promise<NativeImage> {
  // A window behind others may not repaint on its own; without this the capture can be a frame old.
  const window = BrowserWindow.fromWebContents(ui)
  window?.moveTop()
  ui.invalidate()
  // Two animation frames: React has committed and the compositor has drawn it.
  await Promise.race([ui.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), sleep(1000)])
  await sleep(80)
  const shot = await captureWithRetry(() => ui.capturePage())
  // The capture is in device pixels; layout bounds are in window points.
  const { width, height } = window ? window.getContentBounds() : shot.getSize()
  const base = shot.resize({ width, height, quality: 'best' })
  const bitmap = Buffer.from(base.toBitmap())
  // The views' real corner radius (DS-01: square on the sheet; DS-02: rounded only as an inset card beside a chat).
  const radius = pageRadius(tabs.layoutBounds())
  for (const tab of tabs.all()) {
    if (!tab.view.getVisible()) continue
    const bounds = tab.view.getBounds()
    if (bounds.width === 0 || bounds.height === 0) continue
    const page = await captureWithRetry(() => tab.view.webContents.capturePage())
    if (page.isEmpty()) continue
    const scaled = page.resize({ width: bounds.width, height: bounds.height, quality: 'best' })
    blit(bitmap, width, Buffer.from(scaled.toBitmap()), bounds, radius)
  }
  // The overlay tiers draw above the pages; their transparent pixels let the window show through.
  for (const layer of overlayLayers?.(ui) ?? []) {
    if (layer.wc.isDestroyed() || layer.bounds.width === 0 || layer.bounds.height === 0) continue
    const image = await captureWithRetry(() => layer.wc.capturePage())
    if (image.isEmpty()) continue
    const scaled = image.resize({ width: layer.bounds.width, height: layer.bounds.height, quality: 'best' })
    blendOver(bitmap, width, Buffer.from(scaled.toBitmap()), layer.bounds)
  }
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

// The smoke shots show overlay surfaces: tooltips, the sheet, notices
type OverlayLayers = (ui: WebContents) => { wc: WebContents; bounds: { x: number; y: number; width: number; height: number } }[]
let overlayLayers: OverlayLayers | null = null

/** The window manager says where each window's overlay tiers are, so captureWindow can draw them. */
export function setOverlayLayers(fn: OverlayLayers | null): void {
  overlayLayers = fn
}

/** Draws a premultiplied BGRA image over the target at `bounds` (source-over). */
export function blendOver(target: Buffer, targetWidth: number, source: Buffer, bounds: { x: number; y: number; width: number; height: number }): void {
  const { x: ox, y: oy, width, height } = bounds
  const targetHeight = target.length / 4 / targetWidth
  for (let y = 0; y < height; y++) {
    const ty = oy + y
    if (ty < 0 || ty >= targetHeight) continue
    for (let x = 0; x < width; x++) {
      const tx = ox + x
      if (tx < 0 || tx >= targetWidth) continue
      const s = (y * width + x) * 4
      const a = (source[s + 3] ?? 0) / 255
      if (a === 0) continue
      const t = (ty * targetWidth + tx) * 4
      for (let c = 0; c < 3; c++) target[t + c] = Math.min(255, Math.round((source[s + c] ?? 0) + (target[t + c] ?? 0) * (1 - a)))
      target[t + 3] = 255
    }
  }
}
