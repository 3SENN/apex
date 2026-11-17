/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The site actions in the toolbar's contextual cluster (DS-24, part of
// SH-32, OV-23):
// - on an agent-built app's tab, a thin label naming the app and the
//   companion that made it;
// - "Open in <app>" when an installed desktop app can open this page;
// - a suggestion button when site suggestions (opt-in) have an offer here,
//   opening the `site-suggestion` popover.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { AppWindow, Lightbulb } from 'lucide-react'
import { appIdOf, type AppSummary } from '@shared/apps'
import type { TabInfo } from '@shared/ipc'
import { call, errorText } from '../api'
import { AppGlyph } from '../apps/AppGlyph'
import { t } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { useCompanions } from '../settings/data'
import { IconButton, toast } from '../ui'
import { goWorkspace } from '../workspace/open'
import { useSiteSuggestion } from './suggestionData'
import '../apps/platform.css'

export function SiteActions({ tab, website }: { tab: TabInfo | null; website: boolean }): ReactElement | null {
  const url = tab?.url ?? ''
  const appId = tab ? appIdOf(url) : null
  if (appId) return <AppTabLabel appId={appId} />
  if (!tab || !website) return null
  return (
    <>
      <OpenInAppChip tabId={tab.id} url={url} />
      <SuggestionButton tabId={tab.id} />
    </>
  )
}

/** The installed desktop app for this page, re-checked when the page changes. */
function OpenInAppChip({ tabId, url }: { tabId: string; url: string }): ReactElement | null {
  const [link, setLink] = useState<{ app: string } | null>(null)
  useEffect(() => {
    let live = true
    setLink(null)
    Promise.resolve(call('siteSuggestions', 'appLink', tabId))
      .then((l) => {
        if (live) setLink(l)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [tabId, url])
  if (!link) return null
  const open = async (): Promise<void> => {
    try {
      if (!(await call('siteSuggestions', 'openInApp', tabId))) toast.show({ message: t('platform.applink.notInstalled', { app: link.app }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  return (
    <button type="button" className="pl-chip" onClick={() => void open()} aria-label={t('platform.applink.open', { app: link.app })} title={t('platform.applink.tooltip', { app: link.app })}>
      <AppWindow aria-hidden />
      <span>{t('platform.applink.open', { app: link.app })}</span>
    </button>
  )
}

function SuggestionButton({ tabId }: { tabId: string }): ReactElement | null {
  const suggestion = useSiteSuggestion(tabId)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!suggestion) return null
  const show = async (): Promise<void> => {
    const el = button.current
    if (!el || open) return
    setOpen(true)
    try {
      await openSurface('site-suggestion', anchorFromElement(el), { tabId, chatId: null })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setOpen(false)
    }
  }
  return (
    <IconButton
      ref={button}
      className="pl-suggest-btn"
      label={t('platform.suggestion.button', { name: suggestion.name ?? suggestion.app ?? '' })}
      aria-haspopup="dialog"
      aria-expanded={open}
      pressed={open}
      icon={<Lightbulb />}
      badge={<span className="pl-suggest-btn__dot" aria-hidden />}
      onClick={() => void show()}
    />
  )
}

/** The thin strip for an agent-built app's tab: which app, and which companion made it. */
function AppTabLabel({ appId }: { appId: string }): ReactElement | null {
  const [app, setApp] = useState<AppSummary | null>(null)
  const companions = useCompanions()
  useEffect(() => {
    let live = true
    Promise.resolve(call('apps', 'get', appId))
      .then((a) => {
        if (live) setApp(a)
      })
      .catch(() => {
        if (live) setApp(null)
      })
    return () => {
      live = false
    }
  }, [appId])
  if (!app) return null
  const maker = app.createdBy === 'shared' ? null : (companions.items?.find((c) => c.id === app.createdBy)?.name ?? null)
  return (
    <button type="button" className="pl-chip" onClick={() => goWorkspace('apps', app.id)} title={t('platform.apps.tabStripHint')}>
      <AppGlyph id={app.id} name={app.name} size="sm" />
      <span>{maker ? t('platform.apps.tabStrip', { name: app.name, companion: maker }) : app.name}</span>
    </button>
  )
}
