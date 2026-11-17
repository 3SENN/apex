/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What activity memory never records: Apex's own sensitive categories as
// small curated domain lists, plus your own sites, matched with subdomains.
// Also used by the timeline and by the routine and app suggestions.

export const SENSITIVE_CATEGORIES = ['health', 'finance', 'adult', 'dating', 'religion', 'politics', 'government-id'] as const
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number]

export interface Exclusions {
  categories: SensitiveCategory[]
  /** Hosts you excluded; a host also excludes its subdomains. */
  sites: string[]
}

/**
 * Apex's curated lists: well-known sites per category, kept small on
 * purpose. A listed domain also covers its subdomains. They are a safety
 * net, not a classifier; your own list catches the rest.
 */
export const SENSITIVE_DOMAINS: Readonly<Record<SensitiveCategory, readonly string[]>> = {
  health: [
    'webmd.com', 'mayoclinic.org', 'healthline.com', 'medlineplus.gov', 'nhs.uk', 'patient.info', 'drugs.com', 'zocdoc.com',
    'goodrx.com', 'psychologytoday.com', 'betterhelp.com', 'talkspace.com', 'mychart.com', 'thuisarts.nl', 'doctolib.fr', 'doctolib.de',
  ],
  finance: [
    'paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'schwab.com',
    'fidelity.com', 'vanguard.com', 'robinhood.com', 'coinbase.com', 'revolut.com', 'wise.com', 'n26.com', 'monzo.com', 'bunq.com',
    'ing.nl', 'ing.com', 'rabobank.nl', 'abnamro.nl', 'hsbc.com', 'barclays.co.uk', 'creditkarma.com', 'intuit.com',
  ],
  adult: ['pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com', 'redtube.com', 'youporn.com', 'onlyfans.com', 'chaturbate.com'],
  dating: [
    'tinder.com', 'bumble.com', 'hinge.co', 'match.com', 'okcupid.com', 'grindr.com', 'happn.com', 'eharmony.com', 'pof.com',
    'plentyoffish.com', 'feeld.co', 'badoo.com', 'parship.com', 'lexa.nl',
  ],
  religion: ['biblegateway.com', 'bible.com', 'quran.com', 'sefaria.org', 'chabad.org', 'churchofjesuschrist.org', 'jw.org', 'vatican.va', 'islamicfinder.org'],
  politics: ['democrats.org', 'gop.com', 'actblue.com', 'winred.com', 'labour.org.uk', 'conservatives.com', 'ballotpedia.org', 'fec.gov'],
  'government-id': [
    'irs.gov', 'ssa.gov', 'login.gov', 'id.me', 'uscis.gov', 'travel.state.gov', 'gov.uk', 'canada.ca', 'digid.nl', 'mijnoverheid.nl',
    'belastingdienst.nl', 'service-public.fr', 'ants.gouv.fr', 'elster.de',
  ],
}

/** Top-level domains that name a sensitive category by themselves. */
const SENSITIVE_SUFFIXES: Readonly<Partial<Record<SensitiveCategory, readonly string[]>>> = {
  finance: ['bank', 'insurance'],
  adult: ['xxx', 'porn', 'adult', 'sex'],
  dating: ['dating'],
}

const HOST = /^[a-z0-9.-]{1,253}$/

/** The lowercased host of an http(s) address, or null. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

/**
 * A site as you typed it ("https://www.Example.com/path", "example.com")
 * reduced to the host it excludes, without a leading "www.". Null when
 * nothing usable is left.
 */
export function normalizeSite(input: string): string | null {
  const text = input.trim().toLowerCase()
  if (!text) return null
  const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`)
  if (!host || !HOST.test(host) || !host.includes('.')) return null
  return host.replace(/^www\./, '')
}

/** True when `host` is `site` or one of its subdomains. */
export function hostMatches(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`)
}

export type ExclusionMatch = { kind: 'category'; category: SensitiveCategory } | { kind: 'site'; site: string } | { kind: 'not-web' }

/** Why a page must not be recorded, or null when it may be. Anything that isn't an http(s) page is never recorded. */
export function exclusionFor(url: string, excluded: Exclusions): ExclusionMatch | null {
  const host = hostOf(url)
  if (!host) return { kind: 'not-web' }
  for (const raw of excluded.sites) {
    const site = normalizeSite(raw)
    if (site && hostMatches(host, site)) return { kind: 'site', site }
  }
  const tld = host.slice(host.lastIndexOf('.') + 1)
  for (const category of excluded.categories) {
    if (SENSITIVE_DOMAINS[category]?.some((domain) => hostMatches(host, domain))) return { kind: 'category', category }
    if (SENSITIVE_SUFFIXES[category]?.includes(tld)) return { kind: 'category', category }
  }
  return null
}

/** Whether a page must not be recorded: your sites, the chosen categories, and anything that isn't an http(s) page. */
export function isExcluded(url: string, excluded: Exclusions): boolean {
  return exclusionFor(url, excluded) !== null
}
