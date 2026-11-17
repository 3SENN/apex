/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session, CallbackResponse, BeforeSendResponse, HeadersReceivedResponse } from 'electron'

// The single owner of session.webRequest handlers. No other
// module calls session.webRequest.on*: features add hooks here, and sandbox
// partitions (atelier-preprocess, atelier-artifacts and the apps' atelier-app-*) are
// locked down here. The mux installs the handlers on every session through
// Feature.session, in a fixed order: ad blocking, privacy, per-site content,
// these hooks, then lockdown. Electron keeps one listener per event, so the
// mux is that listener and runs the layers itself.

export interface WebRequestHooks {
  onBeforeRequest?(details: OnBeforeRequestListenerDetails): CallbackResponse | null
  onBeforeSendHeaders?(details: OnBeforeSendHeadersListenerDetails): BeforeSendResponse | null
  onHeadersReceived?(details: OnHeadersReceivedListenerDetails): HeadersReceivedResponse | null
}

export interface WebRequestHookOptions {
  /** 'web' (the default): browsing sessions only; 'all': every session; or an explicit list. */
  sessions?: 'web' | 'all' | Session[]
}

export type LockdownAllow = (d: { url: string; resourceType: string }) => boolean

const hooks: { hooks: WebRequestHooks; opts: WebRequestHookOptions }[] = []
const lockdowns = new WeakMap<Session, LockdownAllow>()
const lockdownExtras = new WeakMap<Session, WebRequestHooks>()

export const webRequestHooks = {
  add(h: WebRequestHooks, opts: WebRequestHookOptions = {}): () => void {
    const entry = { hooks: h, opts }
    hooks.push(entry)
    return () => {
      const i = hooks.indexOf(entry)
      if (i >= 0) hooks.splice(i, 1)
    }
  },
  /** The hooks that apply to a session, in registration order (read by the mux). */
  for(session: Session, isWebSession: boolean): WebRequestHooks[] {
    return hooks
      .filter(({ opts }) => {
        const scope = opts.sessions ?? 'web'
        if (scope === 'all') return true
        if (scope === 'web') return isWebSession
        return scope.includes(session)
      })
      .map((e) => e.hooks)
  },
}

export const webRequest = {
  /**
   * Every request the allow function refuses is cancelled; a locked-down
   * session gets no other hooks, except `extra`, its owner's own (a pack's keys
   * on requests to their hosts), which runs after the lockdown.
   */
  lockdown(session: Session, allow: LockdownAllow, extra?: WebRequestHooks): void {
    lockdowns.set(session, allow)
    if (extra) lockdownExtras.set(session, extra)
    else lockdownExtras.delete(session)
  },
  lockdownFor(session: Session): LockdownAllow | undefined {
    return lockdowns.get(session)
  },
}


type Headers = Record<string, string | string[]>

/** The first layer that cancels or redirects wins; the rest never see the request. */
export function runBeforeRequest(layers: readonly WebRequestHooks[], details: OnBeforeRequestListenerDetails): CallbackResponse {
  for (const layer of layers) {
    const r = safely(() => layer.onBeforeRequest?.(details))
    if (r && (r.cancel || r.redirectURL)) return r
  }
  return {}
}

/** Each layer sees the headers the previous ones left; a cancel stops the chain. */
export function runBeforeSendHeaders(layers: readonly WebRequestHooks[], details: OnBeforeSendHeadersListenerDetails): BeforeSendResponse {
  let headers = details.requestHeaders
  let changed = false
  for (const layer of layers) {
    const r = safely(() => layer.onBeforeSendHeaders?.({ ...details, requestHeaders: headers }))
    if (!r) continue
    if (r.cancel) return { cancel: true }
    if (r.requestHeaders) {
      headers = r.requestHeaders as Record<string, string>
      changed = true
    }
  }
  return changed ? { requestHeaders: headers } : {}
}

/** Response headers chain the same way; the last status line given wins. */
export function runHeadersReceived(layers: readonly WebRequestHooks[], details: OnHeadersReceivedListenerDetails): HeadersReceivedResponse {
  let headers: Headers | undefined = details.responseHeaders
  let statusLine: string | undefined
  let changed = false
  for (const layer of layers) {
    const r = safely(() => layer.onHeadersReceived?.({ ...details, responseHeaders: headers as Record<string, string[]> | undefined }))
    if (!r) continue
    if (r.cancel) return { cancel: true }
    if (r.responseHeaders) {
      headers = r.responseHeaders
      changed = true
    }
    if (r.statusLine) statusLine = r.statusLine
  }
  if (!changed) return {}
  return statusLine ? { responseHeaders: headers, statusLine } : { responseHeaders: headers }
}

/** A throwing layer is skipped, never allowed to stall every request in the session. */
function safely<T>(fn: () => T | null | undefined): T | null {
  try {
    return fn() ?? null
  } catch {
    return null
  }
}

/** The built-in layers, in the mux's fixed order before the registered hooks. */
export interface CoreLayers {
  /** The dangerous-site list runs with ad blocking, ahead of it: both refuse whole pages. */
  safety: WebRequestHooks | null
  adblock: WebRequestHooks | null
  privacy: WebRequestHooks | null
  content: WebRequestHooks | null
}

/**
 * The layers for one request: a locked-down session gets only its lockdown;
 * every other session runs the dangerous-site list and ad blocking, privacy,
 * per-site content and then the registered hooks. Worked out per request, so hooks and lockdowns added
 * after the session started still apply.
 */
export function layersFor(session: Session, isWebSession: boolean, core: CoreLayers): WebRequestHooks[] {
  const lock = webRequest.lockdownFor(session)
  if (lock) {
    const extra = lockdownExtras.get(session)
    return extra ? [lockdownLayer(lock), extra] : [lockdownLayer(lock)]
  }
  const own = isWebSession ? [core.safety, core.adblock, core.privacy, core.content] : []
  return [...own.filter((l): l is WebRequestHooks => l !== null), ...webRequestHooks.for(session, isWebSession)]
}

export function lockdownLayer(allow: LockdownAllow): WebRequestHooks {
  return {
    onBeforeRequest: (d) => (allow({ url: d.url, resourceType: d.resourceType }) ? null : { cancel: true }),
  }
}

const installed = new WeakSet<Session>()

/** Becomes the session's one listener for each webRequest event (Feature.session). */
export function installWebRequestMux(session: Session, isWebSession: boolean, core: CoreLayers): void {
  if (installed.has(session)) return
  installed.add(session)
  session.webRequest.onBeforeRequest((details, callback) => callback(runBeforeRequest(layersFor(session, isWebSession, core), details)))
  session.webRequest.onBeforeSendHeaders((details, callback) => callback(runBeforeSendHeaders(layersFor(session, isWebSession, core), details)))
  session.webRequest.onHeadersReceived((details, callback) => callback(runHeadersReceived(layersFor(session, isWebSession, core), details)))
}
