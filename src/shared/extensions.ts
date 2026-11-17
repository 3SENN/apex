/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for Chrome Web Store extensions: toolbar buttons,
// the Extensions settings page, install and native-messaging prompts. Main
// runs them per profile session through ExtensionsHost
// (src/main/extensions/**), built on Electron's own session.extensions.
import type { Bounds } from './ipc'
import { isBlankUrl, isInternalUrl, parseInternalUrl } from './url'
import type { ApplePasswordsEvent, ApplePasswordsServices } from './applePasswords'

export interface ExtensionPermission {
  id: string
  /** Plain words ("Read and change your data on all websites"), in Atelier's own phrasing. */
  label: string
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  /** A data URL of the best-fitting manifest icon. */
  icon: string | null
  enabled: boolean
  pinned: boolean
  permissions: ExtensionPermission[]
  optional: (ExtensionPermission & { granted: boolean })[]
  siteAccess: 'all' | 'some' | 'none' | 'on-click'
  hosts: string[]
  /** False when it needs APIs Electron lacks: it shows the acknowledge-only notice instead of half-working. */
  supported: boolean
  unsupportedReason: string | null
  hasPopup: boolean
  badge: { text: string; color: string } | null
  storeUrl: string | null
  /** Manifest commands; `clash` names the Atelier shortcut that kept the key. */
  commands: { name: string; shortcut: string | null; clash: string | null }[]
  /** Its popup is open: an unpinned extension shows a temporary toolbar button meanwhile (SH-65). */
  popupOpen: boolean
  /** The action's tooltip (chrome.action.setTitle), or the name. */
  title: string
  /** Installed from the Web Store, or loaded unpacked (developer and smoke fixtures). */
  source: 'store' | 'unpacked'
}

export interface ExtensionInstallPrompt {
  id: string
  name: string
  icon: string | null
  permissions: ExtensionPermission[]
  optional: ExtensionPermission[]
  unsupportedReason: string | null
  /** 'install' for a new extension; 'optional' when an installed one asks for more later (OV-16). */
  kind: 'install' | 'optional'
}

export interface ExtensionNativePrompt {
  id: string
  extensionName: string
  /** The native-messaging host's name from its manifest. */
  host: string
}

export interface ExtensionsServices extends ApplePasswordsServices {
  extensions: {
    list(): ExtensionInfo[]
    setEnabled(id: string, on: boolean): void
    pin(id: string, on: boolean): void
    /** Removes it and clears its data (the chrome confirms first). */
    remove(id: string): Promise<void>
    revoke(id: string, permission: string | 'all'): void
    /** Clicks the toolbar button: opens its popup anchored to `anchor` (chrome CSS px), or fires the action. */
    runAction(id: string, anchor: Bounds): void
    openStore(): void
    report(id: string): void
    respondInstall(promptId: string, allow: boolean): void
    respondNative(promptId: string, decision: 'once' | 'always' | 'deny'): void
  }
}

export type ExtensionsEvent =
  | { type: 'extensions'; items: ExtensionInfo[] }
  | { type: 'extension-install-prompt'; prompt: ExtensionInstallPrompt }
  | { type: 'extension-native-prompt'; prompt: ExtensionNativePrompt }
  | ApplePasswordsEvent

/** Chrome's 32-character a–p extension ids. */
export const EXTENSION_ID = /^[a-p]{32}$/
export const EXTENSIONS_SETTINGS_URL = 'atelier://settings/extensions'
export const WEB_STORE_URL = 'https://chromewebstore.google.com/'

/** Exact Web Store origin check: a prefix match would also trust chromewebstore.google.com.evil.test. */
export function isWebStoreUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.host === 'chromewebstore.google.com'
  } catch {
    return false
  }
}


/** An extension's own page or popup: never actionable by the agent. */
export function isExtensionUrl(url: string): boolean {
  return /^chrome-extension:\/\//i.test(url)
}

/** The Web Store page for an extension. */
export function storeDetailUrl(id: string): string {
  return `${WEB_STORE_URL}detail/${id}`
}

/** The extension's store support page, where Report a problem goes. */
export function storeSupportUrl(id: string): string {
  return `${storeDetailUrl(id)}/support`
}

/** Chrome's popup limits: anything smaller or larger is clamped. */
export const POPUP_MIN = { width: 25, height: 25 } as const
export const POPUP_MAX = { width: 800, height: 600 } as const
/** The gap between a toolbar button's bottom edge and the popup or popover under it. */
export const ANCHOR_GAP = 4
/** How close a popup or popover may come to the window's edge. */
export const EDGE_MARGIN = 8

/**
 * Where a popup or popover goes under its toolbar button: right edges
 * aligned (the button sits at the toolbar's right end), flipped to the
 * left edge when that would leave the window, and clamped inside it.
 */
export function anchorBelow(anchor: Bounds, size: { width: number; height: number }, viewport: { width: number; height: number }): Bounds {
  const width = Math.min(size.width, Math.max(0, viewport.width - EDGE_MARGIN * 2))
  const height = Math.min(size.height, Math.max(0, viewport.height - anchor.y - anchor.height - ANCHOR_GAP - EDGE_MARGIN))
  let x = anchor.x + anchor.width - width
  if (x < EDGE_MARGIN) x = anchor.x
  x = Math.max(EDGE_MARGIN, Math.min(x, viewport.width - EDGE_MARGIN - width))
  const y = anchor.y + anchor.height + ANCHOR_GAP
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(Math.max(0, height)) }
}

/** Clamps a popup's preferred size to Chrome's limits. */
export function clampPopupSize(size: { width: number; height: number }): { width: number; height: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)))
  return { width: clamp(size.width, POPUP_MIN.width, POPUP_MAX.width), height: clamp(size.height, POPUP_MIN.height, POPUP_MAX.height) }
}

/** sRGB relative luminance of a #rgb/#rrggbb colour, or null when it isn't one. */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m?.[1]) return null
  const raw = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const channel = (i: number): number => {
    const v = parseInt(raw.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/**
 * A badge keeps the extension's colour, but its text picks black or white
 * for contrast (SH-65); an unreadable colour falls back to the theme's
 * badge token (null).
 */
export function badgeTextColor(background: string): '#000000' | '#ffffff' | null {
  const l = luminance(background)
  if (l === null) return null
  // Contrast against white and black; the larger wins.
  return (1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000')
}

/** Chrome's [r,g,b,a] badge colours become #rrggbb; strings pass when they're hex. */
export function normalizeBadgeColor(color: unknown): string | null {
  if (typeof color === 'string') return luminance(color) === null ? null : color.toLowerCase()
  if (Array.isArray(color) && color.length >= 3 && color.slice(0, 3).every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
    return `#${(color.slice(0, 3) as number[]).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
  }
  return null
}

// Toolbar and settings helpers for the renderer's extension surfaces (pure, so tests reach them).

/** What the toolbar's extension slot shows: buttons on websites, the lone Extensions button on utility pages, nothing elsewhere. */
export type ExtensionsSlot = 'website' | 'internal' | null

/** Internal tab pages that keep the Extensions button at the far right (DS-24); chats, destinations and the new tab stay empty. */
const UTILITY_PAGES: ReadonlySet<string> = new Set(['settings', 'history', 'bookmarks', 'downloads', 'library'])

export function extensionsSlot(url: string | null | undefined): ExtensionsSlot {
  if (!url || isBlankUrl(url)) return null
  if (!isInternalUrl(url)) return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url) ? 'website' : null
  const page = parseInternalUrl(url)?.page
  return page && UTILITY_PAGES.has(page) ? 'internal' : null
}

/** Case-insensitive search over names and descriptions (ST-40). */
export function filterExtensions(items: readonly ExtensionInfo[], query: string): ExtensionInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
}

/** Toolbar buttons: pinned ones in pin order, plus an unpinned one while its popup is open (SH-65). */
export function toolbarButtons(items: readonly ExtensionInfo[]): ExtensionInfo[] {
  return items.filter((e) => e.enabled && e.supported && (e.pinned || e.popupOpen))
}

/** "https://*.example.com/*" → "example.com"; repeated hosts collapse, file patterns read as null (the caller names them). */
export function hostOfPattern(pattern: string): string | null {
  if (/^file:/i.test(pattern)) return null
  const m = /^[^:]+:\/\/([^/]*)/.exec(pattern)
  const host = (m?.[1] ?? pattern).replace(/^\*\.?/, '').replace(/:\d+$/, '')
  return host || null
}

/** The hosts behind 'some' site access, at most `max` of them, and how many more there are. */
export function hostsSummary(patterns: readonly string[], max = 3): { hosts: string[]; more: number } {
  const all = [...new Set(patterns.map(hostOfPattern).filter((h): h is string => h !== null))]
  return { hosts: all.slice(0, max), more: Math.max(0, all.length - max) }
}

/** The granted optional permissions, for Revoke all. */
export function grantedOptional(ext: Pick<ExtensionInfo, 'optional'>): string[] {
  return ext.optional.filter((p) => p.granted).map((p) => p.id)
}

/** True when any manifest command lost its key to an Atelier shortcut. */
export function hasClash(ext: Pick<ExtensionInfo, 'commands'>): boolean {
  return ext.commands.some((c) => c.clash !== null)
}
