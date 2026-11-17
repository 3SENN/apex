/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

// The slice of a Chrome manifest Atelier reads: names, icons, the
// action, permissions, commands and the bits the compatibility check looks
// at. Everything else stays Electron's business.

export interface ManifestCommand {
  description?: string
  suggested_key?: { default?: string; mac?: string; windows?: string; linux?: string; chromeos?: string }
  global?: boolean
}

export interface Manifest {
  manifest_version?: number
  name?: string
  short_name?: string
  version?: string
  description?: string
  default_locale?: string
  icons?: Record<string, string>
  action?: { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string> }
  page_action?: unknown
  permissions?: unknown[]
  optional_permissions?: unknown[]
  host_permissions?: unknown[]
  optional_host_permissions?: unknown[]
  content_scripts?: { matches?: unknown[] }[]
  commands?: Record<string, ManifestCommand>
  theme?: unknown
  app?: unknown
  side_panel?: unknown
  devtools_page?: unknown
  chrome_url_overrides?: unknown
  background?: { service_worker?: string; scripts?: unknown; page?: unknown }
  key?: string
  homepage_url?: string
  update_url?: string
}

const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [])

/** API permissions (not host patterns) and host patterns, split the way MV2 mixed them. */
export function permissionLists(m: Manifest): { apis: string[]; hosts: string[]; optionalApis: string[]; optionalHosts: string[] } {
  const isHost = (p: string): boolean => p === '<all_urls>' || p.includes('://')
  const required = strings(m.permissions)
  const optional = strings(m.optional_permissions)
  const scripts = (m.content_scripts ?? []).flatMap((c) => strings(c?.matches))
  return {
    apis: required.filter((p) => !isHost(p)),
    hosts: [...new Set([...required.filter(isHost), ...strings(m.host_permissions), ...scripts])],
    optionalApis: optional.filter((p) => !isHost(p)),
    optionalHosts: [...new Set([...optional.filter(isHost), ...strings(m.optional_host_permissions)])],
  }
}

/** The action block, whichever manifest version spelled it. */
export function actionOf(m: Manifest): NonNullable<Manifest['action']> {
  return m.action ?? m.browser_action ?? {}
}

/** Resolves "__MSG_name__" strings from _locales (the default locale, then English). */
export function localize(dir: string, m: Manifest, value: string | undefined): string {
  if (!value) return ''
  const match = /^__MSG_(\w+)__$/.exec(value)
  if (!match?.[1]) return value
  const key = match[1].toLowerCase()
  for (const locale of [m.default_locale, 'en', 'en_US']) {
    if (!locale || !/^[\w-]+$/.test(locale)) continue
    const file = join(dir, '_locales', locale, 'messages.json')
    try {
      const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { message?: unknown }>
      for (const [k, v] of Object.entries(messages)) if (k.toLowerCase() === key && typeof v?.message === 'string') return v.message
    } catch {
      // Missing or broken locale file: try the next one.
    }
  }
  return value
}

/** Reads and parses manifest.json (BOM tolerated); null when it is missing or not an object. */
export function readManifest(dir: string): Manifest | null {
  try {
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Manifest) : null
  } catch {
    return null
  }
}

/** A path inside the extension's folder, or null when it would escape it. */
export function insideExtension(dir: string, relative: string): string | null {
  const clean = relative.replace(/^\/+/, '')
  const full = normalize(join(dir, clean))
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep)
  return full.startsWith(root) ? full : null
}

/** The icon file closest to `size` px (and at least that big when one is). */
export function pickIcon(icons: string | Record<string, string> | undefined, size: number): string | null {
  if (!icons) return null
  if (typeof icons === 'string') return icons
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  const best = sizes.find((n) => n >= size) ?? sizes[sizes.length - 1]
  return best === undefined ? null : (icons[String(best)] ?? null)
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' }
const ICON_MAX_BYTES = 512 * 1024

/** An icon file as a data URL for the chrome (capped; SVG and bitmaps only). */
export function iconDataUrl(dir: string, relative: string | null): string | null {
  if (!relative) return null
  const path = insideExtension(dir, relative)
  if (!path || !existsSync(path)) return null
  const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
  if (!type) return null
  try {
    const bytes = readFileSync(path)
    if (bytes.length > ICON_MAX_BYTES) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}
