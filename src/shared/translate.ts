/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page translation (TR-01 to TR-12): the shapes and pure rules shared by main,
// the page preload and the chrome. A page whose language is not one of yours
// gets a translate button in the address pill; its popover translates the
// page in place, always translates that language, never offers on that site,
// or shows the original. On-device Apple Translation goes first; the
// companion's engine only when you turn it on (TranslateSettings.companion).
import { z } from 'zod'
import { canonicalTag } from './languages'

// ── Settings (Settings.translate, per profile) ──

export const TRANSLATE_LIST_MAX = 200
const HOST_MAX = 253
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

export interface TranslateSettings {
  /** TR-01: show the translate button on pages that are not in one of your languages. */
  offer: boolean
  /** The language pages are translated into; null follows the first of your languages. */
  target: string | null
  /** TR-03: languages translated without asking, as language keys ('fr', 'zh-Hant'). */
  always: string[]
  /** Languages never offered. */
  never: string[]
  /** TR-04: sites (hosts) never offered. */
  neverSites: string[]
  /** TR-06: translate with the companion's engine (your API key, or another engine) when this Mac can't. Sends page text to the model. */
  companion: boolean
}

export const TRANSLATE_DEFAULTS: TranslateSettings = { offer: true, target: null, always: [], never: [], neverSites: [], companion: false }

const languageList = z.array(z.string().regex(TAG)).max(TRANSLATE_LIST_MAX)

export const TRANSLATE_SETTINGS_SCHEMA = z
  .object({
    offer: z.boolean(),
    target: z.string().regex(TAG).nullable(),
    always: languageList,
    never: languageList,
    neverSites: z.array(z.string().min(1).max(HOST_MAX)).max(TRANSLATE_LIST_MAX),
    companion: z.boolean(),
  })
  .strict()

// ── Languages ──

/** Old and alternative codes Chromium still sees on pages, mapped to the ones Apple and Intl use. */
const ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', tl: 'fil', no: 'nb', mo: 'ro' }
const TRADITIONAL = new Set(['tw', 'hk', 'mo', 'hant'])

/**
 * The key two tags are compared by: the base language, except Chinese, where
 * the script matters (zh-TW and zh-Hant are 'zh-Hant'; zh, zh-CN and zh-Hans
 * are 'zh-Hans'). Null for anything that is not a language tag.
 */
export function languageKey(tag: string | null | undefined): string | null {
  if (!tag) return null
  const canonical = canonicalTag(tag.replace(/_/g, '-'))
  if (!canonical) return null
  const parts = canonical.toLowerCase().split('-')
  const base = ALIASES[parts[0]!] ?? parts[0]!
  if (base === 'und' || base === 'zxx' || base === 'mul') return null
  if (base === 'zh') return parts.slice(1).some((p) => TRADITIONAL.has(p)) ? 'zh-Hant' : 'zh-Hans'
  return base
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = languageKey(a)
  return ka !== null && ka === languageKey(b)
}

/** The language pages are translated into: the chosen one, or the first of your languages. */
export function translateTarget(settings: Pick<TranslateSettings, 'target'>, languages: readonly string[]): string {
  return languageKey(settings.target) ?? languageKey(languages[0]) ?? 'en'
}

/** A host and the sites above it ('news.example.fr' → news.example.fr, example.fr); the last label alone never counts. */
export function hostAndParents(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 1) return labels
  const out: string[] = []
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'))
  return out
}

export function siteNeverTranslated(neverSites: readonly string[], host: string | null): boolean {
  if (!host) return false
  const listed = new Set(neverSites.map((h) => h.toLowerCase()))
  return hostAndParents(host).some((h) => listed.has(h))
}

/** Adds or removes a value in a capped, case-insensitive list (the settings' always, never and neverSites). */
export function toggleListed(list: readonly string[], value: string, on: boolean): string[] {
  const rest = list.filter((v) => v.toLowerCase() !== value.toLowerCase())
  return on ? [...rest, value].slice(-TRANSLATE_LIST_MAX) : rest
}

// ── The decision table (TR-02) ──

export type TranslateDecision =
  | { kind: 'auto' }
  | { kind: 'offer' }
  | { kind: 'none'; reason: 'not-web' | 'opt-out' | 'unknown-language' | 'your-language' | 'never-site' | 'never-language' | 'offers-off' }

export interface DecisionInput {
  web: boolean
  /** The page said translate="no" or <meta name="google" content="notranslate">. */
  optOut: boolean
  pageLanguage: string | null
  /** Your languages, in order (Settings › Languages, or the system's). */
  languages: readonly string[]
  settings: TranslateSettings
  host: string | null
}

/**
 * What a page gets: translated at once (its language is on the always list),
 * the offer (the button in the pill), or nothing. Rules in order: a web page
 * only; the page's own opt-out; a known language; not one of yours nor the
 * target; not a site or language you said never to; then always; then the
 * offer, unless offers are off.
 */
export function decideTranslate(input: DecisionInput): TranslateDecision {
  if (!input.web) return { kind: 'none', reason: 'not-web' }
  if (input.optOut) return { kind: 'none', reason: 'opt-out' }
  const page = languageKey(input.pageLanguage)
  if (!page) return { kind: 'none', reason: 'unknown-language' }
  const yours = new Set(input.languages.map(languageKey).filter((k): k is string => k !== null))
  if (yours.has(page) || page === translateTarget(input.settings, input.languages)) return { kind: 'none', reason: 'your-language' }
  if (siteNeverTranslated(input.settings.neverSites, input.host)) return { kind: 'none', reason: 'never-site' }
  if (input.settings.never.some((t) => languageKey(t) === page)) return { kind: 'none', reason: 'never-language' }
  if (input.settings.always.some((t) => languageKey(t) === page)) return { kind: 'auto' }
  if (!input.settings.offer) return { kind: 'none', reason: 'offers-off' }
  return { kind: 'offer' }
}

// ── Engines (TR-05, TR-06) ──

export type TranslateEngineId = 'apple' | 'companion'

/** What Apple's Translation framework says about a language pair on this Mac. */
export type AppleStatus = 'installed' | 'supported' | 'unsupported' | 'unavailable'

export type TranslateErrorCode =
  /** Apple can translate the pair once its languages are downloaded (System Settings › Language & Region). */
  | 'not-installed'
  /** Apple can't translate this pair at all. */
  | 'unsupported'
  /** No on-device translation here (not macOS 26, or the helper is missing). */
  | 'unavailable'
  /** The companion engine is on but has no API key, and no other engine is signed in. */
  | 'companion-unavailable'
  | 'unknown-language'
  | 'failed'

/**
 * Which engine translates: Apple's when the pair is downloaded, else the
 * companion's when you turned it on, else the reason neither can.
 */
export function pickEngine(apple: AppleStatus, companion: boolean): { engine: TranslateEngineId } | { error: TranslateErrorCode } {
  if (apple === 'installed') return { engine: 'apple' }
  if (companion) return { engine: 'companion' }
  return { error: apple === 'supported' ? 'not-installed' : apple === 'unsupported' ? 'unsupported' : 'unavailable' }
}

// ── Tab state (TabInfo.translate) ──

export type TranslateStatus = 'offer' | 'translating' | 'translated' | 'error'

export interface TabTranslate {
  status: TranslateStatus
  /** The page's language. */
  language: string
  /** The language it is (being) translated into. */
  target: string
  engine: TranslateEngineId | null
  error: TranslateErrorCode | null
  /** Texts done and found so far while translating. */
  progress: { done: number; total: number } | null
  /** The page's language is on the always list (the popover's switch). */
  always: boolean
  /** The site is on the never list. */
  neverSite: boolean
  host: string | null
}

// ── Page protocol (PAGE.translate*) ──

/** Texts per batch and characters per batch; the helper refuses more than 128 texts of 5000 characters. */
export const TRANSLATE_BATCH_ITEMS = 64
export const TRANSLATE_BATCH_CHARS = 4000
export const TRANSLATE_TEXT_MAX = 5000
export const TRANSLATE_SAMPLE_MAX = 3000

/** page → main: what the page says about its language, and a sample of its text. */
export interface PageLanguageHints {
  /** <html lang> (or xml:lang). */
  declared: string | null
  /** <meta http-equiv="content-language">. */
  contentLanguage: string | null
  /** <meta property="og:locale">. */
  ogLocale: string | null
  optOut: boolean
  /** Visible, translatable text from the page (code and inputs left out), up to TRANSLATE_SAMPLE_MAX. */
  sample: string
}

/** main → page. */
export type PageTranslateCommand = { kind: 'start'; session: string; source: string; target: string } | { kind: 'restore' } | { kind: 'hints' }

/** page → main, invoke: one batch; the reply has the same length, or an error. */
export interface PageTranslateBatch {
  session: string
  texts: string[]
}
export type PageTranslateBatchReply = { texts: string[] } | { error: TranslateErrorCode }

/** page → main. */
export type PageTranslateReport =
  | { kind: 'progress'; session: string; done: number; total: number }
  | { kind: 'done'; session: string; done: number; total: number }
  | { kind: 'failed'; session: string; error: TranslateErrorCode }
  | { kind: 'restored' }

// ── Services (translate.*) ──

export interface TranslateServices {
  translate: {
    /** Translates the tab's page into `target` (default: your target language). */
    translate(tabId: string, target?: string): Promise<void>
    /** Puts the page's own text back. */
    restore(tabId: string): void
    /** Always translate the page's language (on), or stop (off); on translates the page now. */
    setAlways(tabId: string, on: boolean): void
    /** Never offer on the tab's site; on also shows the original. */
    setNeverSite(tabId: string, on: boolean): void
    /** Never offer for the page's language; on also shows the original. */
    setNeverLanguage(tabId: string, on: boolean): void
    /** Opens System Settings › General › Language & Region, where Apple's translation languages are downloaded. */
    openLanguageDownloads(): void
  }
}
