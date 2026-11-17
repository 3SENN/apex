/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { desktopCapturer, screen, systemPreferences, type NativeImage, type WebContents } from 'electron'
import { z } from 'zod'
import { IMAGE_ATTACHMENT_BASE64_MAX } from '@shared/chats'
import type { CaptureMasker } from '../features/personalRuntime'
import { errorMessage, log } from '../log'
import { isTextInput, type FocusInfo } from './router'

// The Electron side of a voice turn: reading the focused field, typing into
// it, and the screenshot. Tab captures always go through the CaptureMasker,
// so guarded fields are painted over before an image leaves main; when the
// masker is missing there is no image at all (never unmasked).

/** The longest edge of an attached screenshot, in pixels. */
export const SHOT_MAX_EDGE = 1568
const THUMB_WIDTH = 240
const FOCUS_TIMEOUT_MS = 800

export interface Shot {
  /** base64 JPEG for the chat attachment. */
  data: string
  /** A small JPEG data URL for the launcher's chip. */
  thumbnail: string
}

export type ShotResult = { ok: true; shot: Shot } | { ok: false; reason: 'screen-missing' | 'no-screenshot' }

const focusSchema = z
  .object({
    editable: z.boolean(),
    rich: z.boolean(),
    value: z.string().max(20_000),
    attrs: z
      .object({
        tag: z.enum(['input', 'select', 'textarea']),
        type: z.string().max(40),
        autocomplete: z.string().max(200),
        name: z.string().max(200),
        id: z.string().max(200),
        placeholder: z.string().max(200),
        label: z.string().max(200),
        inputMode: z.string().max(40),
        maxLength: z.number().int().nullable(),
      })
      .nullable(),
  })
  .nullable()

// Runs in the focused frame. It only reads the focused element (through open
// shadow roots); main validates what comes back and classifies it itself.
const FOCUS_SCRIPT = `(() => {
  let el = document.activeElement
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const tag = el.tagName.toLowerCase()
  const field = tag === 'input' || tag === 'textarea' || tag === 'select'
  if (!field && !el.isContentEditable) return { editable: false, rich: false, value: '', attrs: null }
  const cut = (s, n) => String(s || '').trim().slice(0, n)
  const label = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || ''
  const attrs = field ? {
    tag,
    type: cut(el.getAttribute('type') || (tag === 'input' ? 'text' : ''), 40).toLowerCase(),
    autocomplete: cut(el.getAttribute('autocomplete'), 200),
    name: cut(el.getAttribute('name'), 200),
    id: cut(el.id, 200),
    placeholder: cut(el.getAttribute('placeholder'), 200),
    label: cut(label, 200),
    inputMode: cut(el.getAttribute('inputmode'), 40),
    maxLength: el.maxLength > 0 ? el.maxLength : null,
  } : null
  const locked = Boolean(el.disabled || el.readOnly) || tag === 'select'
  return { editable: !locked, rich: !field, value: String(field ? el.value || '' : el.innerText || '').slice(0, 20000), attrs }
})()`

export interface FocusRead extends FocusInfo {
  /** The field's current text, for the optional rewrite. */
  value: string
}

/** What has focus in `wc` (its focused frame, cross-origin frames included). Null when nothing editable, or on any failure. */
export async function readFocus(wc: WebContents): Promise<FocusRead | null> {
  if (wc.isDestroyed()) return null
  const frame = wc.focusedFrame ?? wc.mainFrame
  try {
    const raw = await Promise.race([
      frame.executeJavaScript(FOCUS_SCRIPT),
      new Promise((resolve) => setTimeout(() => resolve(null), FOCUS_TIMEOUT_MS)),
    ])
    const parsed = focusSchema.safeParse(raw)
    if (!parsed.success || !parsed.data) return null
    const { editable, rich, value, attrs } = parsed.data
    return { editable: editable && (rich || (attrs !== null && isTextInput(attrs))), rich, value, attrs }
  } catch (err) {
    log.debug('voice', 'focus read failed', { error: errorMessage(err) })
    return null
  }
}

/** Types `text` at the caret of the focused field. */
export async function insertText(wc: WebContents, text: string): Promise<void> {
  if (wc.isDestroyed()) throw new Error('The page closed.')
  await wc.insertText(text)
}

/** Replaces the focused field's whole text (the rewrite). */
export async function replaceFieldText(wc: WebContents, text: string): Promise<void> {
  if (wc.isDestroyed()) throw new Error('The page closed.')
  wc.selectAll()
  await wc.insertText(text)
}

function toShot(image: NativeImage): Shot | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(size.width, size.height, 1))
  const sized = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' }) : image
  let data = sized.toJPEG(80).toString('base64')
  if (data.length > IMAGE_ATTACHMENT_BASE64_MAX) data = sized.toJPEG(55).toString('base64')
  if (data.length > IMAGE_ATTACHMENT_BASE64_MAX) return null
  const thumb = sized.resize({ width: THUMB_WIDTH, quality: 'good' })
  return { data, thumbnail: `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}` }
}

/** The active tab, masked. Without the real masker there is no image. */
export async function captureTab(masker: CaptureMasker, tabId: string): Promise<ShotResult> {
  try {
    const image = await masker.capture(tabId, { maxEdge: SHOT_MAX_EDGE })
    const shot = toShot(image)
    return shot ? { ok: true, shot } : { ok: false, reason: 'no-screenshot' }
  } catch (err) {
    log.warn('voice', 'tab screenshot skipped', { error: errorMessage(err) })
    return { ok: false, reason: 'no-screenshot' }
  }
}

/** Screen Recording permission, as macOS reports it (never prompts). */
export function screenAllowed(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    return false
  }
}

/**
 * One display, through desktopCapturer, when Screen Recording is granted.
 * `keepOut` (FloatManager.keepOutOf) keeps Atelier's floats out of it: content
 * protection on macOS and Windows, hiding them for the capture on Linux.
 * Smoke never captures the real screen.
 */
export async function captureScreen(
  point: 'cursor' | { x: number; y: number; width: number; height: number },
  smoke: boolean,
  keepOut: <T>(capture: () => Promise<T>) => Promise<T> = (capture) => capture(),
): Promise<ShotResult> {
  if (smoke || !screenAllowed()) return { ok: false, reason: 'screen-missing' }
  try {
    const display = point === 'cursor' ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : screen.getDisplayMatching(point)
    const { width, height } = display.size
    const scale = Math.min(display.scaleFactor, SHOT_MAX_EDGE / Math.max(width, height, 1))
    const sources = await keepOut(() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } }))
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    const shot = source ? toShot(source.thumbnail) : null
    return shot ? { ok: true, shot } : { ok: false, reason: 'no-screenshot' }
  } catch (err) {
    log.warn('voice', 'screen screenshot skipped', { error: errorMessage(err) })
    return { ok: false, reason: 'no-screenshot' }
  }
}
