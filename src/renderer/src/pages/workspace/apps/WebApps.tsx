/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Websites saved as apps (WA-01), in Workspace › Apps: your web apps as
// tiles (click to open: back to its tab when one is open, else a new one;
// right-click to keep it in the sidebar, rename or remove), and the sites
// you visit a lot that aren't apps yet, each with Save. They stay web
// addresses. With neither, the group doesn't show.
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { showOf, webAppRef, type SidebarAppPin } from '@shared/sidebarApps'
import type { WebApp, WebAppSuggestion } from '@shared/webApps'
import { call, errorText, useAppEvent } from '../../../api'
import { t } from '../../../i18n/useT'
import { useSiteIcons } from '../../welcome/Connectors'
import { chosenShow, setAppShow, sidebarMenuItems } from '../../../apps/library'
import { SidebarMark } from './PackApps'
import { Button, InlineRename, showContextMenu, toast } from '../../../ui'

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The site's icon, else its initial (also when the image won't load). */
function AppIcon({ app }: { app: Pick<WebApp, 'name' | 'icon'> }): ReactElement {
  const [broken, setBroken] = useState(false)
  return <span className="wa-icon" aria-hidden="true">{app.icon && !broken ? <img src={app.icon} alt="" onError={() => setBroken(true)} /> : app.name.slice(0, 1).toUpperCase()}</span>
}

/** `onCount` hears how many web apps there are (Workspace › Apps counts them in its header); `onEmpty` whether the group shows nothing. */
export function WebAppsBlock({ pins, onCount, onEmpty }: { pins: SidebarAppPin[]; onCount?(count: number): void; onEmpty?(empty: boolean): void }): ReactElement | null {
  const [apps, setApps] = useState<WebApp[] | null>(null)
  const [suggested, setSuggested] = useState<WebAppSuggestion[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const icons = useSiteIcons(suggested.map((s) => s.host))
  const empty = apps !== null && apps.length === 0 && suggested.length === 0
  useEffect(() => {
    if (apps) onCount?.(apps.length)
  }, [apps?.length])
  useEffect(() => {
    if (apps) onEmpty?.(empty)
  }, [apps === null, empty])

  const refreshSuggestions = (): void => void call('webApps', 'suggestions').then(setSuggested, () => setSuggested([]))
  useEffect(() => {
    call('webApps', 'list').then(setApps, () => setApps([]))
    refreshSuggestions()
  }, [])
  useAppEvent('web-apps', (e) => {
    setApps(e.items)
    refreshSuggestions()
  })

  const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })
  const open = (app: WebApp): void => void call('webApps', 'open', app.id).catch(fail)
  const menu = (app: WebApp) => async (e: MouseEvent): Promise<void> => {
    e.preventDefault()
    const id = await showContextMenu(e, [
      { id: 'open', label: t('platform.webApps.open') },
      { id: 'sep-sidebar', label: '', type: 'separator' },
      ...sidebarMenuItems(showOf({ ref: webAppRef(app.id), defaultShow: 'hidden' }, pins)),
      { id: 'sep-edit', label: '', type: 'separator' },
      { id: 'rename', label: t('platform.webApps.rename') },
      { id: 'sep', label: '', type: 'separator' },
      { id: 'remove', label: t('platform.webApps.remove'), danger: true },
    ])
    const show = chosenShow(id)
    if (show) setAppShow(pins, webAppRef(app.id), show)
    else if (id === 'open') open(app)
    else if (id === 'rename') setRenaming(app.id)
    else if (id === 'remove') {
      await call('webApps', 'remove', app.id).catch(fail)
      toast.show({ message: t('platform.webApps.removed', { name: app.name }) })
    }
  }
  const save = async (s: WebAppSuggestion): Promise<void> => {
    setSaving(s.url)
    try {
      const app = await call('webApps', 'saveUrl', s.url, s.title)
      toast.show({ message: t('platform.webApps.saved', { name: app.name }), tone: 'success' })
    } catch (err) {
      fail(err)
    } finally {
      setSaving(null)
    }
  }

  if (!apps || empty) return null
  return (
    <div className="wa">
      <h3 className="wa__title">{t('platform.webApps.title')}</h3>
      {apps.length > 0 && (
        <div className="wa__grid" role="list" aria-label={t('platform.webApps.title')}>
          {apps.map((app) => (
            <div role="listitem" key={app.id} className="wa__item">
              {renaming === app.id ? (
                <span className="pl-tile wa-tile">
                  <AppIcon app={app} />
                  <InlineRename
                    value={app.name}
                    label={t('platform.webApps.rename')}
                    editing
                    activation="none"
                    maxLength={60}
                    onEditingChange={(on) => !on && setRenaming(null)}
                    onCommit={(name) => call('webApps', 'rename', app.id, name).then(() => setRenaming(null))}
                  />
                </span>
              ) : (
                <button type="button" className="pl-tile wa-tile" onClick={() => open(app)} onContextMenu={(e) => void menu(app)(e)} aria-label={t('platform.webApps.openLabel', { name: app.name })}>
                  <AppIcon app={app} />
                  <span className="pl-tile__text">
                    <span className="pl-tile__name">
                      <span>{app.name}</span>
                    </span>
                    <span className="pl-tile__desc">{hostOf(app.url)}</span>
                  </span>
                  <SidebarMark show={showOf({ ref: webAppRef(app.id), defaultShow: 'hidden' }, pins)} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {suggested.length > 0 && (
        <>
          <h4 className="wa__sub">{t('platform.webApps.suggested')}</h4>
          <ul className="wa__suggest">
            {suggested.map((s) => (
              <li key={s.url} className="wa__suggestion">
                <AppIcon app={{ name: s.title, icon: icons[s.host] ?? null }} />
                <span className="wa__suggestion-text">
                  <strong>{s.title}</strong>
                  <span>{s.host.replace(/^www\./, '')}</span>
                </span>
                <Button size="sm" variant="secondary" icon={<Plus />} loading={saving === s.url} onClick={() => void save(s)}>
                  {t('platform.webApps.save')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
