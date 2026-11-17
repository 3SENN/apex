/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents, WebFrameMain } from 'electron'
import type { ExtNavEvent } from '@shared/extensionShim'

// chrome.webNavigation from Electron's frame events. Frame ids are
// Chromium's own extension frame ids, the ones chrome.tabs.sendMessage
// ({ frameId }) and a message sender's frameId already use: 0 for a tab's
// main frame, the frame-tree node id for any other frame. So an extension
// that lists a tab's frames (a login form in an iframe) can message each one.

/** The parts of WebFrameMain this module reads (tests pass plain objects). */
export interface NavFrame {
  frameTreeNodeId: number
  processId: number
  routingId: number
  url: string
  parent: NavFrame | null
  framesInSubtree: NavFrame[]
}

export interface NavContents {
  id: number
  mainFrame: NavFrame
  isDestroyed(): boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

export interface FrameDetails {
  frameId: number
  parentFrameId: number
  processId: number
  url: string
  errorOccurred: boolean
  frameType: 'outermost_frame' | 'sub_frame'
  documentLifecycle: 'active'
}

const safe = <T>(read: () => T, fallback: T): T => {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Chromium's extension frame id: 0 for the main frame, the frame-tree node id otherwise. */
export function frameIdOf(frame: NavFrame): number {
  return safe(() => frame.parent, null) === null ? 0 : frame.frameTreeNodeId
}

/** The parent's frame id, or -1 for a main frame. */
export function parentFrameIdOf(frame: NavFrame): number {
  const parent = safe(() => frame.parent, null)
  return parent === null ? -1 : frameIdOf(parent)
}

export function frameDetails(frame: NavFrame, errored = false): FrameDetails {
  return {
    frameId: frameIdOf(frame),
    parentFrameId: parentFrameIdOf(frame),
    processId: safe(() => frame.processId, -1),
    url: safe(() => frame.url, ''),
    errorOccurred: errored,
    frameType: frameIdOf(frame) === 0 ? 'outermost_frame' : 'sub_frame',
    documentLifecycle: 'active',
  }
}

/** Every frame of a tab, main frame first (getAllFrames). */
export function allFrames(wc: Pick<NavContents, 'mainFrame' | 'isDestroyed'>, errored: ReadonlySet<number> = new Set()): FrameDetails[] {
  if (wc.isDestroyed()) return []
  const frames = safe(() => wc.mainFrame.framesInSubtree, [] as NavFrame[])
  return frames.map((f) => frameDetails(f, errored.has(frameIdOf(f))))
}

export function findFrame(wc: Pick<NavContents, 'mainFrame' | 'isDestroyed'>, frameId: number): NavFrame | null {
  if (wc.isDestroyed()) return null
  if (frameId === 0) return wc.mainFrame
  return safe(() => wc.mainFrame.framesInSubtree, [] as NavFrame[]).find((f) => f.frameTreeNodeId === frameId && frameIdOf(f) === frameId) ?? null
}

/** An in-page navigation that changed only the fragment is a reference-fragment update; anything else is a history-state one. */
export function inPageKind(previous: string | null, next: string): 'fragment' | 'history' {
  if (!previous) return 'history'
  const strip = (u: string): string => u.split('#')[0] ?? u
  return strip(previous) === strip(next) && previous !== next ? 'fragment' : 'history'
}

export type NavEmit = (event: ExtNavEvent, details: Record<string, unknown>) => void

/**
 * Turns one tab's Electron events into webNavigation events:
 * did-start-navigation → onBeforeNavigate, did-frame-navigate → onCommitted,
 * dom-ready (main frame) and did-frame-finish-load → onDOMContentLoaded and
 * onCompleted, did-navigate-in-page → onHistoryStateUpdated or
 * onReferenceFragmentUpdated, did-fail(-provisional)-load → onErrorOccurred.
 * Returns the unwatch; `errored` collects frames whose last load failed.
 */
export function watchNavigation(
  wc: NavContents,
  emit: NavEmit,
  resolve: (processId: number, routingId: number) => NavFrame | null,
  now: () => number = Date.now,
  errored: Set<number> = new Set(),
): () => void {
  const lastUrl = new Map<number, string>()
  const base = (frame: NavFrame, url?: string): Record<string, unknown> => {
    const d = frameDetails(frame)
    return { tabId: wc.id, url: url ?? d.url, processId: d.processId, frameId: d.frameId, parentFrameId: d.parentFrameId, timeStamp: now(), frameType: d.frameType, documentLifecycle: d.documentLifecycle }
  }
  const byIds = (pid: number, rid: number): NavFrame | null => safe(() => resolve(pid, rid), null)

  const onStart = (details: { url?: string; isSameDocument?: boolean; frame?: NavFrame | null }): void => {
    if (details.isSameDocument || !details.frame) return
    emit('webNavigation.onBeforeNavigate', { ...base(details.frame, details.url), processId: -1 })
  }
  const onCommit = (_e: unknown, url: string, _code: number, _text: string, _main: boolean, pid: number, rid: number): void => {
    const frame = byIds(pid, rid)
    if (!frame) return
    const id = frameIdOf(frame)
    errored.delete(id)
    lastUrl.set(id, url)
    emit('webNavigation.onCommitted', { ...base(frame, url), transitionType: id === 0 ? 'link' : 'auto_subframe', transitionQualifiers: [] })
  }
  const onDomReady = (): void => {
    if (!wc.isDestroyed()) emit('webNavigation.onDOMContentLoaded', base(wc.mainFrame))
  }
  const onFinish = (_e: unknown, isMain: boolean, pid: number, rid: number): void => {
    const frame = isMain ? wc.mainFrame : byIds(pid, rid)
    if (!frame) return
    // Electron reports DOMContentLoaded for the main frame only (dom-ready); a subframe's comes with its load.
    if (!isMain) emit('webNavigation.onDOMContentLoaded', base(frame))
    emit('webNavigation.onCompleted', base(frame))
  }
  const onInPage = (_e: unknown, url: string, _main: boolean, pid: number, rid: number): void => {
    const frame = byIds(pid, rid)
    if (!frame) return
    const id = frameIdOf(frame)
    const kind = inPageKind(lastUrl.get(id) ?? null, url)
    lastUrl.set(id, url)
    emit(kind === 'fragment' ? 'webNavigation.onReferenceFragmentUpdated' : 'webNavigation.onHistoryStateUpdated', { ...base(frame, url), transitionType: 'link', transitionQualifiers: [] })
  }
  const onFail = (_e: unknown, _code: number, description: string, url: string, _main: boolean, pid: number, rid: number): void => {
    const frame = byIds(pid, rid)
    if (!frame) return
    errored.add(frameIdOf(frame))
    emit('webNavigation.onErrorOccurred', { ...base(frame, url), error: `net::${description || 'ERR_FAILED'}` })
  }

  const pairs: Array<[string, (...args: never[]) => void]> = [
    ['did-start-navigation', onStart as (...args: never[]) => void],
    ['did-frame-navigate', onCommit as (...args: never[]) => void],
    ['dom-ready', onDomReady],
    ['did-frame-finish-load', onFinish as (...args: never[]) => void],
    ['did-navigate-in-page', onInPage as (...args: never[]) => void],
    ['did-fail-load', onFail as (...args: never[]) => void],
    ['did-fail-provisional-load', onFail as (...args: never[]) => void],
  ]
  for (const [name, fn] of pairs) wc.on(name, fn)
  return () => {
    if (wc.isDestroyed()) return
    for (const [name, fn] of pairs) wc.off(name, fn)
  }
}

/** Electron's WebContents and WebFrameMain already have this shape. */
export const asNavContents = (wc: WebContents): NavContents => wc as unknown as NavContents
export const asNavFrame = (frame: WebFrameMain | null | undefined): NavFrame | null => (frame ?? null) as unknown as NavFrame | null
