/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The sidebar's apps (AP-01): the apps you keep at hand, under the
// destinations, as a strip of icons (just the logo) and as rows. You choose
// which and how: right-click one here or in Workspace › Apps to show it as a
// row, as an icon or not at all, and drag to reorder (dropped on the strip it
// becomes an icon, on a row a row). A pack app starts as a row when its pack
// asks, and its row shows the status the app sets (apex.status.set). A
// private window keeps no pack rows. Icons are images only.
import { useRef, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import { Package, PanelRight } from 'lucide-react'
import { showOf, sidebarLayout, type AppItem, type SidebarAppPin, type SidebarAppShow } from '@shared/sidebarApps'
import { apex } from '../api'
import { useT } from '../i18n/useT'
import { cx, showContextMenu } from '../ui'
import { goWorkspace } from '../workspace/open'
import { chosenShow, moveApp, openAppItem, setAppShow, sidebarMenuItems, useAppLibrary } from './library'
import './sidebarApps.css'

const DRAG_TYPE = 'application/x-apex-app'

/** An app's logo: its own image, else a glyph for a pack's, else its initial. */
export function AppLogo({ item, size = 16 }: { item: Pick<AppItem, 'icon' | 'kind' | 'name'>; size?: number }): ReactElement {
  const [broken, setBroken] = useState(false)
  if (item.icon && !broken) return <img className="app-logo" src={item.icon} alt="" width={size} height={size} draggable={false} onError={() => setBroken(true)} />
  if (item.kind === 'pack-panel') return <PanelRight size={size} aria-hidden />
  if (item.kind === 'pack-app') return <Package size={size} aria-hidden />
  return (
    <span className="app-logo app-logo--initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden>
      {item.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export function SidebarApps({ pins }: { pins: SidebarAppPin[] }): ReactElement | null {
  const t = useT()
  const items = useAppLibrary({ packs: apex.initial.window.kind !== 'private' })
  const dragging = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ ref: string | null; show: SidebarAppShow } | null>(null)
  if (!items) return null
  const { icons, rows } = sidebarLayout(items, pins)
  if (icons.length === 0 && rows.length === 0) return null
  const shown = [...icons.map((i) => ({ ref: i.ref, show: 'icon' as const })), ...rows.map((i) => ({ ref: i.ref, show: 'row' as const }))]

  const menu = async (e: MouseEvent, item: AppItem): Promise<void> => {
    e.preventDefault()
    const id = await showContextMenu(e, [
      { id: 'open', label: t('platform.library.open') },
      ...(item.kind === 'pack-panel' ? [{ id: 'open-tab', label: t('platform.library.openInTab') }] : []),
      { id: 'sep1', label: '', type: 'separator' },
      ...sidebarMenuItems(showOf(item, pins)),
      { id: 'sep2', label: '', type: 'separator' },
      { id: 'all', label: t('platform.library.allApps') },
    ])
    const show = chosenShow(id)
    if (show) setAppShow(pins, item.ref, show)
    else if (id === 'open') openAppItem(item)
    else if (id === 'open-tab') openAppItem(item, { inTab: true })
    else if (id === 'all') goWorkspace('apps')
  }

  const finish = (before: string | null, show: SidebarAppShow): void => {
    const ref = dragging.current
    dragging.current = null
    setDrop(null)
    if (ref && ref !== before) moveApp(pins, shown, ref, before, show)
  }
  const dragProps = (item: AppItem, show: SidebarAppShow) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragging.current = item.ref
      e.dataTransfer.setData(DRAG_TYPE, item.ref)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: DragEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      e.stopPropagation()
      if (drop?.ref !== item.ref) setDrop({ ref: item.ref, show })
    },
    onDrop: (e: DragEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      e.stopPropagation()
      finish(item.ref, show)
    },
    onDragEnd: () => {
      dragging.current = null
      setDrop(null)
    },
  })
  // The end of a group takes a drop too, so an app can go last or change form.
  const groupDrop = (show: SidebarAppShow) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      if (drop?.ref !== null || drop.show !== show) setDrop({ ref: null, show })
    },
    onDrop: (e: DragEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      finish(null, show)
    },
  })
  const label = (item: AppItem): string => t('platform.library.openLabel', { name: item.name })
  const dragActive = drop !== null

  return (
    <nav className="destinations side-apps" aria-label={t('platform.library.sidebarLabel')}>
      {(icons.length > 0 || dragActive) && (
        <div className={cx('side-apps__icons', icons.length === 0 && 'side-apps__icons--empty', drop?.show === 'icon' && drop.ref === null && 'side-apps__icons--drop')} {...groupDrop('icon')}>
          {icons.map((item) => (
            <button
              key={item.ref}
              type="button"
              data-sidebar-row
              tabIndex={-1}
              className={cx('side-app-icon', drop?.ref === item.ref && 'side-app-icon--drop')}
              aria-label={label(item)}
              title={`${item.name} · ${item.source}`}
              onClick={(e) => openAppItem(item, { inTab: e.metaKey || e.ctrlKey })}
              onAuxClick={(e) => e.button === 1 && openAppItem(item, { inTab: true })}
              onContextMenu={(e) => void menu(e, item)}
              {...dragProps(item, 'icon')}
            >
              <AppLogo item={item} size={18} />
              {item.status?.badge != null && <span className="side-app-icon__badge">{item.status.badge > 99 ? '99+' : item.status.badge}</span>}
              {item.status?.badge == null && item.status?.progress != null && <span className="side-app-icon__busy" aria-hidden />}
            </button>
          ))}
          {icons.length === 0 && <span className="side-apps__hint">{t('platform.library.dropForIcon')}</span>}
        </div>
      )}
      {rows.map((item) => (
        <button
          key={item.ref}
          type="button"
          data-sidebar-row
          tabIndex={-1}
          className={cx('side-row dest-row', drop?.ref === item.ref && 'side-row--drop-before')}
          aria-label={label(item)}
          title={`${item.name} · ${item.source}`}
          onClick={(e) => openAppItem(item, { inTab: e.metaKey || e.ctrlKey })}
          onAuxClick={(e) => e.button === 1 && openAppItem(item, { inTab: true })}
          onContextMenu={(e) => void menu(e, item)}
          {...dragProps(item, 'row')}
        >
          <span className="side-row__icon">
            <AppLogo item={item} />
          </span>
          <span className="side-row__title">{item.name}</span>
          {item.status && (
            <span className="side-row__badges side-pack-status">
              {item.status.text && <span className="side-pack-status__text">{item.status.text}</span>}
              {item.status.badge !== null && <span className="side-pack-status__badge">{item.status.badge > 99 ? '99+' : item.status.badge}</span>}
              {item.status.progress !== null && (
                <span className="side-pack-status__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.status.progress * 100)} aria-label={t('packs.sidebar.progress', { title: item.name })}>
                  <span style={{ width: `${Math.round(item.status.progress * 100)}%` }} />
                </span>
              )}
            </span>
          )}
        </button>
      ))}
      {dragActive && rows.length > 0 && <div className={cx('side-apps__end', drop?.show === 'row' && drop.ref === null && 'side-apps__end--drop')} {...groupDrop('row')} />}
    </nav>
  )
}
