/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { CompanionProfile } from '@shared/companion'
import type { SettingsView } from '@shared/ipc'
import { parseInternalUrl } from '@shared/url'
import type { WorkspaceSection } from '@shared/workspace'
import { FileQuestion } from 'lucide-react'
import { call } from '../api'
import { Button, EmptyState } from '../ui'
import { AllChatsPage } from './AllChats'
import { ChatPage } from './ChatPage'
import { BookmarksPage, DownloadsPage, HistoryPage } from './Collections'
import { ConnectorsPage } from './ConnectorsPage'
import { FirstWeekPage } from './FirstWeekPage'
import { RoutinesPage } from './RoutinesPage'
import { SettingsPage } from './Settings'
import { SkillsPage } from './SkillsPage'
import { WelcomePage } from './Welcome'
import { LogsPage } from '../diagnostics/LogsPage'
import WorkspacePage from './workspace/WorkspacePage'
import FlagsPage from './FlagsPage'
import GuidesPage from './GuidesPage'
import PresetsPage from './PresetsPage'
import { PasswordsPage } from './PasswordsPage'
import { MeetingsPage } from './MeetingsPage'
import { TweaksPage } from './TweaksPage' // TWK-05
import { PacksPage } from './PacksPage' // docs/packs.md
// The remaining apex:// pages; an address without one shows NotFound.
import { ViewSourcePage } from './ViewSourcePage'
import { FileViewerPage } from './FileViewerPage'
import { FilesPage } from './FilesPage'
import { GuidePageContext } from '../settings/kit'
import { useT } from '../i18n/useT' // ST-04

interface InternalPageProps {
  url: string
  tabId: string
  settings: SettingsView
  /** The active companion. */
  companion: CompanionProfile
  isMac: boolean
  onSettings(view: SettingsView): void
}

function NotFound(): ReactElement {
  const t = useT()
  return (
    <div className="page page--center">
      <EmptyState
        icon={<FileQuestion />}
        title={t('core.internalPage.thisApexPageDoesn')}
        description={t('core.internalPage.theAddressMayBe')}
        action={
          <Button variant="secondary" onClick={() => void call('pages', 'open', 'apex://chats')}>
            {t('core.internalPage.goToAllChats')}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Renders an apex:// page drawn by the chrome. apex://companion/... has no
 * page of its own: App floats the companion card over the content instead.
 * Library addresses never arrive here; main rewrites them to destinations.
 */
export function InternalPage(props: InternalPageProps): ReactElement {
  // ST-04: destination pages' headers link their guide; Settings narrows it to its own page.
  return (
    <GuidePageContext.Provider value={parseInternalUrl(props.url)?.page ?? null}>
      <InternalRoute {...props} />
    </GuidePageContext.Provider>
  )
}

function InternalRoute({ url, tabId, settings, companion, isMac, onSettings }: InternalPageProps): ReactElement {
  const route = parseInternalUrl(url)
  switch (route?.page) {
    case 'chats':
      return <AllChatsPage tabId={tabId} />
    case 'chat':
      return route.id ? <ChatPage key={route.id} chatId={route.id} tabId={tabId} /> : <NotFound />
    case 'routines':
      return <RoutinesPage tabId={tabId} itemId={route.id} url={url} />
    case 'skills':
      return <SkillsPage tabId={tabId} itemId={route.id} url={url} />
    case 'connectors':
      return <ConnectorsPage tabId={tabId} itemId={route.id} url={url} /* ?connect=<id> */ />
    case 'companion':
      return <div className="page page--backdrop" aria-hidden />
    case 'history':
      return <HistoryPage tabId={tabId} url={url} />
    case 'bookmarks':
      return <BookmarksPage tabId={tabId} />
    case 'downloads':
      return <DownloadsPage />
    case 'settings':
      return <SettingsPage section={route.section} settings={settings} companion={companion} onSettings={onSettings} tabId={tabId} url={url} />
    case 'welcome':
      return <WelcomePage tabId={tabId} companion={companion} settings={settings} onSettings={onSettings} isMac={isMac} />
    case 'first-week':
      return <FirstWeekPage tabId={tabId} section={route.section} />
    case 'logs':
      return <LogsPage tabId={tabId} />
    // Apex://workspace[/<section>[/<id>]]
    case 'workspace':
      return <WorkspacePage tabId={tabId} section={(route.section as WorkspaceSection | null) ?? null} itemId={route.id} url={url} />
    case 'flags':
      return <FlagsPage tabId={tabId} />
    case 'guides':
      return <GuidesPage tabId={tabId} guideId={route.id} />
    // ── presets route ── (apex://presets[/<id>])
    case 'presets':
      return <PresetsPage tabId={tabId} presetId={route.id} />
    case 'view-source':
      return <ViewSourcePage key={url} url={url} tabId={tabId} />
    case 'passwords':
      return <PasswordsPage tabId={tabId} url={url} />
    case 'meetings':
      return <MeetingsPage tabId={tabId} url={url} meetingId={route.id} />
    // ── tweaks route ── (TWK-05: apex://tweaks[?site=<host>])
    case 'tweaks':
      return <TweaksPage tabId={tabId} url={url} />
    // ── packs route ── (docs/packs.md: apex://packs[?pack=|?draft=|?tab=|?install=])
    case 'packs':
      return <PacksPage tabId={tabId} url={url} />
    // The viewer, and Library › Files
    case 'file':
      return <FileViewerPage url={url} tabId={tabId} />
    case 'library':
      return route.section === 'files' ? <FilesPage tabId={tabId} url={url} /> : <NotFound />
    default:
      return <NotFound />
  }
}
