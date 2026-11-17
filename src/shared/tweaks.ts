/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tweaks (TWK-01 to TWK-06): per-site changes to how a page looks, without
// writing an extension. A tweak belongs to one site (a host, optionally with
// its subdomains) and holds:
// - hidden elements: ones picked on the page to hide, kept as CSS selectors;
// - a style: a font, a colour wash, an accent for links and controls, and
//   focus, which hides sidebars, promos and share bars around the content;
// - custom CSS, and custom JavaScript that runs only while "Allow custom
//   scripts" is on and the tweak's own script switch is on.
// The page preload asks main for the rules at document start: the generated
// CSS and the custom CSS go in with webFrame.insertCSS, the script runs in an
// isolated world of its own (it shares the DOM, never the page's JavaScript).
// Tweaks never run on account sign-in pages (signInHosts.ts) or atelier:// pages.
// This module is pure: main (src/main/tweaks), the preload and the chrome share it.
import { BRAND_NAME } from './branding'
import { isSignInHost, isSignInUrl } from './signInHosts'
import { ACCENT_HUES, type AccentHue } from './theme'

export const TWEAK_FONTS = ['default', 'sans', 'serif', 'mono', 'rounded'] as const
export type TweakFont = (typeof TWEAK_FONTS)[number]

/** The wash and accent presets: Atelier's own accent hues. */
export const TWEAK_COLORS = ACCENT_HUES.map((h) => h.id) as AccentHue[]
export type TweakColor = AccentHue

export interface TweakStyle {
  font: TweakFont
  /** A light wash of colour over the whole page, or none. */
  tint: TweakColor | null
  /** Links in text, form controls, the caret and the selection in this colour (#rrggbb), or the site's own. */
  accent: string | null
  /** Hides sidebars, promos, newsletters and share bars around the main content. */
  focus: boolean
}

export interface HiddenElement {
  id: string
  selector: string
  /** A short description of what was hidden (tag and class, or its text), as the page had it. */
  label: string
  createdAt: number
}

export interface Tweak {
  id: string
  /** Lowercase host without a leading www. */
  host: string
  /** Also runs on every subdomain of the host. */
  subdomains: boolean
  enabled: boolean
  hidden: HiddenElement[]
  style: TweakStyle
  css: string
  js: string
  /** The script runs only with this on and "Allow custom scripts" on; imported scripts arrive off. */
  jsEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface TweaksState {
  tweaks: Tweak[]
  /** The advanced switch: custom JavaScript runs on no site while it is off. */
  scriptsAllowed: boolean
}

export type TweakPatch = Partial<Pick<Tweak, 'enabled' | 'subdomains' | 'css' | 'js' | 'jsEnabled'>> & { style?: Partial<TweakStyle> }

/** Why tweaks can't run on a page: an Atelier page, an account sign-in page, or not a web page at all. */
export type TweakBlock = 'internal' | 'sign-in' | 'not-web'

export interface TweakTabInfo {
  /** The page's tweak host (www. dropped), or null when it has none. */
  host: string | null
  blocked: TweakBlock | null
  /** The tweak that owns this page: the exact host's, else one covering its subdomains. */
  tweak: Tweak | null
  scriptsAllowed: boolean
  /** Whether the tab is picking elements to hide right now. */
  picking: boolean
}

export interface TweakImportResult {
  added: number
  replaced: number
  skipped: number
  /** Imported tweaks that carry a script; each arrives with its script switched off. */
  scripts: number
}

export const TWEAK_LIMITS = {
  tweaks: 1000,
  hidden: 200,
  selector: 512,
  label: 80,
  css: 100_000,
  js: 100_000,
  importBytes: 4_000_000,
} as const

export const DEFAULT_TWEAK_STYLE: TweakStyle = { font: 'default', tint: null, accent: null, focus: false }

export const TWEAK_EXPORT_FORMAT = 'atelier-tweaks'
export const TWEAK_EXPORT_VERSION = 1

export interface TweaksServices {
  tweaks: {
    state(): TweaksState
    /** The tweak for the tab's page and whether tweaks can run there. */
    forTab(tabId: string): TweakTabInfo
    /** A new, empty tweak for a host or address (or the existing one for it). */
    create(hostOrUrl: string): Tweak
    update(id: string, patch: TweakPatch): Tweak
    remove(id: string): void
    /** Puts back a tweak just removed (the toast's Undo). */
    restore(tweak: Tweak): Tweak
    removeHidden(id: string, hiddenId: string): Tweak
    clearHidden(id: string): Tweak
    setScriptsAllowed(on: boolean): TweaksState
    /** Starts picking elements to hide in the tab; false where tweaks can't run. */
    hideElements(tabId: string): boolean
    /** Opens the tweak's site in a new tab and starts picking there. */
    openAndHide(id: string): void
    /** Saves tweaks (all, or these) to a JSON file; the path, or null when cancelled. */
    exportFile(ids?: string[]): Promise<string | null>
    /** Reads tweaks from a JSON file someone exported; null when cancelled. */
    importFile(): Promise<TweakImportResult | null>
  }
}

export type TweaksEvent = { type: 'tweaks'; state: TweaksState }

// ---- page protocol (PAGE.tweaks, PAGE.tweaksPush) ----

/** page → main. 'get' is sendSync at document start; the rest are fire and forget from the picker. */
export type PageTweakMessage = { kind: 'get'; url: string } | { kind: 'hide'; selector: string; label: string } | { kind: 'undo' } | { kind: 'done' }

/** What a page runs: the generated CSS (hidden elements and style), the custom CSS and the scripts. */
export interface PageTweakRules {
  generated: string
  custom: string
  scripts: string[]
}

/** The picker's words, in the app language; main formats them. */
export interface PickerStrings {
  title: string
  hint: string
  keys: string
  undo: string
  done: string
  count: string
}

/** main → page. */
export type PageTweakPush =
  | { kind: 'rules'; rules: PageTweakRules }
  | { kind: 'pick'; on: true; strings: PickerStrings }
  | { kind: 'pick'; on: false }
  | { kind: 'count'; count: string; announce: string }

/** The isolated world tweak scripts run in: not the page's, not the preload's (999). */
export const TWEAK_WORLD_ID = 1207

// ---- hosts and matching ----

/** A host or address as a tweak host: lowercase, no port, no trailing dot, www. dropped. Null when it isn't one. */
export function normalizeTweakHost(input: string): string | null {
  const text = input.trim()
  if (!text || text.length > 2048) return null
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname
  } catch {
    return null
  }
  host = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  if (!host || host.length > 253) return null
  if (host.startsWith('[')) return host // an IPv6 address
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null
  return host
}

/** Why tweaks can't run on this URL, or null when they can. */
export function tweakBlock(url: string): TweakBlock | null {
  if (/^atelier:/i.test(url)) return 'internal'
  if (!/^https?:\/\//i.test(url)) return 'not-web'
  if (isSignInUrl(url)) return 'sign-in'
  return null
}

/** The tweak host of a web page, or null (non-http pages). */
export function pageTweakHost(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    return normalizeTweakHost(new URL(url).hostname)
  } catch {
    return null
  }
}

/** Whether a host may hold a tweak at all: not one whose every page is a sign-in page. */
export function tweakHostAllowed(host: string): boolean {
  return !isSignInHost(host) && !isSignInHost(`www.${host}`)
}

export function tweakCovers(tweak: Pick<Tweak, 'host' | 'subdomains'>, host: string): boolean {
  return host === tweak.host || (tweak.subdomains && host.endsWith(`.${tweak.host}`))
}

/** The tweak that owns a host: its exact tweak, else the closest one covering its subdomains. */
export function ownTweak<T extends Pick<Tweak, 'host' | 'subdomains'>>(tweaks: readonly T[], host: string): T | undefined {
  const exact = tweaks.find((b) => b.host === host)
  if (exact) return exact
  return tweaks.filter((b) => b.subdomains && tweakCovers(b, host)).sort((a, b) => b.host.length - a.host.length)[0]
}

/** The enabled tweaks that run on a URL, broadest first so the most specific one's rules come last and win. */
export function matchingTweaks<T extends Pick<Tweak, 'host' | 'subdomains' | 'enabled'>>(tweaks: readonly T[], url: string): T[] {
  if (tweakBlock(url)) return []
  const host = pageTweakHost(url)
  if (!host) return []
  return tweaks.filter((b) => b.enabled && tweakCovers(b, host)).sort((a, b) => a.host.length - b.host.length)
}

/** Everything a page runs, or null when no tweak applies. */
export function rulesFor(state: TweaksState, url: string): PageTweakRules | null {
  const tweaks = matchingTweaks(state.tweaks, url)
  if (tweaks.length === 0) return null
  const generated = tweaks.map(generatedCss).filter(Boolean).join('\n')
  const custom = tweaks.map((b) => sanitizeCss(b.css).css.trim()).filter(Boolean).join('\n')
  const scripts = state.scriptsAllowed ? tweaks.filter((b) => b.jsEnabled && b.js.trim()).map((b) => wrapScript(b.host, b.js)) : []
  if (!generated && !custom && scripts.length === 0) return null
  return { generated, custom, scripts }
}

/** A script wrapped so one that throws doesn't stop the next, with a name for the console. */
export function wrapScript(host: string, js: string): string {
  return `(() => {\ntry {\n${stripNul(js)}\n} catch (err) { console.error('${BRAND_NAME} tweak for ${host.replace(/[^a-z0-9.\-[\]:]/g, '')} failed', err) }\n})()\n//# sourceURL=atelier-tweak://${encodeURIComponent(host)}/tweak.js`
}

// ---- generated CSS ----

const FONT_STACKS: Record<Exclude<TweakFont, 'default'>, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, "New York", Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif',
}

/** Icon fonts and code keep their own faces. */
const FONT_KEEP = 'code, pre, pre *, kbd, samp, var, tt, svg, svg *, math, [class*="icon" i], [class*="fa-" i], [class*="material" i], [class*="glyph" i], [class*="symbol" i], [aria-hidden="true"]'

/** What focus hides: page furniture around the content, never a box that holds the content itself. */
const FOCUS_HIDE = [
  'aside',
  '[role="complementary"]',
  '[class*="sidebar" i]',
  '[id*="sidebar" i]',
  '[class*="related" i]',
  '[class*="recommend" i]',
  '[class*="newsletter" i]',
  '[class*="promo" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[class*="sponsor" i]',
  '[class*="social-share" i]',
  '[class*="share-bar" i]',
  '[class*="share-buttons" i]',
  'ins.adsbygoogle',
  '[id^="google_ads" i]',
  '[aria-label="advertisement" i]',
]
const FOCUS_KEEP = 'main, article, [role="main"], h1'

const HEX = /^#[0-9a-f]{6}$/i

export function isTweakColor(value: string): boolean {
  return HEX.test(value)
}

export function tintColor(tint: TweakColor): string {
  return ACCENT_HUES.find((h) => h.id === tint)?.color ?? ACCENT_HUES[0].color
}

/** The style's rules; each is !important, so it beats the page's ordinary declarations. */
export function styleCss(style: TweakStyle): string {
  const out: string[] = []
  if (style.font !== 'default' && Object.hasOwn(FONT_STACKS, style.font)) {
    out.push(`:where(html, body, body *:not(${FONT_KEEP})) { font-family: ${FONT_STACKS[style.font]} !important; }`)
  }
  if (style.tint && TWEAK_COLORS.includes(style.tint)) {
    const color = tintColor(style.tint)
    // Two light washes: multiply tints white paper, color tints the darker parts.
    out.push(`html::before, html::after { content: "" !important; position: fixed !important; inset: 0 !important; z-index: 2147483646 !important; pointer-events: none !important; background: ${color} !important; }`)
    out.push('html::before { mix-blend-mode: multiply !important; opacity: 0.1 !important; }')
    out.push('html::after { mix-blend-mode: color !important; opacity: 0.22 !important; }')
  }
  if (style.accent && isTweakColor(style.accent)) {
    const c = style.accent.toLowerCase()
    out.push(`:root { accent-color: ${c} !important; caret-color: ${c} !important; }`)
    out.push(`body :is(p, li, dd, td, blockquote, figcaption) a:any-link { color: ${c} !important; }`)
    out.push(`::selection { background-color: color-mix(in srgb, ${c} 32%, transparent) !important; }`)
  }
  if (style.focus) {
    out.push(`body :is(${FOCUS_HIDE.join(', ')}):not(:has(${FOCUS_KEEP})):not(${FOCUS_KEEP}) { display: none !important; }`)
  }
  return out.join('\n')
}

/**
 * Five impossible ids: :not() adds their weight (5,0,0) to a hiding rule, so it
 * also beats the page's own !important display rules short of that weight.
 */
export const HIDE_WEIGHT = ':not(#_#_#_#_#_)'

/** One rule per hidden element, its selector inside a forgiving :is(), so one Chromium can't parse drops only itself. */
export function hiddenCss(hidden: readonly Pick<HiddenElement, 'selector'>[]): string {
  return hidden
    .filter((el) => isSafeSelector(el.selector))
    .map((el) => `:is(${el.selector.trim()})${HIDE_WEIGHT} { display: none !important; }`)
    .join('\n')
}

export function generatedCss(tweak: Pick<Tweak, 'hidden' | 'style'>): string {
  return [hiddenCss(tweak.hidden), styleCss(tweak.style)].filter(Boolean).join('\n')
}

// ---- sanitising ----

/** A selector that can only select: no rule braces, at-rules, declarations or comments, and balanced quotes and brackets. */
export function isSafeSelector(selector: string): boolean {
  const s = selector.trim()
  if (!s || s.length > TWEAK_LIMITS.selector) return false
  if (/[\n\r\0]|\/\*|\*\//.test(s)) return false
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '}' || ch === ';' || ch === '@' || ch === '<') return false
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      depth--
      if (depth < 0) return false
    }
  }
  return quote === null && depth === 0
}

function stripNul(text: string): string {
  return text.replace(/\0/g, '')
}

/**
 * Custom CSS as it goes into the page: no @import (a stylesheet fetched from
 * elsewhere that nobody reviewed), no javascript: addresses, none of the old
 * script-running properties, at most TWEAK_LIMITS.css characters.
 */
export function sanitizeCss(css: string): { css: string; removed: number } {
  let removed = 0
  let out = stripNul(css).slice(0, TWEAK_LIMITS.css)
  const rules: [RegExp, string][] = [
    [/@import\b[^;{}]*;?/gi, ''],
    [/url\(\s*(['"]?)\s*javascript:/gi, 'url($1about:invalid#'],
    [/-moz-binding\s*:[^;}]*;?/gi, ''],
    [/\bbehavior\s*:[^;}]*;?/gi, ''],
    [/\bexpression\s*\(/gi, 'invalid('],
  ]
  for (const [pattern, replacement] of rules) {
    removed += out.match(pattern)?.length ?? 0
    out = out.replace(pattern, replacement)
  }
  return { css: out, removed }
}

/** Custom JavaScript as stored: no NUL, at most TWEAK_LIMITS.js characters. */
export function sanitizeJs(js: string): string {
  return stripNul(js).slice(0, TWEAK_LIMITS.js)
}

/** A hidden element's label: one line, at most TWEAK_LIMITS.label characters. */
export function cleanLabel(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim()
  return one.length > TWEAK_LIMITS.label ? `${one.slice(0, TWEAK_LIMITS.label - 1)}…` : one
}

/** A short summary of a tweak for lists: what it changes, as message parts the chrome words. */
export function tweakParts(tweak: Pick<Tweak, 'hidden' | 'style' | 'css' | 'js' | 'jsEnabled'>): { hidden: number; font: TweakFont | null; tint: boolean; accent: boolean; focus: boolean; css: boolean; js: boolean } {
  return {
    hidden: tweak.hidden.length,
    font: tweak.style.font === 'default' ? null : tweak.style.font,
    tint: tweak.style.tint !== null,
    accent: tweak.style.accent !== null,
    focus: tweak.style.focus,
    css: tweak.css.trim().length > 0,
    js: tweak.js.trim().length > 0,
  }
}

/** atelier://tweaks, opened on one site's tweak when given. */
export function tweaksUrl(host?: string | null): string {
  return host ? `atelier://tweaks?site=${encodeURIComponent(host)}` : 'atelier://tweaks'
}
