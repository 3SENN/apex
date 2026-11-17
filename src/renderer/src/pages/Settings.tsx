/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier://settings/<page>: a grouped nav and one page at a time. The nav
// collapses to an icon rail when the content card is narrow.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import type { CompanionProfile } from '@shared/companion'
import { atelier, call, errorText } from '../api'
import { GuidePageContext, Notice } from '../settings/kit'
import { useLocalPreference } from '../settings/data'
import { clampNavWidth, NAV_RAIL_BELOW, NAV_WIDTH, navMode, resolveSettingsSection, settingsNav, settingsQuery, type NavEntry } from '../settings/logic/nav'
import { useSettingsHighlight } from '../settings/useHighlight'
import { SettingsNav } from '../settings/SettingsNav'
import { useLanguageVersion, useT } from '../i18n/useT'
import { ModelPage, PermissionsPage } from '../settings/pages/AgentPages'
import { AppearancePage } from '../settings/pages/AppearancePage'
import { SearchPage } from '../settings/pages/SearchPage'
import { PrivacyPage } from '../settings/pages/PrivacyPage'
import { CompanionsPage } from '../settings/pages/CompanionsPage'
import { DefaultBrowserPage } from '../settings/pages/DefaultBrowserPage'
import { DockIconPage } from '../settings/pages/DockIconPage'
import { GeneralPage } from '../settings/pages/GeneralPage'
import { ImportSection } from '../settings/pages/ImportPage'
// ST-37 to ST-39
import { ProfilesPage } from '../settings/pages/ProfilesPage'
// ST-40
import { ExtensionsPage } from '../settings/pages/ExtensionsPage'
import { LanguagesPage } from '../settings/pages/LanguagesPage'
import { MemoryPage } from '../settings/pages/MemoryPage'
import { NotificationsPage } from '../settings/pages/NotificationsPage'
import { StoragePage } from '../settings/pages/StoragePage'
import { YouPage } from '../settings/pages/YouPage'
import ActivityMemoryPage from '../settings/pages/ActivityMemoryPage'
import { VoicePage } from '../settings/pages/VoicePage'
import { TranscriptionPage } from '../settings/pages/TranscriptionPage'
import { QuickDecisionsPage } from '../settings/agent/QuickDecisions' // docs/decisions.md
import { PasswordsSettingsPage } from '../settings/pages/PasswordsSettingsPage'
import { DownloadSettingsPage } from '../settings/pages/DownloadSettingsPage'
import { AboutPage } from '../settings/pages/AboutPage'
import '../settings/settings.css'
import '../settings/settingsPages.css'

// The welcome flow embeds the import list.
export { ImportSection } from '../settings/pages/ImportPage'

export interface SettingsPageProps {
  section: string | null
  settings: SettingsView
  /** The active companion. */
  companion: CompanionProfile
  onSettings(view: SettingsView): void
  /** The tab showing this page; nav clicks and address rewrites stay in it. */
  tabId?: string
  /** The full address, for its query (?highlight=, ?browser=, ?clear=1). */
  url?: string
}

const NAV_WIDTH_KEY = 'atelier.settings.navWidth'

/** The expanded nav's width, remembered per viewer; storage can be missing or blocked. */
function useNavWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      return clampNavWidth(localStorage.getItem(NAV_WIDTH_KEY))
    } catch {
      return NAV_WIDTH.default
    }
  })
  const save = (next: number): void => {
    setWidth(next)
    try {
      localStorage.setItem(NAV_WIDTH_KEY, String(next))
    } catch {
      // Not remembered; the width still applies.
    }
  }
  return [width, save]
}

export function SettingsPage({ section, settings, companion, onSettings, tabId, url }: SettingsPageProps): ReactElement {
  // Other platforms' rows are hidden, not greyed out (ST-01); titles follow the app language.
  const t = useT()
  const language = useLanguageVersion()
  const navGroups = useMemo(() => settingsNav(undefined, atelier.platform), [language])
  const resolved = resolveSettingsSection(section, undefined, atelier.platform)
  const query = settingsQuery(url)
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const [collapsed, setCollapsed] = useLocalPreference<'yes' | 'no'>('atelier.settings.navCollapsed', 'no', ['yes', 'no'])
  const [navWidth, setNavWidth] = useNavWidth()
  const [peeking, setPeeking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mode = navMode(width, collapsed === 'yes', peeking)
  useSettingsHighlight(main, query.highlight, `${resolved.page}/${resolved.view ?? ''}`)

  // The nav's shape follows the content card's width, measured before paint.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Widening the card past the rail breakpoint drops a floating nav.
  useEffect(() => {
    if (width >= NAV_RAIL_BELOW) setPeeking(false)
  }, [width >= NAV_RAIL_BELOW])

  // Unknown and not-yet-built pages land on the default one; the address follows so the breadcrumb agrees.
  useEffect(() => {
    if (resolved.redirect) go(`atelier://settings/${resolved.redirect}${query.raw ? `?${query.raw}` : ''}`)
  }, [resolved.redirect, section])

  // A new page starts at the top.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 })
    setError(null)
  }, [resolved.page, resolved.view])

  function go(url: string): void {
    if (tabId) void atelier.nav.go(tabId, url)
    else void call('pages', 'open', url)
  }
  const openSection = (id: string): void => go(`atelier://settings/${id}`)
  const openEntry = (entry: NavEntry): void => {
    setPeeking(false)
    if (entry.kind === 'link') void call('pages', 'open', entry.url)
    else openSection(entry.id)
  }
  // Pages may await the save (async buttons); failures still show inline.
  const update = (patch: SettingsPatch): Promise<void> => {
    setError(null)
    return atelier.settings.set(patch).then(
      (view) => void onSettings(view),
      (err: unknown) => setError(errorText(err)),
    )
  }

  const navProps = { groups: navGroups, current: resolved.page, onOpen: openEntry, onDismiss: () => setPeeking(false) }
  return (
    <div ref={root} className="sp-page">
      <SettingsNav
        {...navProps}
        mode={mode === 'overlay' ? 'rail' : mode}
        width={navWidth}
        onResize={setNavWidth}
        onToggle={() => (width < NAV_RAIL_BELOW ? setPeeking(true) : setCollapsed(collapsed === 'yes' ? 'no' : 'yes'))}
      />
      {mode === 'overlay' && <SettingsNav {...navProps} mode="overlay" onToggle={() => setPeeking(false)} />}
      <main ref={main} className="sp-main" aria-label={t('settings.settings.settingsPage')}>
        {/* ST-04: the page id picks the guide its header links to. */}
        <GuidePageContext.Provider value={resolved.page}>
        <div className="sp-content">
          {error && (
            <Notice tone="error" onDismiss={() => setError(null)}>
              {t('settings.settings.couldnTSaveThat', { error })}
            </Notice>
          )}
          {resolved.page === 'you' && <YouPage settings={settings} onSettings={onSettings} onOpenPage={openSection} />}
          {resolved.page === 'companions' && <CompanionsPage view={resolved.view} onOpenSection={openSection} />}
          {resolved.page === 'model' && <ModelPage settings={settings} update={update} onSettings={onSettings} onOpenSection={openSection} />}
          {/* docs/decisions.md */}
          {resolved.page === 'decisions' && <QuickDecisionsPage settings={settings} update={update} onOpenSection={openSection} />}
          {resolved.page === 'permissions' && <PermissionsPage settings={settings} update={update} />}
          {resolved.page === 'appearance' && <AppearancePage settings={settings} update={update} tabId={tabId ?? ''} companionName={companion.name} companionAccent={companion.look.colors.accent} />}
          {resolved.page === 'search' && <SearchPage settings={settings} update={update} />}
          {resolved.page === 'privacy' && <PrivacyPage settings={settings} update={update} tabId={tabId ?? ''} view={resolved.view} openClear={query.clear} onOpenSection={openSection} />}
          {resolved.page === 'import' && <ImportSection browser={query.browser} />}
          {/* ST-09, ST-22, ST-32 to ST-34, ST-53 to ST-55 */}
          {resolved.page === 'dock-icon' && <DockIconPage settings={settings} update={update} />}
          {resolved.page === 'general' && <GeneralPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {resolved.page === 'languages' && <LanguagesPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {resolved.page === 'default-browser' && <DefaultBrowserPage />}
          {resolved.page === 'notifications' && <NotificationsPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {resolved.page === 'storage' && <StoragePage />}
          {resolved.page === 'memory' && <MemoryPage settings={settings} onOpenModel={() => openSection('model')} />}
          {/* ST-14 to ST-16 */}
          {resolved.page === 'voice' && <VoicePage settings={settings} update={update} onOpenSection={openSection} />}
          {/* ST-17 to ST-21 */}
          {resolved.page === 'transcription' && <TranscriptionPage settings={settings} update={update} />}
          {/* ST-41 to ST-44 */}
          {resolved.page === 'passwords' && <PasswordsSettingsPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {/* ST-45 */}
          {resolved.page === 'downloads' && <DownloadSettingsPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {resolved.page === 'activity' && <ActivityMemoryPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {/* ST-37 to ST-39 */}
          {resolved.page === 'profiles' && <ProfilesPage settings={settings} onOpenPage={openSection} autoCreate={query.create === true} />}
          {/* ST-40 */}
          {resolved.page === 'extensions' && <ExtensionsPage settings={settings} update={update} tabId={tabId ?? ''} />}
          {/* ST-56 */}
          {resolved.page === 'about' && <AboutPage settings={settings} update={update} />}
        </div>
        </GuidePageContext.Provider>
      </main>
    </div>
  )
}
