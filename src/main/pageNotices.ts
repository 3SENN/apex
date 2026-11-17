/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OverlayResult, SurfaceAnchor } from '@shared/overlay'
import { PAGE_NOTICE_ANSWERS, type PageNoticeAnswer, type PageNoticeProps } from '@shared/safety'
import { toasts } from './dialogs'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'

// Page notices (SS-07): one popup-blocked surface per tab,
// anchored to the tab's pane. A second blocked pop-up on the same page updates
// the open notice instead of stacking another. Until the overlay host can draw
// (before M1, or a renderer that won't), a toast with the main action stands
// in, so nothing is blocked silently.

interface Open {
  instanceId: string | null
  kind: PageNoticeProps['kind']
}

const open = new Map<string, Open>()

function isAnswer(value: unknown): value is PageNoticeAnswer {
  return typeof value === 'string' && (PAGE_NOTICE_ANSWERS as readonly string[]).includes(value)
}

/** The toast that stands in: its one action is the notice's main answer. */
function fallbackSpec(p: PageNoticeProps): { text: string; detail: string; action: { id: string; label: string }; answer: PageNoticeAnswer } {
  switch (p.kind) {
    case 'popup':
      return { text: mainT('safety.notice.popup', { count: p.count }), detail: mainT('safety.notice.popupDetail', { host: p.host, target: p.target }), action: { id: 'once', label: mainT('safety.notice.allowOnce') }, answer: 'once' }
    case 'redirect':
      return { text: mainT('safety.notice.redirect'), detail: mainT('safety.notice.redirectDetail', { host: p.host, target: p.target }), action: { id: 'once', label: mainT('safety.notice.open') }, answer: 'once' }
    case 'downloads':
      return { text: mainT('safety.notice.downloads'), detail: mainT('safety.notice.downloadsDetail', { host: p.host }), action: { id: 'once', label: mainT('safety.notice.allowOnce') }, answer: 'once' }
    case 'unresponsive':
      return { text: mainT('safety.notice.unresponsive'), detail: mainT('safety.notice.unresponsiveDetail'), action: { id: 'reload', label: mainT('safety.notice.reload') }, answer: 'reload' }
  }
}

/** Opens the notice (or refreshes the one already showing) and resolves with what the person chose. */
export async function showPageNotice(win: WindowContext, props: PageNoticeProps): Promise<PageNoticeAnswer | null> {
  const current = open.get(props.tabId)
  if (current && current.kind === props.kind && current.instanceId) {
    win.overlay.update(current.instanceId, props)
    return null
  }
  if (current?.instanceId) win.overlay.close(current.instanceId)
  const anchor: SurfaceAnchor = { kind: 'tab', tabId: props.tabId, rect: null }
  const host = win.overlay as typeof win.overlay & { openSurfaces?: () => { instanceId: string; surface: string }[] }
  const before = new Set((host.openSurfaces?.() ?? []).map((s) => s.instanceId))
  let result: Promise<OverlayResult>
  try {
    result = win.overlay.open('popup-blocked', anchor, props, { tabId: props.tabId })
  } catch (err) {
    result = Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  const added = (host.openSurfaces?.() ?? []).find((s) => s.surface === 'popup-blocked' && !before.has(s.instanceId))
  const entry: Open = { instanceId: added?.instanceId ?? null, kind: props.kind }
  open.set(props.tabId, entry)
  try {
    const outcome = await result
    return 'value' in outcome && isAnswer(outcome.value) ? outcome.value : null
  } catch (err) {
    log.debug('pageNotices', 'Overlay unavailable, a toast stands in', { error: err instanceof Error ? err.message : String(err) })
    const spec = fallbackSpec(props)
    try {
      const outcome = await Promise.resolve(toasts.show(win, { kind: 'info', text: spec.text, detail: spec.detail, action: spec.action, tabId: props.tabId }))
      return outcome === 'action' ? spec.answer : null
    } catch {
      return null
    }
  } finally {
    if (open.get(props.tabId) === entry) open.delete(props.tabId)
  }
}

/** Closes a tab's notice (it navigated, recovered or closed). */
export function closePageNotice(win: WindowContext, tabId: string, kind?: PageNoticeProps['kind']): void {
  const current = open.get(tabId)
  if (!current || (kind && current.kind !== kind)) return
  open.delete(tabId)
  if (current.instanceId) win.overlay.close(current.instanceId)
}
