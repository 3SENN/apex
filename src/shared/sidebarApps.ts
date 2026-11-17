/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apps in one place, and in the sidebar the way you choose (AP-01). An app is
// anything you open and use: a website saved as an app, an app a companion
// built, or an app or panel a pack brings. Workspace › Apps lists them all;
// each can show in the sidebar as a row, as just its icon (a strip of logos
// above the rows), or not at all. A pack's own `sidebar: true` is only where
// its app starts; what the person picks wins, in the order they give.
import type { PackAppStatus } from './packs'

export type SidebarAppShow = 'row' | 'icon' | 'hidden'
export const SIDEBAR_APP_SHOWS: readonly SidebarAppShow[] = ['row', 'icon', 'hidden']

/** The person's choice for one app, kept in settings (sidebar.apps) in sidebar order. */
export interface SidebarAppPin {
  ref: string
  show: SidebarAppShow
}

export const SIDEBAR_APPS_MAX = 200

export type AppItemKind = 'web' | 'built' | 'pack-app' | 'pack-panel'

/** One app, wherever it comes from. */
export interface AppItem {
  /** web:<id>, built:<id>, pack:<packId>:app:<appId> or pack:<packId>:panel:<panelId>. */
  ref: string
  kind: AppItemKind
  name: string
  /** A data: URL, or null for the app's initial. */
  icon: string | null
  /** Where it comes from, for the library and the tooltip: the site, the pack, the companion. */
  source: string
  /** Where it starts before the person chooses: a pack's sidebar: true starts as a row. */
  defaultShow: SidebarAppShow
  /** A pack app's status (apex.status.set) while it runs. */
  status: PackAppStatus | null
}

export const webAppRef = (id: string): string => `web:${id}`
export const builtAppRef = (id: string): string => `built:${id}`
export const packAppRef = (packId: string, appId: string): string => `pack:${packId}:app:${appId}`
export const packPanelRef = (packId: string, panelId: string): string => `pack:${packId}:panel:${panelId}`

export type ParsedRef = { kind: 'web'; id: string } | { kind: 'built'; id: string } | { kind: 'pack-app'; packId: string; id: string } | { kind: 'pack-panel'; packId: string; id: string }

export function parseAppRef(ref: string): ParsedRef | null {
  const simple = /^(web|built):(.+)$/.exec(ref)
  if (simple) return simple[1] === 'web' ? { kind: 'web', id: simple[2]! } : { kind: 'built', id: simple[2]! }
  const pack = /^pack:(.+):(app|panel):([^:]+)$/.exec(ref)
  if (pack) return { kind: pack[2] === 'app' ? 'pack-app' : 'pack-panel', packId: pack[1]!, id: pack[3]! }
  return null
}

/** How an app shows: the person's choice, else where it starts. */
export function showOf(item: Pick<AppItem, 'ref' | 'defaultShow'>, pins: readonly SidebarAppPin[]): SidebarAppShow {
  return pins.find((p) => p.ref === item.ref)?.show ?? item.defaultShow
}

/**
 * The sidebar's apps: the icon strip and the rows, each in the person's
 * order, then apps that start in the sidebar and haven't been moved, in the
 * library's order. Apps that are gone simply don't show.
 */
export function sidebarLayout<T extends Pick<AppItem, 'ref' | 'defaultShow'>>(items: readonly T[], pins: readonly SidebarAppPin[]): { icons: T[]; rows: T[] } {
  const byRef = new Map(items.map((i) => [i.ref, i]))
  const ordered: T[] = []
  for (const pin of pins) {
    const item = byRef.get(pin.ref)
    if (item) ordered.push(item)
  }
  for (const item of items) if (!pins.some((p) => p.ref === item.ref)) ordered.push(item)
  const icons = ordered.filter((i) => showOf(i, pins) === 'icon')
  const rows = ordered.filter((i) => showOf(i, pins) === 'row')
  return { icons, rows }
}

/** The pins after choosing how one app shows: a new choice goes at the end of its group. */
export function withShow(pins: readonly SidebarAppPin[], ref: string, show: SidebarAppShow): SidebarAppPin[] {
  const rest = pins.filter((p) => p.ref !== ref)
  return [...rest, { ref, show }].slice(-SIDEBAR_APPS_MAX)
}

/**
 * The pins after dragging `ref` before `beforeRef` (null: to the end) among
 * what the sidebar shows (`shown`, in its order), as `show` (dropped among the
 * icons it becomes an icon). Every app on show gets a pin, so the order
 * holds; hidden choices are kept after them.
 */
export function withMove(pins: readonly SidebarAppPin[], shown: ReadonlyArray<{ ref: string; show: SidebarAppShow }>, ref: string, beforeRef: string | null, show?: SidebarAppShow): SidebarAppPin[] {
  const found = shown.find((s) => s.ref === ref)
  if (!found || ref === beforeRef) return [...pins]
  const moving = { ref, show: show ?? found.show }
  const order = shown.filter((s) => s.ref !== ref)
  const at = beforeRef === null ? order.length : order.findIndex((s) => s.ref === beforeRef)
  order.splice(at < 0 ? order.length : at, 0, moving)
  const kept = pins.filter((p) => !shown.some((s) => s.ref === p.ref))
  return [...order.map((s) => ({ ref: s.ref, show: s.show })), ...kept].slice(0, SIDEBAR_APPS_MAX)
}

/** Pins of apps that no longer exist, dropped (the library's refs are the living ones). */
export function prunePins(pins: readonly SidebarAppPin[], living: ReadonlySet<string>): SidebarAppPin[] {
  return pins.filter((p) => living.has(p.ref))
}
