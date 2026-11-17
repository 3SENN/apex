/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apps from packs (AP-01), in Workspace › Apps: the apps, games and panels
// the packs you have bring, as tiles (click to open; right-click to keep one
// in the sidebar or see its pack), shown only when there are some. Packs are
// added and managed on the Packs page; what they bring to use is here, with
// everything else you open.
import { useEffect, type MouseEvent, type ReactElement } from 'react'
import { PanelLeft } from 'lucide-react'
import { packsPageUrl } from '@shared/packs'
import { parseAppRef, showOf, type AppItem, type SidebarAppPin, type SidebarAppShow } from '@shared/sidebarApps'
import { call } from '../../../api'
import { AppLogo } from '../../../apps/SidebarApps'
import { chosenShow, openAppItem, setAppShow, sidebarMenuItems, useAppLibrary } from '../../../apps/library'
import { t } from '../../../i18n/useT'
import { showContextMenu } from '../../../ui'

/** A small mark on a tile that's in the sidebar. */
export function SidebarMark({ show }: { show: SidebarAppShow }): ReactElement | null {
  if (show === 'hidden') return null
  const label = t(show === 'icon' ? 'platform.library.inSidebarIcon' : 'platform.library.inSidebar')
  return (
    <span className="ap-mark" role="img" aria-label={label} title={label}>
      <PanelLeft aria-hidden />
    </span>
  )
}

/** Get more apps: Discover on the Packs page. */
export function browsePacks(): void {
  void call('pages', 'open', packsPageUrl({ tab: 'browse' }))
}

export function PackAppsBlock({ pins, onCount, onEmpty }: { pins: SidebarAppPin[]; onCount?(count: number): void; onEmpty?(empty: boolean): void }): ReactElement | null {
  const items = useAppLibrary()
  const packs = items?.filter((i) => i.kind === 'pack-app' || i.kind === 'pack-panel') ?? null
  useEffect(() => {
    if (!packs) return
    onCount?.(packs.filter((p) => p.kind === 'pack-app').length)
    onEmpty?.(packs.length === 0)
  }, [packs?.length])

  const menu = (item: AppItem) => async (e: MouseEvent): Promise<void> => {
    e.preventDefault()
    const id = await showContextMenu(e, [
      { id: 'open', label: t('platform.library.open') },
      ...(item.kind === 'pack-panel' ? [{ id: 'open-tab', label: t('platform.library.openInTab') }] : []),
      { id: 'sep-sidebar', label: '', type: 'separator' },
      ...sidebarMenuItems(showOf(item, pins)),
      { id: 'sep-pack', label: '', type: 'separator' },
      { id: 'pack', label: t('platform.library.aboutPack', { pack: item.source }) },
    ])
    const show = chosenShow(id)
    const parsed = parseAppRef(item.ref)
    if (show) setAppShow(pins, item.ref, show)
    else if (id === 'open') openAppItem(item)
    else if (id === 'open-tab') openAppItem(item, { inTab: true })
    else if (id === 'pack' && parsed && 'packId' in parsed) void call('pages', 'open', packsPageUrl({ pack: parsed.packId }))
  }

  if (!packs || packs.length === 0) return null
  return (
    <div className="wa">
      <h3 className="wa__title">{t('platform.library.fromPacks')}</h3>
      {packs.length > 0 && (
        <div className="wa__grid" role="list" aria-label={t('platform.library.fromPacks')}>
          {packs.map((item) => (
            <div role="listitem" key={item.ref}>
              <button type="button" className="pl-tile wa-tile" onClick={() => openAppItem(item)} onContextMenu={(e) => void menu(item)(e)} aria-label={t('platform.library.openLabel', { name: item.name })}>
                <span className="wa-icon" aria-hidden="true">
                  <AppLogo item={item} size={22} />
                </span>
                <span className="pl-tile__text">
                  <span className="pl-tile__name">
                    <span>{item.name}</span>
                  </span>
                  <span className="pl-tile__desc">{`${item.source} · ${t(item.kind === 'pack-panel' ? 'platform.library.kind.panel' : 'platform.library.kind.app')}`}</span>
                </span>
                <SidebarMark show={showOf(item, pins)} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
