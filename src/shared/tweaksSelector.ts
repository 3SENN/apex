/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The picker's selectors (TWK-02): from the element someone clicked to a CSS
// selector that finds it again after a reload. Stable ids and test hooks
// first, then tag and the classes that look hand-written (not the hashed
// ones CSS-in-JS and CSS modules make anew on every build), climbing to
// ancestors and adding :nth-of-type only where the page has look-alikes.
// Pure: the preload adapts DOM elements to SelectorNode, tests use plain objects.

export interface SelectorNode {
  /** Lowercase tag name. */
  tag: string
  id: string
  classes: readonly string[]
  attr(name: string): string | null
  parent: SelectorNode | null
  /** 1-based position among the parent's children with the same tag. */
  nthOfType: number
  /** How many of the parent's children share the tag. */
  ofType: number
}

/** document.querySelectorAll(selector).length; a selector that throws counts as no match. */
export type CountMatches = (selector: string) => number

const MAX_DEPTH = 7
const MAX_CLASSES = 2
const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'] as const

/** CSS.escape (CSSOM §2.1.1), for environments without it. */
export function cssEscape(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const ch = value.charAt(i)
    if (code === 0) out += '\uFFFD'
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (i === 0 && code >= 0x30 && code <= 0x39) || (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)) out += `\\${code.toString(16)} `
    else if (i === 0 && value.length === 1 && code === 0x2d) out += `\\${ch}`
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) out += ch
    else out += `\\${ch}`
  }
  return out
}

function attrValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/[\n\r]/g, ' ')}"`
}

/**
 * Whether a class or id reads as written by a person: not a build hash
 * (css-1x2y3z, sc-AbCdE, Header_title__3xYz, a long random token) and not a
 * state that comes and goes (is-open, active, hover).
 */
export function isStableToken(token: string): boolean {
  if (!token || token.length > 48) return false
  if (/^(css|sc|jsx|emotion|styled|svelte|astro|tw|ng)-/i.test(token)) return false
  if (/_{1,2}[A-Za-z0-9-]{5,}$/.test(token) && /[0-9]/.test(token.split('_').pop() ?? '')) return false
  if (/\d{3,}/.test(token)) return false
  if (/^[a-z0-9]{6,}$/i.test(token) && /\d/.test(token) && /[a-z]/i.test(token)) return false
  if (/[A-Z].*[a-z].*[A-Z].*\d|\d.*[A-Z].*[a-z]/.test(token) && !/[-_]/.test(token)) return false
  if (/^(is|has)-|^(active|hover|focus|focused|open|opened|selected|visible|hidden|show|shown|current|expanded|collapsed)$/i.test(token)) return false
  if (/[:[\]()]/.test(token)) return false // utility classes like md:flex or w-[200px]
  return true
}

function idPart(node: SelectorNode): string | null {
  return node.id && isStableToken(node.id) ? `#${cssEscape(node.id)}` : null
}

function testPart(node: SelectorNode): string | null {
  for (const name of TEST_ATTRS) {
    const value = node.attr(name)
    if (value && value.length <= 80) return `${node.tag}[${name}=${attrValue(value)}]`
  }
  return null
}

function ownPart(node: SelectorNode, nth: boolean): string {
  const classes = node.classes.filter(isStableToken).slice(0, MAX_CLASSES).map((c) => `.${cssEscape(c)}`)
  const base = `${node.tag}${classes.join('')}`
  return nth && node.ofType > 1 ? `${base}:nth-of-type(${node.nthOfType})` : base
}

/** A selector that matches the element alone, or null when nothing short enough does. */
export function selectorFor(target: SelectorNode, count: CountMatches): string | null {
  const unique = (sel: string): boolean => {
    try {
      return count(sel) === 1
    } catch {
      return false
    }
  }
  if (target.tag === 'html' || target.tag === 'body' || target.tag === 'head') return null
  const own = idPart(target) ?? testPart(target)
  if (own && unique(own)) return own

  const chain: string[] = []
  let node: SelectorNode | null = target
  for (let depth = 0; node && depth < MAX_DEPTH; depth++) {
    if (node.tag === 'html') break
    const anchor = depth > 0 ? (idPart(node) ?? testPart(node)) : null
    if (anchor && unique(anchor)) {
      const withAnchor = [anchor, ...chain].join(' > ')
      // The anchor and the path below it, first without positions, then with.
      if (unique(withAnchor)) return withAnchor
    }
    const loose = ownPart(node, false)
    const strict = ownPart(node, true)
    // A bare tag ("p", "p:nth-of-type(2)") alone matches by accident; it needs an ancestor.
    const weak = chain.length === 0 && !loose.includes('.')
    if (!weak) {
      const tryLoose = [loose, ...chain].join(' > ')
      if (unique(tryLoose)) return tryLoose
      const tryStrict = [strict, ...chain].join(' > ')
      if (unique(tryStrict)) return tryStrict
    }
    chain.unshift(strict)
    if (node.tag === 'body') break
    node = node.parent
  }
  const full = chain.join(' > ')
  return full && unique(full) ? full : null
}

/** How the picker names what it hid: an accessible name or short text, else tag and class. */
export function describeNode(node: SelectorNode, text: string): string {
  const named = node.attr('aria-label') ?? node.attr('alt') ?? node.attr('title')
  const words = (named ?? text).replace(/\s+/g, ' ').trim()
  const shape = `${node.tag}${node.classes.filter(isStableToken).slice(0, 1).map((c) => `.${c}`).join('')}`
  if (!words) return shape
  return `${shape} · ${words.length > 48 ? `${words.slice(0, 47)}…` : words}`
}
