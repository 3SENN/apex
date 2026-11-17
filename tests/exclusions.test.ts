/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { SENSITIVE_CATEGORIES, SENSITIVE_DOMAINS, exclusionFor, hostMatches, hostOf, isExcluded, normalizeSite } from '@shared/exclusions'

const all = { categories: [...SENSITIVE_CATEGORIES], sites: [] as string[] }
const none = { categories: [], sites: [] as string[] }

describe('exclusions', () => {
  it('has a curated list for every category', () => {
    for (const category of SENSITIVE_CATEGORIES) expect(SENSITIVE_DOMAINS[category].length).toBeGreaterThan(3)
  })

  it('matches a listed domain and its subdomains, not look-alikes', () => {
    expect(isExcluded('https://www.webmd.com/a', all)).toBe(true)
    expect(isExcluded('https://webmd.com', all)).toBe(true)
    expect(isExcluded('https://secure.chase.com/login', all)).toBe(true)
    expect(isExcluded('https://notwebmd.com', all)).toBe(false)
    expect(isExcluded('https://webmd.com.evil.example', all)).toBe(false)
    expect(exclusionFor('https://app.tinder.com', all)).toEqual({ kind: 'category', category: 'dating' })
  })

  it('only applies the chosen categories', () => {
    expect(isExcluded('https://www.webmd.com', none)).toBe(false)
    expect(isExcluded('https://www.webmd.com', { categories: ['finance'], sites: [] })).toBe(false)
    expect(isExcluded('https://www.webmd.com', { categories: ['health'], sites: [] })).toBe(true)
  })

  it('treats sensitive top-level domains as their category', () => {
    expect(exclusionFor('https://my.bank', all)).toEqual({ kind: 'category', category: 'finance' })
    expect(isExcluded('https://example.xxx', { categories: ['adult'], sites: [] })).toBe(true)
  })

  it('matches your own sites with subdomains, however you typed them', () => {
    const mine = { categories: [], sites: ['https://www.Example.org/path', 'intranet.corp.test'] }
    expect(isExcluded('https://example.org', mine)).toBe(true)
    expect(isExcluded('https://docs.example.org/x', mine)).toBe(true)
    expect(isExcluded('https://a.intranet.corp.test', mine)).toBe(true)
    expect(isExcluded('https://corp.test', mine)).toBe(false)
    expect(exclusionFor('https://docs.example.org', mine)).toEqual({ kind: 'site', site: 'example.org' })
  })

  it('never records anything that is not an http(s) page', () => {
    for (const url of ['apex://settings', 'apex-app://abc/', 'file:///Users/me/a.txt', 'about:blank', 'not a url']) expect(isExcluded(url, none)).toBe(true)
    expect(isExcluded('http://example.com', none)).toBe(false)
  })

  it('normalizes typed sites', () => {
    expect(normalizeSite('  WWW.Example.COM/a?b ')).toBe('example.com')
    expect(normalizeSite('http://sub.example.com')).toBe('sub.example.com')
    expect(normalizeSite('localhost')).toBeNull()
    expect(normalizeSite('')).toBeNull()
    expect(normalizeSite('exa mple.com')).toBeNull()
    expect(hostOf('https://Example.com./x')).toBe('example.com')
    expect(hostMatches('a.b.c', 'b.c')).toBe(true)
    expect(hostMatches('ab.c', 'b.c')).toBe(false)
  })
})
