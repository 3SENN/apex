/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Every app in one list (AP-01): websites saved as apps, apps and panels from
// the packs that run, and the apps your companions made, kept live. The
// sidebar and Workspace › Apps both read it; what shows in the sidebar, and
// how, is the person's choice in settings (sidebar.apps).
import { useEffect, useState } from 'react'
import type { AppSummary } from '@shared/apps'
import type { PackItem } from '@shared/packs'
import { builtAppRef, packAppRef, packPanelRef, parseAppRef, webAppRef, withMove, withShow, type AppItem, type SidebarAppPin, type SidebarAppShow } from '@shared/sidebarApps'
import type { WebApp } from '@shared/webApps'
import { atelier, call, errorText } from '../api'
import { companionsSnapshot } from '../components/companionData'
import { t } from '../i18n/useT'
import { toast } from '../ui'

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function webItem(app: WebApp): AppItem {
  return { ref: webAppRef(app.id), kind: 'web', name: app.name, icon: app.icon, source: hostOf(app.url), defaultShow: 'hidden', status: null }
}

export function packItem(item: PackItem): AppItem {
  const app = item.kind === 'app'
  return {
    ref: app ? packAppRef(item.packId, item.itemId) : packPanelRef(item.packId, item.itemId),
    kind: app ? 'pack-app' : 'pack-panel',
    name: item.title,
    icon: item.icon,
    source: item.packName,
    defaultShow: item.sidebar ? 'row' : 'hidden',
    status: item.status,
  }
}

export function builtItem(app: AppSummary): AppItem {
  const maker = companionsSnapshot().items.find((c) => c.id === app.createdBy)?.name
  return { ref: builtAppRef(app.id), kind: 'built', name: app.name, icon: null, source: maker ? t('platform.library.madeBy', { companion: maker }) : t('platform.library.madeWithCompanion'), defaultShow: 'hidden', status: null }
}

interface Parts {
  web: AppItem[] | null
  packs: AppItem[] | null
  built: AppItem[] | null
}

/**
 * The apps, kept live: null until each part has loaded once. `packs: false`
 * leaves out the packs' apps (a private window keeps no pack rows).
 */
export function useAppLibrary(options: { packs?: boolean } = {}): AppItem[] | null {
  const withPacks = options.packs !== false
  const [parts, setParts] = useState<Parts>({ web: null, packs: withPacks ? null : [], built: null })
  useEffect(() => {
    let alive = true
    const set = (patch: Partial<Parts>): void => {
      if (alive) setParts((p) => ({ ...p, ...patch }))
    }
    const loadPacks = (): void => {
      if (withPacks) void Promise.resolve(call('packs', 'items')).then((items) => set({ packs: items.map(packItem) }), () => set({ packs: [] }))
    }
    void Promise.resolve(call('webApps', 'list')).then((apps) => set({ web: apps.map(webItem) }), () => set({ web: [] }))
    void Promise.resolve(call('apps', 'list')).then((apps) => set({ built: apps.map(builtItem) }), () => set({ built: [] }))
    loadPacks()
    const off = atelier.onAppEvent((event) => {
      if (event.type === 'web-apps') set({ web: event.items.map(webItem) })
      else if (event.type === 'apps') set({ built: event.items.map(builtItem) })
      else if (event.type === 'packs') loadPacks()
      else if (event.type === 'pack-status' && withPacks) {
        const ref = packAppRef(event.packId, event.itemId)
        setParts((p) => ({ ...p, packs: p.packs?.map((i) => (i.ref === ref ? { ...i, status: event.status } : i)) ?? null }))
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [withPacks])
  if (!parts.web || !parts.packs || !parts.built) return null
  return [...parts.web, ...parts.packs, ...parts.built]
}

/** Opens an app where it belongs: a web app in its own tab, a panel beside the page (or in a tab), the rest in a tab. */
export function openAppItem(item: Pick<AppItem, 'ref'>, options: { inTab?: boolean } = {}): void {
  const parsed = parseAppRef(item.ref)
  if (!parsed) return
  const opening =
    parsed.kind === 'web'
      ? call('webApps', 'open', parsed.id)
      : parsed.kind === 'built'
        ? call('apps', 'open', parsed.id)
        : parsed.kind === 'pack-app'
          ? call('packs', 'openApp', parsed.packId, parsed.id)
          : call('packs', 'openPanel', parsed.packId, parsed.id, !options.inTab)
  void Promise.resolve(opening).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
}

function savePins(apps: SidebarAppPin[]): void {
  atelier.settings.set({ sidebar: { apps } }).catch((err: unknown) => toast.show({ tone: 'error', message: t('platform.library.couldntSave', { reason: errorText(err) }) }))
}

/** Shows one app in the sidebar as a row or an icon, or takes it out. */
export function setAppShow(pins: readonly SidebarAppPin[], ref: string, show: SidebarAppShow): void {
  savePins(withShow(pins, ref, show))
}

/** Moves an app in the sidebar (before `beforeRef`, or to the end), as `show`. */
export function moveApp(pins: readonly SidebarAppPin[], shown: ReadonlyArray<{ ref: string; show: SidebarAppShow }>, ref: string, beforeRef: string | null, show?: SidebarAppShow): void {
  savePins(withMove(pins, shown, ref, beforeRef, show))
}

/** The "In the sidebar" menu items, the current one checked, for showContextMenu. */
export function sidebarMenuItems(current: SidebarAppShow): Array<{ id: string; label: string; type: 'radio'; checked: boolean }> {
  return [
    { id: 'show:row', label: t('platform.library.show.row'), type: 'radio', checked: current === 'row' },
    { id: 'show:icon', label: t('platform.library.show.icon'), type: 'radio', checked: current === 'icon' },
    { id: 'show:hidden', label: t('platform.library.show.hidden'), type: 'radio', checked: current === 'hidden' },
  ]
}

/** The show a menu choice made by sidebarMenuItems picks, or null for another item. */
export function chosenShow(id: string | null): SidebarAppShow | null {
  return id === 'show:row' || id === 'show:icon' || id === 'show:hidden' ? id.slice(5) as SidebarAppShow : null
}
