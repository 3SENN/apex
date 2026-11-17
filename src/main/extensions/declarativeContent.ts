/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// chrome.declarativeContent: an extension's page rules. Rules are
// kept per extension across restarts, as Chrome keeps them. Atelier evaluates
// the page-URL part of each PageStateMatcher; a rule whose conditions match
// and whose actions include ShowAction (ShowPageAction is its older name)
// enables the toolbar action on that tab even when the extension disabled it
// by default, which is what Chrome does for Manifest V3. CSS conditions need
// the page's DOM, which Atelier doesn't watch, so a condition with css never
// matches; SetIcon and RequestContentScript are kept and reported by
// getRules but change nothing.

export interface ContentRule {
  id: string
  priority: number
  tags: string[]
  conditions: Record<string, unknown>[]
  actions: Record<string, unknown>[]
}

export const RULES_MAX = 1000

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Adds rules the way Chrome does: generated ids for rules without one, and a duplicate id is an error. */
export function addRules(existing: readonly ContentRule[], incoming: readonly unknown[]): ContentRule[] {
  const out = [...existing]
  const ids = new Set(out.map((r) => r.id))
  let n = out.length
  const added: ContentRule[] = []
  for (const raw of incoming) {
    if (!isObject(raw)) throw new Error('Invalid rule.')
    const conditions = Array.isArray(raw.conditions) ? raw.conditions.filter(isObject) : []
    const actions = Array.isArray(raw.actions) ? raw.actions.filter(isObject) : []
    if (conditions.length === 0 || actions.length === 0) throw new Error('A rule needs at least one condition and one action.')
    let id = typeof raw.id === 'string' && raw.id ? raw.id : ''
    if (!id) {
      while (ids.has(`_${n}_`)) n++
      id = `_${n}_`
    }
    if (ids.has(id)) throw new Error(`Duplicate rule ID: ${id}`)
    ids.add(id)
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : []
    const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 100
    added.push({ id, priority, tags, conditions, actions })
  }
  if (out.length + added.length > RULES_MAX) throw new Error('Too many rules.')
  return [...out, ...added]
}

export function removeRules(existing: readonly ContentRule[], ids?: readonly string[]): ContentRule[] {
  if (!ids) return []
  const drop = new Set(ids)
  return existing.filter((r) => !drop.has(r.id))
}

export function getRules(existing: readonly ContentRule[], ids?: readonly string[]): ContentRule[] {
  if (!ids) return [...existing]
  const want = new Set(ids)
  return existing.filter((r) => want.has(r.id))
}

/** Chrome's UrlFilter (events.UrlFilter) against one URL. Every given criterion must hold. */
export function urlFilterMatches(filter: Record<string, unknown>, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname
  const path = u.pathname
  const query = u.search.replace(/^\?/, '')
  const noFragment = url.split('#')[0] ?? url
  const str = (k: string): string | null => (typeof filter[k] === 'string' ? (filter[k] as string) : null)
  const checks: Array<[string, (v: string) => boolean]> = [
    ['hostEquals', (v) => host === v.toLowerCase()],
    ['hostContains', (v) => `.${host}`.includes(v.toLowerCase())],
    ['hostPrefix', (v) => host.startsWith(v.toLowerCase())],
    ['hostSuffix', (v) => host.endsWith(v.toLowerCase())],
    ['pathEquals', (v) => path === v],
    ['pathContains', (v) => path.includes(v)],
    ['pathPrefix', (v) => path.startsWith(v)],
    ['pathSuffix', (v) => path.endsWith(v)],
    ['queryEquals', (v) => query === v],
    ['queryContains', (v) => query.includes(v)],
    ['queryPrefix', (v) => query.startsWith(v)],
    ['querySuffix', (v) => query.endsWith(v)],
    ['urlEquals', (v) => noFragment === v],
    ['urlContains', (v) => noFragment.includes(v)],
    ['urlPrefix', (v) => noFragment.startsWith(v)],
    ['urlSuffix', (v) => noFragment.endsWith(v)],
    ['urlMatches', (v) => regexTest(v, noFragment)],
    ['originAndPathMatches', (v) => regexTest(v, `${u.origin}${path}`)],
  ]
  for (const [key, test] of checks) {
    const v = str(key)
    if (v !== null && !test(v)) return false
  }
  if (Array.isArray(filter.schemes) && !filter.schemes.includes(u.protocol.replace(/:$/, ''))) return false
  if (Array.isArray(filter.ports)) {
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0))
    const ok = filter.ports.some((p) => (typeof p === 'number' ? p === port : Array.isArray(p) && p.length === 2 && port >= Number(p[0]) && port <= Number(p[1])))
    if (!ok) return false
  }
  return true
}

function regexTest(source: string, value: string): boolean {
  try {
    return new RegExp(source).test(value)
  } catch {
    return false
  }
}

const isType = (o: Record<string, unknown>, type: string): boolean => o.instanceType === `declarativeContent.${type}`

/** Whether a PageStateMatcher holds for a page Atelier can judge by its URL. */
export function matcherMatches(condition: Record<string, unknown>, url: string): boolean {
  if (!isType(condition, 'PageStateMatcher')) return false
  if (Array.isArray(condition.css) && condition.css.length > 0) return false
  if (condition.isBookmarked !== undefined) return false
  const pageUrl = condition.pageUrl
  return isObject(pageUrl) ? urlFilterMatches(pageUrl, url) : true
}

/** Whether any rule turns the action on for this page (ShowAction / ShowPageAction). */
export function rulesShowAction(rules: readonly ContentRule[], url: string): boolean {
  return rules.some((r) => r.actions.some((a) => isType(a, 'ShowAction') || isType(a, 'ShowPageAction')) && r.conditions.some((c) => matcherMatches(c, url)))
}
