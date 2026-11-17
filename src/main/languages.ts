/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, type Session, type WebContents } from 'electron'
import { acceptLanguageHeader, effectiveLanguages, expandLanguageList, spellcheckLanguages } from '@shared/languages'
import type { Settings } from '@shared/ipc'
import { cdp } from './cdp'
import { log } from './log'
import { browserUserAgent, userAgentMetadata } from './userAgent'

// Website and spellcheck languages (ST-32), applied live on every
// session: the User-Agent and Accept-Language (session.setUserAgent), the
// spellcheck dictionaries (not on macOS, which uses the system's), and
// navigator.languages in each tab, its out-of-process iframes and its workers
// through a DevTools override while a custom list is set, or while
// Chromium's own list disagrees with the header (systemOverride). Chromium's
// own shape throughout: navigator.languages shows the list, Accept-Language
// its expansion (expandLanguageList) with q-values.

export function systemLanguages(): string[] {
  try {
    return app.getPreferredSystemLanguages()
  } catch {
    return [app.getLocale()]
  }
}

/**
 * The languages pages see. With the system's, that is what Electron gives
 * navigator.languages on its own (the app locale, then the system's
 * languages), so the header says the same.
 */
export function languagesFor(settings: Pick<Settings, 'languages'>): string[] {
  let locale = ''
  try {
    locale = app.getLocale()
  } catch {
    // No app locale before ready in some tests: the system's list alone.
  }
  return effectiveLanguages(settings.languages, locale ? [locale, ...systemLanguages()] : systemLanguages())
}

/**
 * What Chromium shows navigator.languages with no override: Electron's list,
 * the app locale and then the system's languages as Electron reports them,
 * unchecked. On Linux those come from glib, which always ends them with the
 * "C" locale, so pages see a 'c' (and repeats) that no Chrome shows.
 */
export function ownPageLanguages(): string[] {
  let locale = ''
  try {
    locale = app.getLocale()
  } catch {
    // Before ready: the system's list alone.
  }
  const system = systemLanguages()
  return locale ? [locale, ...system.filter((tag) => tag !== locale)] : system
}

/**
 * While the website languages follow the system: the list tabs hold so pages
 * and workers show what the header (`header`, the sessions' list) says, or
 * null when Chromium's own navigator.languages already matches it (macOS and
 * Windows, normally) and no override is needed.
 */
export function systemOverride(header: readonly string[], own: readonly string[] = ownPageLanguages()): string[] | null {
  return acceptLanguageHeader(own) === acceptLanguageHeader(header) ? null : [...header]
}

/** The User-Agent, header and dictionaries for one session. */
export function applySessionLanguages(session: Session, list: readonly string[]): void {
  try {
    // Chromium adds the q-values itself; it wants the plain ordered list.
    session.setUserAgent(browserUserAgent(), expandLanguageList(list).join(','))
    if (process.platform !== 'darwin') {
      // Chromium downloads the dictionaries from Google's CDN, as Chrome does; a smoke run stays on this machine.
      if (process.env.APEX_SMOKE === '1') session.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')
      const dictionaries = spellcheckLanguages(list, session.availableSpellCheckerLanguages)
      if (dictionaries.length > 0) session.setSpellCheckerLanguages(dictionaries)
    }
  } catch (err) {
    log.warn('languages', 'Could not apply languages to a session', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Emulation.setUserAgentOverride for a custom list: the same UA, the client hints kept, and the list for navigator.languages and the header. */
export function tabOverride(list: readonly string[]): Record<string, unknown> {
  // Chromium adds q-values to acceptLanguage and splits it for navigator.languages, so it takes the plain
  // expanded list: the header then matches the session's on navigations and workers.
  return { userAgent: browserUserAgent(), acceptLanguage: expandLanguageList(list).join(','), userAgentMetadata: userAgentMetadata() }
}

// Out-of-process iframes and workers are targets of their own: the tab's override doesn't reach them.
// Auto-attach pauses each one before its first script, so it starts with the list (or is let go after a moment).
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
const NO_AUTO_ATTACH = { autoAttach: false, waitForDebuggerOnStart: false }
const WORKER_TARGETS = new Set(['worker', 'shared_worker', 'service_worker'])
const CHILD_COMMAND_MS = 2000

interface AttachedTarget {
  sessionId: string
  targetInfo?: { type?: string }
  waitingForDebugger?: boolean
}

/**
 * A child target of a tab holding a list: an iframe takes the tab's
 * Emulation override (and attaches its own children), a worker the Network
 * one (Emulation is a page domain; a service worker never answers it). It
 * always runs on after, whatever happened.
 */
async function overrideChild(wc: WebContents, target: AttachedTarget, override: Record<string, unknown>): Promise<void> {
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    Promise.race([cdp.send(wc, method, params, target.sessionId), new Promise((resolve) => setTimeout(resolve, CHILD_COMMAND_MS))])
  const type = target.targetInfo?.type ?? ''
  try {
    if (type === 'iframe' || type === 'page') await Promise.all([send('Emulation.setUserAgentOverride', override), send('Target.setAutoAttach', AUTO_ATTACH)])
    else if (WORKER_TARGETS.has(type)) await send('Network.setUserAgentOverride', override)
  } catch {
    // The target went away; nothing to run on.
  } finally {
    if (target.waitingForDebugger && !wc.isDestroyed()) await send('Runtime.runIfWaitingForDebugger', {}).catch(() => undefined)
  }
}

/**
 * navigator.languages per tab. Chromium takes it from Electron's list (the
 * app locale, then the system's languages) and Electron has no setting for
 * it, so a list is set through Emulation.setUserAgentOverride, which holds
 * only while attached, and on each out-of-process iframe and worker as it
 * starts. It is a standing hold (cdp.ts): only while a custom list is set or
 * the system's needs it (systemOverride), re-applied after every re-attach,
 * and stepped aside on sign-in pages.
 */
export class TabLanguages {
  readonly #held = new Map<WebContents, () => void>()
  #list: string[] | null = null

  /** null: no override (Chromium's own list already matches the header). */
  set(list: string[] | null): void {
    if (JSON.stringify(list) === JSON.stringify(this.#list)) return
    this.#list = list
    for (const wc of [...this.#held.keys()]) this.#release(wc)
    for (const wc of this.#tracked) if (!wc.isDestroyed()) this.#apply(wc)
  }

  readonly #tracked = new Set<WebContents>()
  readonly #pending = new WeakMap<WebContents, string>()

  /** `pendingUrl`: where a just-created tab is headed (its first page may be a sign-in page). */
  track(wc: WebContents, pendingUrl?: string): () => void {
    this.#tracked.add(wc)
    if (pendingUrl) this.#pending.set(wc, pendingUrl)
    // The override lives on the tab's DevTools target, which survives navigations.
    this.#apply(wc)
    return () => {
      this.#tracked.delete(wc)
      this.#release(wc)
    }
  }

  #apply(wc: WebContents): void {
    const list = this.#list
    if (!list || wc.isDestroyed() || this.#held.has(wc)) return
    const override = tabOverride(list)
    const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
      if (method === 'Target.attachedToTarget' && params && typeof (params as AttachedTarget).sessionId === 'string') void overrideChild(wc, params as AttachedTarget, override)
    }
    try {
      const release = cdp.hold(wc, {
        apply: () => Promise.all([cdp.send(wc, 'Emulation.setUserAgentOverride', override), cdp.send(wc, 'Target.setAutoAttach', AUTO_ATTACH)]),
        // An empty userAgent clears the override.
        clear: () => Promise.all([cdp.send(wc, 'Emulation.setUserAgentOverride', { userAgent: '' }), cdp.send(wc, 'Target.setAutoAttach', NO_AUTO_ATTACH)]),
      }, this.#pending.get(wc))
      wc.debugger.on('message', onMessage)
      this.#held.set(wc, () => {
        release()
        if (!wc.isDestroyed()) wc.debugger.off('message', onMessage)
      })
      this.#pending.delete(wc)
    } catch (err) {
      log.debug('languages', 'Tab language override unavailable', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  #release(wc: WebContents): void {
    const release = this.#held.get(wc)
    this.#held.delete(wc)
    release?.()
  }
}
