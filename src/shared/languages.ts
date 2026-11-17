/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Website and spellcheck languages (ST-32). Pure helpers shared by
// Settings › Languages and main, which applies the list to every session.

export const LANGUAGES_MAX = 10

// The same shape main's settings schema accepts: a language, then up to three subtags.
const TAG_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

/** The canonical form of a valid BCP-47 locale tag ('en-gb' → 'en-GB'), or null. */
export function canonicalTag(input: string): string | null {
  const tag = input.trim().replace(/_/g, '-')
  if (!TAG_SHAPE.test(tag)) return null
  try {
    const [canonical] = Intl.getCanonicalLocales(tag)
    return canonical && TAG_SHAPE.test(canonical) ? canonical : null
  } catch {
    return null
  }
}

/** Adds a tag at the end; refuses duplicates, invalid tags and an eleventh language. */
export function addLanguage(list: readonly string[], input: string): { list: string[]; error: 'invalid' | 'duplicate' | 'full' | null } {
  const tag = canonicalTag(input)
  if (!tag) return { list: [...list], error: 'invalid' }
  if (list.some((t) => t.toLowerCase() === tag.toLowerCase())) return { list: [...list], error: 'duplicate' }
  if (list.length >= LANGUAGES_MAX) return { list: [...list], error: 'full' }
  return { list: [...list, tag], error: null }
}

/** Moves one entry up (-1) or down (+1); out-of-range moves change nothing. */
export function moveLanguage(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const next = [...list]
  const target = index + delta
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  if (item !== undefined) next.splice(target, 0, item)
  return next
}

export function removeLanguage(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index)
}

/** Whether two ordered lists differ (Save is enabled only after a change). */
export function languagesChanged(a: readonly string[], b: readonly string[]): boolean {
  return a.length !== b.length || a.some((t, i) => t !== b[i])
}

/**
 * The ordered list to apply: the custom list, or the system's languages
 * (deduplicated, valid tags only, capped). Never empty: English is the floor.
 */
export function effectiveLanguages(setting: { mode: 'system' | 'custom'; list: readonly string[] }, system: readonly string[]): string[] {
  const source = setting.mode === 'custom' && setting.list.length > 0 ? setting.list : system
  const out: string[] = []
  for (const raw of source) {
    const tag = canonicalTag(raw)
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag)
    if (out.length >= LANGUAGES_MAX) break
  }
  return out.length > 0 ? out : ['en-US']
}

/**
 * The list Chromium puts in Accept-Language for a language preference
 * (net::HttpUtil::ExpandLanguageList): each tag in order, and its base
 * language after it when the next tag is not of the same family.
 * navigator.languages shows the list itself; the header shows this.
 */
export function expandLanguageList(list: readonly string[]): string[] {
  const out: string[] = []
  const add = (tag: string): void => {
    if (tag && !out.includes(tag)) out.push(tag)
  }
  const base = (tag: string): string => tag.split('-')[0] ?? tag
  list.forEach((tag, i) => {
    add(tag)
    const primary = base(tag)
    if (primary === 'x' || primary === 'i') return
    const next = list[i + 1]
    if (next === undefined || base(next) !== primary) add(primary)
  })
  return out
}

/** The Accept-Language value Chromium sends for a preference: the expanded list with falling q-values. */
export function acceptLanguageHeader(list: readonly string[]): string {
  return expandLanguageList(list)
    .map((tag, i) => (i === 0 ? tag : `${tag};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
    .join(',')
}

/** Spellcheck languages: those the platform has dictionaries for, matching by tag then by base language. */
export function spellcheckLanguages(list: readonly string[], available: readonly string[]): string[] {
  const out: string[] = []
  const lower = available.map((a) => a.toLowerCase())
  for (const tag of list) {
    const exact = lower.indexOf(tag.toLowerCase())
    const base = tag.split('-')[0]?.toLowerCase() ?? ''
    const index = exact >= 0 ? exact : lower.findIndex((a) => a === base || a.startsWith(`${base}-`))
    const found = index >= 0 ? available[index] : undefined
    if (found && !out.includes(found)) out.push(found)
  }
  return out
}

/** Languages people commonly pick, searchable by name in the add field. Any valid tag works too. */
export const COMMON_LANGUAGE_TAGS = [
  'af', 'ar', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'de-AT', 'de-CH', 'el', 'en', 'en-AU', 'en-CA', 'en-GB', 'en-IE', 'en-IN', 'en-NZ', 'en-US',
  'es', 'es-419', 'es-ES', 'es-MX', 'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'fr-BE', 'fr-CA', 'fr-CH', 'fr-FR', 'ga', 'gl', 'gu', 'he', 'hi', 'hr',
  'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'lt', 'lv', 'mk', 'ml', 'mr', 'ms', 'nb', 'ne', 'nl', 'nl-BE', 'pa', 'pl',
  'pt', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'zh-CN', 'zh-HK', 'zh-TW', 'zu',
] as const

/**
 * Suggestions for the add field: names (in `name`'s language) or tags that
 * contain the query, best first, skipping those already listed. A query that
 * is itself a valid tag is offered first.
 */
export function searchLanguages(query: string, listed: readonly string[], name: (tag: string) => string, limit = 8): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const taken = new Set(listed.map((t) => t.toLowerCase()))
  const scored: Array<{ tag: string; score: number }> = []
  for (const tag of COMMON_LANGUAGE_TAGS) {
    if (taken.has(tag.toLowerCase())) continue
    const label = name(tag).toLowerCase()
    const t = tag.toLowerCase()
    const score = t === q ? 0 : label.startsWith(q) ? 1 : t.startsWith(q) ? 2 : label.includes(q) ? 3 : -1
    if (score >= 0) scored.push({ tag, score })
  }
  scored.sort((a, b) => a.score - b.score || name(a.tag).localeCompare(name(b.tag)))
  const out = scored.map((s) => s.tag)
  const typed = canonicalTag(query)
  if (typed && !taken.has(typed.toLowerCase()) && !out.includes(typed)) out.unshift(typed)
  return out.slice(0, limit)
}
