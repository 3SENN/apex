/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Search engines (ST-31): the catalogue Apex ships, custom engines (a
// name plus an https template with %s), and where suggestions come from.
// settings.searchEngine holds an id; an id that is neither built in nor a
// saved custom engine falls back to the first engine.
import type { CustomSearchEngine } from './ipc'

export interface SearchEngineDef {
  id: string
  name: string
  /** An https URL with %s where the query goes. */
  template: string
  /** An OpenSearch-style suggestion endpoint (JSON `[query, [suggestions…]]`), when the engine has one. */
  suggest?: string
  builtIn: boolean
}

export const BUILT_IN_SEARCH_ENGINES: readonly SearchEngineDef[] = [
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s', builtIn: true },
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list', builtIn: true },
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s', builtIn: true },
  { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list', builtIn: true },
  { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s', builtIn: true },
  { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/sp/search?query=%s', builtIn: true },
  { id: 'kagi', name: 'Kagi', template: 'https://kagi.com/search?q=%s', builtIn: true },
  { id: 'qwant', name: 'Qwant', template: 'https://www.qwant.com/?q=%s', builtIn: true },
  { id: 'yahoo', name: 'Yahoo', template: 'https://search.yahoo.com/search?p=%s', builtIn: true },
]

export const BUILT_IN_ENGINE_IDS: readonly string[] = BUILT_IN_SEARCH_ENGINES.map((e) => e.id)

export const CUSTOM_ENGINE_NAME_MAX = 60
export const CUSTOM_ENGINE_TEMPLATE_MAX = 2048
export const CUSTOM_ENGINES_MAX = 50
const ENGINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

// Main keeps the saved custom engines here so every caller of searchUrl
// (the address field, new tabs, the agent) applies a change at once without
// threading settings through.
let customEngines: readonly CustomSearchEngine[] = []

export function registerCustomEngines(list: readonly CustomSearchEngine[]): void {
  customEngines = list
}

/** What a template is missing, or null when it can be used. */
export type TemplateProblem = 'empty' | 'invalid' | 'https' | 'placeholder'

export function templateProblem(template: string): TemplateProblem | null {
  const text = template.trim()
  if (!text) return 'empty'
  if (text.length > CUSTOM_ENGINE_TEMPLATE_MAX || /\s/.test(text)) return 'invalid'
  let parsed: URL
  try {
    parsed = new URL(text.replace(/%s/g, 'apex'))
  } catch {
    return 'invalid'
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return 'https'
  if (!text.includes('%s')) return 'placeholder'
  return null
}

/** A free id for a new custom engine, from its name. */
export function customEngineId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'engine'
  const used = new Set([...taken, ...BUILT_IN_ENGINE_IDS])
  let id = ENGINE_ID.test(base) ? base : `engine-${base}`.slice(0, 64)
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  return id
}

/** The custom engine to add (ST-31), or why it can't be added yet: a missing name and/or the template's problem. */
export function validateCustomEngine(name: string, template: string, existing: readonly CustomSearchEngine[]): { engine: CustomSearchEngine } | { nameError: boolean; problem: TemplateProblem | null } {
  const cleanName = name.replace(/\s+/g, ' ').trim().slice(0, CUSTOM_ENGINE_NAME_MAX)
  const cleanTemplate = template.trim()
  const problem = templateProblem(cleanTemplate)
  if (!cleanName || problem) return { nameError: !cleanName, problem }
  return { engine: { id: customEngineId(cleanName, existing.map((e) => e.id)), name: cleanName, template: cleanTemplate } }
}

/** The engine for an id: built in, then custom (only usable https templates), else the first built-in engine. */
export function resolveEngine(id: string, custom: readonly CustomSearchEngine[] = customEngines): SearchEngineDef {
  const builtIn = BUILT_IN_SEARCH_ENGINES.find((e) => e.id === id)
  if (builtIn) return builtIn
  const own = custom.find((e) => e.id === id)
  if (own && templateProblem(own.template) === null) return { id: own.id, name: own.name, template: own.template.trim(), builtIn: false }
  return BUILT_IN_SEARCH_ENGINES[0] as SearchEngineDef
}

export function engineSearchUrl(engine: Pick<SearchEngineDef, 'template'>, query: string): string {
  return engine.template.replace(/%s/g, encodeURIComponent(query))
}

export function engineSuggestUrl(engine: Pick<SearchEngineDef, 'suggest'>, query: string): string | null {
  return engine.suggest ? engine.suggest.replace(/%s/g, encodeURIComponent(query)) : null
}

/** The engine's site, for its favicon (fetched at runtime by the page that shows it). */
export function engineFaviconUrl(engine: Pick<SearchEngineDef, 'template'>): string | null {
  try {
    const url = new URL(engine.template.replace(/%s/g, 'q'))
    return `${url.origin}/favicon.ico`
  } catch {
    return null
  }
}

export const SUGGESTIONS_MAX = 5

/**
 * Reads an OpenSearch suggestion response (`["query", ["a", "b"]]`) or a
 * plain list of strings. Anything else, the query itself and duplicates
 * drop out.
 */
export function parseSuggestions(body: unknown, query: string, max = SUGGESTIONS_MAX): string[] {
  let list: unknown = body
  if (Array.isArray(body) && typeof body[0] === 'string' && Array.isArray(body[1])) list = body[1]
  if (!Array.isArray(list)) return []
  const seen = new Set([query.trim().toLowerCase()])
  const out: string[] = []
  for (const item of list) {
    const text = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { phrase?: unknown }).phrase === 'string' ? (item as { phrase: string }).phrase : null
    if (!text) continue
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= max) break
  }
  return out
}
