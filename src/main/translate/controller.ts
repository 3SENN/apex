/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  decideTranslate,
  languageKey,
  pickEngine,
  sameLanguage,
  toggleListed,
  translateTarget,
  type AppleStatus,
  type PageLanguageHints,
  type PageTranslateBatchReply,
  type PageTranslateCommand,
  type PageTranslateReport,
  type TabTranslate,
  type TranslateEngineId,
  type TranslateErrorCode,
  type TranslateSettings,
  type TranslateStatus,
} from '@shared/translate'
import { detectLanguage, pageLanguage, type Detection } from '@shared/translateDetect'
import { TranslateError, type TranslateEngine } from './engines'

// Page translation's state, per tab (TR-01 to TR-04, TR-10). The page sends
// its language hints; this decides between nothing, the offer (the pill's
// button) and translating at once, picks the engine, hands out sessions, and
// answers the page's batches. A navigation starts the tab over; Show original,
// a new target or a "never" choice ends a session, and a stale session's
// batches are refused. Electron stays out of this file (feature.ts wires it).

export interface TranslatePrefs {
  settings: TranslateSettings
  /** Your languages, in order. */
  languages: string[]
}

export interface TranslateControllerDeps {
  prefs(tabId: string): TranslatePrefs
  savePrefs(tabId: string, next: TranslateSettings): void
  appleStatus(source: string, target: string): Promise<AppleStatus>
  /** A second opinion on the language when the small detector is unsure (NaturalLanguage, on macOS). */
  detect?(text: string): Promise<{ language: string; confidence: number } | null>
  engine(id: TranslateEngineId): TranslateEngine
  /** Sends a command to the tab's page. */
  command(tabId: string, cmd: PageTranslateCommand): void
  /** The tab's TabInfo.translate changed. */
  changed(tabId: string): void
  newSession?(): string
}

interface Entry {
  host: string | null
  web: boolean
  language: string | null
  optOut: boolean
  status: TranslateStatus | null
  target: string | null
  engine: TranslateEngineId | null
  error: TranslateErrorCode | null
  progress: { done: number; total: number } | null
  session: string | null
  source: string | null
  /** The always list has had its go on this page (Show original then sticks). */
  autoTried: boolean
  /** Hints arrive more than once (a second look); only the newest counts. */
  hintsSeq: number
}

/** Below this many letters a sample says too little for a second opinion. */
const DETECT_MIN = 40
const NATIVE_CONFIDENT = 0.8

function hostOf(url: string): { host: string | null; web: boolean } {
  try {
    const u = new URL(url)
    const web = u.protocol === 'http:' || u.protocol === 'https:'
    return { host: web ? u.hostname.toLowerCase() : null, web }
  } catch {
    return { host: null, web: false }
  }
}

const blank = (url: string): Entry => ({ ...hostOf(url), language: null, optOut: false, status: null, target: null, engine: null, error: null, progress: null, session: null, source: null, autoTried: false, hintsSeq: 0 })

export class TranslateController {
  readonly #deps: TranslateControllerDeps
  readonly #tabs = new Map<string, Entry>()
  #sessionSeq = 0

  constructor(deps: TranslateControllerDeps) {
    this.#deps = deps
  }

  #entry(tabId: string): Entry | undefined {
    return this.#tabs.get(tabId)
  }

  #notify(tabId: string): void {
    this.#deps.changed(tabId)
  }

  /** What the pill shows for the tab, or null for nothing. */
  info(tabId: string): TabTranslate | null {
    const e = this.#entry(tabId)
    if (!e || !e.status || !e.language) return null
    const { settings, languages } = this.#deps.prefs(tabId)
    const key = languageKey(e.language)
    return {
      status: e.status,
      language: e.language,
      target: e.target ?? translateTarget(settings, languages),
      engine: e.engine,
      error: e.error,
      progress: e.progress,
      always: key !== null && settings.always.some((t) => languageKey(t) === key),
      neverSite: e.host !== null && settings.neverSites.some((h) => h.toLowerCase() === e.host),
      host: e.host,
    }
  }

  /**
   * The page menu's entry (TR-13): Translate to <target> on any web page whose
   * language is known and not the target (even one you said never to offer on),
   * or Show original while translated. Null for nothing.
   */
  menu(tabId: string): { kind: 'translate'; target: string } | { kind: 'restore' } | null {
    const e = this.#entry(tabId)
    if (!e || !e.web) return null
    if (e.session || e.status === 'translated') return { kind: 'restore' }
    const page = languageKey(e.language)
    if (!page || e.optOut) return null
    const { settings, languages } = this.#deps.prefs(tabId)
    const target = translateTarget(settings, languages)
    return page === target ? null : { kind: 'translate', target }
  }

  /** A new page in the tab (not an in-page navigation): everything starts over. */
  navigated(tabId: string, url: string): void {
    const had = this.#entry(tabId)?.status ?? null
    this.#tabs.set(tabId, blank(url))
    if (had) this.#notify(tabId)
  }

  closed(tabId: string): void {
    this.#tabs.delete(tabId)
  }

  /** The page's hints: work out its language and what to offer. */
  async hints(tabId: string, url: string, hints: PageLanguageHints): Promise<void> {
    let e = this.#entry(tabId)
    if (!e) this.#tabs.set(tabId, (e = blank(url)))
    // While translated, the page's text is in the target language: its sample says nothing about the page.
    if (e.session || e.status === 'translated') return
    const seq = ++e.hintsSeq
    let detected: Detection = detectLanguage(hints.sample)
    if (!detected.reliable && this.#deps.detect && hints.sample.length >= DETECT_MIN) {
      const native = await this.#deps.detect(hints.sample).catch(() => null)
      if (native && native.confidence >= NATIVE_CONFIDENT) detected = { language: native.language, confidence: native.confidence, reliable: true }
    }
    if (this.#entry(tabId) !== e || e.hintsSeq !== seq || e.session) return
    e.language = pageLanguage(hints, detected)
    e.optOut = hints.optOut
    this.#decide(tabId, e)
  }

  #decide(tabId: string, e: Entry): void {
    if (e.session || e.status === 'translated' || e.status === 'translating') return
    const { settings, languages } = this.#deps.prefs(tabId)
    const decision = decideTranslate({ web: e.web, optOut: e.optOut, pageLanguage: e.language, languages, settings, host: e.host })
    const before = e.status
    e.status = decision.kind === 'none' ? null : e.status === 'error' ? 'error' : 'offer'
    if (decision.kind === 'none') e.error = null
    if (decision.kind === 'auto' && !e.autoTried) {
      e.autoTried = true
      void this.translate(tabId)
      return
    }
    if (before !== e.status) this.#notify(tabId)
  }

  /** Settings changed somewhere (Settings › Languages, another window): offers follow. */
  settingsChanged(): void {
    for (const [tabId, e] of this.#tabs) this.#decide(tabId, e)
  }

  /** Translates the tab's page into `target` (a language tag) or your target language. */
  async translate(tabId: string, target?: string): Promise<void> {
    const e = this.#entry(tabId)
    if (!e || !e.web) return
    const prefs = this.#deps.prefs(tabId)
    const source = languageKey(e.language)
    if (!source) {
      this.#fail(tabId, e, 'unknown-language')
      return
    }
    const chosen = languageKey(target)
    if (chosen && chosen !== languageKey(prefs.settings.target)) {
      // A target picked in the popover sticks.
      this.#deps.savePrefs(tabId, { ...prefs.settings, target: chosen })
    }
    const to = chosen ?? translateTarget(prefs.settings, prefs.languages)
    if (sameLanguage(source, to)) return
    // A running or finished translation into another language starts over from the originals (the page restores first).
    const session = this.#deps.newSession?.() ?? `t${Date.now().toString(36)}-${++this.#sessionSeq}`
    e.session = session
    e.source = source
    e.target = to
    e.status = 'translating'
    e.error = null
    e.progress = null
    e.engine = null
    this.#notify(tabId)
    const apple = await this.#deps.appleStatus(source, to)
    if (e.session !== session) return
    const picked = pickEngine(apple, prefs.settings.companion)
    if ('error' in picked) {
      this.#fail(tabId, e, picked.error)
      return
    }
    e.engine = picked.engine
    this.#notify(tabId)
    this.#deps.command(tabId, { kind: 'start', session, source, target: to })
  }

  #fail(tabId: string, e: Entry, code: TranslateErrorCode): void {
    e.session = null
    e.status = 'error'
    e.error = code
    e.progress = null
    this.#notify(tabId)
  }

  /** One batch from the page. Refused for a session that is over. */
  async batch(tabId: string, session: string, texts: string[]): Promise<PageTranslateBatchReply> {
    const e = this.#entry(tabId)
    if (!e || e.session !== session || !e.source || !e.target || !e.engine) return { error: 'failed' }
    const { source, target } = e
    try {
      return { texts: await this.#deps.engine(e.engine).translate(texts, source, target) }
    } catch (err) {
      const code: TranslateErrorCode = err instanceof TranslateError ? err.code : 'failed'
      // Apple's languages went away mid-page: the companion takes over when you allowed it.
      if (e.session === session && e.engine === 'apple' && code !== 'failed' && this.#deps.prefs(tabId).settings.companion) {
        e.engine = 'companion'
        this.#notify(tabId)
        return this.batch(tabId, session, texts)
      }
      return { error: code }
    }
  }

  /** What the page reports while it translates. */
  report(tabId: string, r: PageTranslateReport): void {
    const e = this.#entry(tabId)
    if (!e) return
    if (r.kind === 'restored') return
    if (r.session !== e.session) return
    if (r.kind === 'progress') {
      e.progress = { done: r.done, total: r.total }
      if (e.status !== 'translated') e.status = 'translating'
    } else if (r.kind === 'done') {
      e.status = 'translated'
      e.progress = { done: r.done, total: r.total }
    } else if (r.kind === 'failed') {
      this.#fail(tabId, e, r.error)
      return
    }
    this.#notify(tabId)
  }

  /** Show original: the page puts its own text back. */
  restore(tabId: string): void {
    const e = this.#entry(tabId)
    if (!e) return
    if (e.session || e.status === 'translated' || e.status === 'translating') this.#deps.command(tabId, { kind: 'restore' })
    e.session = null
    e.progress = null
    e.engine = null
    e.error = null
    e.status = null
    e.autoTried = true
    this.#decide(tabId, e)
    this.#notify(tabId)
  }

  setAlways(tabId: string, on: boolean): void {
    const e = this.#entry(tabId)
    const key = languageKey(e?.language)
    if (!e || !key) return
    const { settings } = this.#deps.prefs(tabId)
    this.#deps.savePrefs(tabId, { ...settings, always: toggleListed(settings.always, key, on), never: on ? toggleListed(settings.never, key, false) : settings.never })
    if (on && !e.session && e.status !== 'translated') void this.translate(tabId)
    else this.#notify(tabId)
  }

  setNeverLanguage(tabId: string, on: boolean): void {
    const e = this.#entry(tabId)
    const key = languageKey(e?.language)
    if (!e || !key) return
    const { settings } = this.#deps.prefs(tabId)
    this.#deps.savePrefs(tabId, { ...settings, never: toggleListed(settings.never, key, on), always: on ? toggleListed(settings.always, key, false) : settings.always })
    if (on) this.restore(tabId)
    else this.#notify(tabId)
  }

  setNeverSite(tabId: string, on: boolean): void {
    const e = this.#entry(tabId)
    if (!e?.host) return
    const { settings } = this.#deps.prefs(tabId)
    this.#deps.savePrefs(tabId, { ...settings, neverSites: toggleListed(settings.neverSites, e.host, on) })
    if (on) this.restore(tabId)
    else this.#notify(tabId)
  }
}
