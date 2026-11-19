/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contracts for the feature services the chrome calls through one generic
// channel (`atelier.invoke(service, method, ...args)`). Main validates every
// call against a schema in src/main/services.ts.
import type { SpendView } from './pricing'
import type { ChatFeedback, ChatListFilter, ChatSummary, ChatView, FeedbackRating, MessageDetails, NewChatOptions, QueuedMessage } from './chats'
import type { Companion, CompanionImportPreview, CompanionPreset, CompanionProfile } from './companion'
import type { EngineStatus } from './engine'
import type { ExtraEngineServices } from '@engines/shared'
import type { FirstWeekHideReason, FirstWeekView } from './firstWeek'
import type { Bounds, OrderEntry, SettingsView, WindowState } from './ipc'
import type { MenuItemSpec } from './menu'
import type { ThemeState } from './theme'
import type { DownloadDanger } from './downloads'
// Each feature's services and events
import type { AddressEvent, AddressServices, BookmarksServiceAdditions, FindServiceAdditions, PeekServiceAdditions } from './services/address'
import type { ChatEvent, ChatServices, ChatsServiceAdditions } from './services/chat'
import type { CoreEvent, CoreServices } from './services/core'
import type { DownloadsServiceAdditions, MenuEvent, MenuServices } from './services/menus'
import type { SettingsEvent, SettingsServices } from './services/settings'
import type { SiteEvent, SiteServices } from './services/sites'
import type { SplitServiceAdditions, TabEvent, TabServices, TabsServiceAdditions } from './services/tabs'
import type { DiagnosticsEvent, DiagnosticsServices } from './diagnostics'
import type { HapticsServices } from './haptics'
import type { MigrationsEvent, MigrationsServices } from './migrations'
import type { SystemEvent, SystemServices } from './system'
import type { UpdatesEvent, UpdatesServices } from './updates'
import type { AttachmentsEvent, AttachmentsServices } from './attachments'
import type { ChatContextEvent, ChatContextServices } from './chatContext'
import type { ChatDuplicatedEvent, ChatsCompactionMethods, MessageAttachmentInput } from './chats'
import type { ConnectorsServices } from './connectors'
import type { ConnectorInputV2, ConnectorV2 } from './connectors'
import type { ExtensionsEvent, ExtensionsServices } from './extensions'
import type { FilesEvent, FilesServices } from './files'
import type { ProfilesEvent, ProfilesServices } from './profiles'
// The voice, passwords and meetings contract files export their services and events
import type { AutofillServices } from './autofill'
import type { MeetingCaptureAppEvent, MeetingCaptureServices } from './meetingCapture'
import type { MeetingsAppEvent, MeetingsServices } from './meetings'
import type { PasswordsAppEvent, PasswordsServices } from './passwords'
import type { SpeechAppEvent, SpeechServices } from './speech'
import type { VoiceAppEvent, VoiceServices } from './voice'
// The agent tools, workspace, memory, skills, platform and first-run contract files export their services and events
import type { MemoryFeatureEvent, MemoryFeatureServices, MemoryJobsMethods } from './activity'
import type { AgentToolsAppEvent, AgentToolsServices, AgentToolsMethods, PrivateChatsMethods } from './agentTools'
import type { ChatToolsServices, ChatsProjectMethods } from './exportFormat'
import type { CompanionsSetupMethods, OnboardingMethods } from './onboarding'
import type { RoutinesEvent, RoutinesMethods } from './routines'
import type { PlatformEvent, PlatformServices } from './siteSuggestions'
import type { SkillsEvent, SkillsMethods } from './skills'
import type { WebAppsServices } from './webApps'
import type { FirstRunEvent, FirstRunServices } from './tips'
import type { UsageServices } from './usage'
import type { WorkspaceEvent, WorkspaceServices } from './workspace'
import type { MediaEvent, MediaServices } from './media' // media hub (MD-01)
import type { TweaksEvent, TweaksServices } from './tweaks' // tweaks (TWK-01)
import type { PacksEvent, PacksServices, PackStatusEvent } from './packs' // packs (docs/packs.md)
import type { DecisionsServices } from './decisions' // quick decisions (docs/decisions.md)
import type { PrivacyPackServices } from './privacyPack' // privacy pack (HTTPS-First, cookie banners)
import type { ReaderServices } from './reader' // reader (RD-01)
import type { TranslateServices } from './translate' // translate (TR-01)
import type { SystemPermissionsServices } from './systemPermissions' // this Mac's permissions

export type { Companion, CompanionImportPreview, CompanionPreset, CompanionProfile } from './companion'
export type { ChatFeedback, ChatListFilter, ChatSummary, ChatView, FeedbackRating, MessageDetails, NewChatOptions, QueuedMessage } from './chats'
export { SHARED_OWNER } from './chats'

export interface Bookmark {
  id: string
  url: string
  title: string
  createdAt: number
  /** The page's own favicon address, kept from its tab when saved (no favicon service is asked). */
  favicon?: string | null
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadInfo {
  id: string
  url: string
  filename: string
  path: string
  state: DownloadState
  receivedBytes: number
  totalBytes: number
  startedAt: number
  speedBps: number
  etaSeconds: number | null
  danger: DownloadDanger
  byAgent: boolean
  mime: string
  tabId: string | null
}

export interface HistoryItem {
  url: string
  title: string
  visits: number
  lastVisit: number
}

/** A companion id, or SHARED_OWNER ('shared') for items every companion uses. */
export type Owner = string

export interface Skill {
  id: string
  /** Invoked as /name in the composer. Lowercase letters, digits and dashes. Unique per owner. */
  name: string
  description: string
  instructions: string
  updatedAt: number
  owner: Owner
  /** Last time a chat expanded it; null if never. */
  lastUsedAt: number | null
}

/** Routine schedules (shared/routines.ts), plus the old hourly interval, which main migrates on load and on save. */
export type RoutineSchedule = import('./routines').RoutineSchedule | import('./routines').LegacyRoutineSchedule

export interface Routine {
  id: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  lastChatId: string | null
  lastStatus: 'ok' | 'error' | null
  /** The companion it runs as; a shared routine runs as the active companion. */
  owner: Owner
}

export interface MemoryFile {
  /** A /memories/... path inside the owner's folder. */
  path: string
  size: number
  modifiedAt: number
  owner: Owner
  /** Who last wrote it: the agent (memory tool) or you (an editor); null for notes from before Atelier kept track. */
  author: 'agent' | 'you' | null
}

/**
 * A connector is ConnectorV2 plus the original fields: `url` is the remote URL or
 * the local command line, and `hasToken` mirrors hasSecret. `owner`: chats of
 * this companion (or of every companion when shared) get the connector.
 */
export interface Connector extends ConnectorV2 {
  url: string
  hasToken: boolean
}

export interface ConnectorInput {
  id?: string
  name: string
  url: string
  /** undefined keeps the saved token, null removes it. */
  token?: string | null
  enabled: boolean
  /** Omitted keeps the saved owner; new connectors default to shared. */
  owner?: Owner
}

/** What `companion.set` accepts; omitted fields keep their saved value. */
export type CompanionPatch = Partial<Pick<CompanionProfile, 'name' | 'persona' | 'look' | 'dockIcon'>>

/** What `companions.update` accepts; omitted fields keep their saved value. */
export type CompanionUpdate = Partial<Pick<Companion, 'name' | 'persona' | 'look' | 'dockIcon' | 'instructions' | 'model' | 'effort' | 'engine'>>

/** A new companion: from a preset, or blank/shuffled with the look the chrome rolled. */
export interface NewCompanionInput {
  presetId?: string
  name?: string
  persona?: string
  look?: Companion['look']
  /** Default true: the new companion becomes the active one. */
  activate?: boolean
}

export interface CompanionExportOptions {
  includeSkills?: boolean
  includeRoutines?: boolean
  includeMemory?: boolean
  note?: string
  /** A PNG data URL rendered off-screen; saved beside the file as <name>.png. */
  shareImage?: string
}

/** One entry in a companion's Files tab (userData/companion-files/<id>/). */
export interface CompanionFileEntry {
  /** Relative to the companion's folder, '/'-separated, e.g. 'trips/kyoto.pdf'. */
  path: string
  name: string
  kind: 'file' | 'folder'
  size: number
  modifiedAt: number
  /** A type Atelier can read (text, Markdown, PDF, images); other files are view-only. */
  readable: boolean
}

export interface ImportSource {
  id: string
  name: string
  kind: 'chromium' | 'firefox'
}

export interface ImportResult {
  bookmarks: number
  history: number
}

export interface FindResult {
  matches: number
  active: number
}

export interface PeekState {
  open: boolean
  url: string
  title: string
  loading: boolean
}

/** One entry of a tab's back or forward list. */
export interface NavigationEntry {
  /** Pass to tabs.goToIndex. */
  index: number
  url: string
  title: string
}

export interface SplitState {
  primaryId: string
  secondaryId: string
}

/** Where native views go, measured by the chrome UI in window coordinates. */
export interface LayoutBounds {
  primary: Bounds
  secondary: Bounds | null
  peek: Bounds | null
  /** Corner radius of the page views in CSS px: 0 while the page is flush in the sheet, rounded while it is inset beside a chat. */
  radius?: number
}

export interface Services extends CoreServices, AddressServices, TabServices, SiteServices, MenuServices, ChatServices, SettingsServices, UpdatesServices, DiagnosticsServices, MigrationsServices, SystemServices, HapticsServices {
  /** This month's spend on your own key and your budget (DS-18); Atelier sells nothing. */
  spend: {
    view(): SpendView
  }
  bookmarks: BookmarksServiceAdditions & {
    list(): Bookmark[]
    toggle(url: string, title: string): boolean
    remove(id: string): void
    rename(id: string, title: string): void
  }
  downloads: DownloadsServiceAdditions & {
    list(): DownloadInfo[]
    open(id: string): void
    showInFolder(id: string): void
    cancel(id: string): void
    clear(): void
  }
  history: {
    search(query: string, limit: number): HistoryItem[]
    remove(url: string): void
    clear(): void
  }
  find: FindServiceAdditions & {
    start(text: string, forward: boolean, findNext: boolean): void
    stop(): void
  }
  chats: ChatsServiceAdditions & ChatsCompactionMethods & PrivateChatsMethods & ChatsProjectMethods & {
    /** Saved chats (never drafts), pinned first. */
    list(filter?: ChatListFilter): ChatSummary[]
    /** One chat to show: a draft or a saved chat. Throws "This chat no longer exists." for unknown ids. */
    get(id: string): ChatView
    /** A draft chat with an id, saved at its first message. */
    create(options?: NewChatOptions): ChatSummary
    /** Changes a draft's companion, model or effort. Started chats refuse: continue in a new chat. */
    configure(id: string, options: NewChatOptions): ChatSummary
    rename(id: string, title: string): ChatSummary
    pin(ids: string | string[]): void
    unpin(ids: string | string[]): void
    markRead(ids: string | string[]): void
    markUnread(ids: string | string[]): void
    markAllRead(): void
    archive(ids: string | string[]): void
    unarchive(ids: string | string[]): void
    /** Copies the saved history and event log into a new chat. */
    duplicate(id: string): ChatSummary
    /** Saves the chat as Markdown through a save dialog. Resolves to the path, or null when cancelled. */
    export(id: string): Promise<string | null>
    /** Deletes for good (the chrome confirms first). Stops a running chat. */
    remove(ids: string | string[]): void
    /** Cuts the chat back to a message you sent (a `user-message` event id) and sends `text` in its place. */
    editAndResend(id: string, userMessageId: string, text: string, /** CH-09 */ attachments?: MessageAttachmentInput[]): void
    /** Re-runs the reply with this turnId (default: the last reply) by resending the message before it. */
    retry(id: string, turnId?: string): void
    /** Rates a reply; null clears the rating. Stored locally, never sent to the model. */
    feedback(id: string, turnId: string, rating: FeedbackRating | null, note?: string): ChatFeedback | null
    details(id: string, turnId: string): MessageDetails | null
    /** Replaces a queued message's text, or drops it when `text` is null. */
    editQueued(id: string, queuedId: string, text: string | null): QueuedMessage[]
    /**
     * A surface (panel, chat page) reports which chat it shows; null when it stops.
     * Shown chats are marked read, and a run that ends while shown stays read.
     */
    setViewing(surface: string, chatId: string | null): void
    /** Tab id to the id of the chat controlling it. */
    tabOwners(): Record<string, string>
  }
  skills: SkillsMethods & {
    /** Every skill with its owner, built-ins included; the composer shows the companion's own first, then shared, then built-in. */
    list(filter?: import('./skills').SkillFilter): import('./skills').Skill[]
    save(skill: import('./skills').SkillSaveInput): import('./skills').Skill
    /** Moves it to Recently Deleted; built-in skills are refused. */
    remove(id: string): void
    /** Saves a skill as Markdown (name and description in front matter, instructions as the body) through a save dialog; a skill with supporting files is copied as a folder. Resolves to the path, or null when cancelled. */
    exportFile(id: string): Promise<string | null>
    /** Picks a skill file (.md) and adds it for `owner` (default shared). Null when cancelled; throws a readable error for a bad file or a name already taken. */
    importFile(owner?: Owner): Promise<import('./skills').Skill | null>
  }
  routines: RoutinesMethods & {
    list(filter?: import('./routines').RoutineFilter): import('./routines').Routine[]
    /** A stale `revision` throws 'changed-elsewhere'. */
    save(routine: import('./routines').RoutineSaveInput): import('./routines').Routine
    /** It won't run again; chats from earlier runs and its run records stay. */
    remove(id: string): void
    runNow(id: string): void
  }
  memory: MemoryJobsMethods & {
    /** `owner` defaults to shared. A companion's folder never holds /memories/shared (that path is the shared folder for the agent). */
    list(owner?: Owner): MemoryFile[]
    read(path: string, owner?: Owner): string
    write(path: string, text: string, owner?: Owner): void
    remove(path: string, owner?: Owner): void
  }
  connectors: ConnectorsServices['connectors'] & {
    list(): Connector[]
    /** The original remote-only input still works; ConnectorInputV2 carries every transport. */
    save(input: ConnectorInput | ConnectorInputV2): Connector
    remove(id: string): void
  }
  /** The active companion, for surfaces that show only one. */
  companion: {
    get(): Companion
    set(patch: CompanionPatch): Companion
    /** The preset companions from the generated presets.json. */
    presets(): CompanionPreset[]
    /** macOS: shows a rendered PNG as the Dock icon while the active companion's dockIcon is on. Returns whether it was applied. */
    setDockIcon(pngDataUrl: string): boolean
  }
  companions: CompanionsSetupMethods & {
    /** Every companion, hidden ones included, in creation order. */
    list(): Companion[]
    activeId(): string
    get(id: string): Companion
    setActive(id: string): Companion
    update(id: string, patch: CompanionUpdate): Companion
    create(input: NewCompanionInput): Companion
    /** Copies the look, instructions, model defaults, own skills and memory folder. */
    duplicate(id: string): Companion
    hide(id: string): void
    unhide(id: string): void
    /** Back to the name, persona and look it was created with; clears instructions and model defaults. */
    reset(id: string): Companion
    /** Refuses the last visible companion. Its chats stay (shown with a neutral avatar); its own skills, routines, connectors and memory go. */
    remove(id: string): void
    /** Saves a .ateliercompanion file through a save dialog. Resolves to the path, or null when cancelled. */
    export(id: string, options?: CompanionExportOptions): Promise<string | null>
    /** Opens a file dialog, then validates the file. Null when cancelled; throws a readable error for bad files. */
    pickImport(): Promise<CompanionImportPreview | null>
    /** Validates file contents (for example from a drop on the window). */
    previewImport(text: string): CompanionImportPreview
    /** Adds the previewed companion as a new one. Never overwrites. */
    confirmImport(token: string): Companion
  }
  /** A companion's own folder of files, for its card's Files tab. Paths are relative to the folder ('' is the folder itself). */
  companionFiles: {
    /** One folder's entries, folders first. A folder that doesn't exist yet is empty. */
    list(companionId: string, folder: string): CompanionFileEntry[]
    /** Saves a dropped file (base64 contents, at most 25 MB) into `folder`; a name already there gets a number. */
    add(companionId: string, folder: string, name: string, base64: string): CompanionFileEntry
    /** Opens a file in its default app. */
    open(companionId: string, path: string): Promise<void>
    /** Shows a file, or the companion's folder for '', in Finder. */
    reveal(companionId: string, path: string): void
    /** Moves a file or subfolder to the Trash. */
    remove(companionId: string, path: string): Promise<void>
  }
  importer: {
    sources(): ImportSource[]
    run(sourceId: string): ImportResult
  }
  peek: PeekServiceAdditions & {
    open(url: string): void
    close(): void
    promote(): void
  }
  split: SplitServiceAdditions & {
    open(): void
    close(): void
    swap(): void
    /** Shows `tabId` next to `partnerId` (⌥-click, the tab menu's split submenu). */
    openWith(tabId: string, partnerId: string): void
  }
  pages: {
    /**
     * Opens an atelier:// page. By default it reuses the tab that shows that page
     * (the same chat for chat/<id>) and rewrites aliases (library sections,
     * bare atelier://settings). `newTab` always opens a new tab; `background` keeps the current one active.
     */
    open(url: string, options?: { newTab?: boolean; background?: boolean }): void
    /** A small downscaled JPEG data URL of what the tab shows (its page, or the chrome's own content area for atelier:// pages); null if nothing can be captured. */
    snapshot(tabId: string): Promise<string | null>
  }
  /** Native menus. The chrome wraps this as showMenu(items, anchor). */
  menu: {
    /** Pops a native menu at (x, y) in the chrome's CSS pixels; resolves to the clicked item's id, or null when dismissed. */
    popup(items: MenuItemSpec[], x: number, y: number): Promise<string | null>
  }
  tabs: TabsServiceAdditions & {
    /** The sidebar's (or strip's) visible order, used by ⌘1–8, ⌘9, ⌥⌘→/← and ⇧⌘]/[. Report it whenever it changes. */
    setOrder(entries: OrderEntry[]): void
    /** Moves a tab within main's manual order; it stays inside its pinned or unpinned block. */
    move(tabId: string, index: number): void
    setPinned(tabId: string, pinned: boolean): void
    setMuted(tabId: string, muted: boolean): void
    duplicate(tabId: string): void
    /** Bulk close (close others, below, all): pinned tabs are skipped. Returns how many closed. */
    closeMany(tabIds: string[]): number
    /** The sidebar's Clear: closes every unpinned tab in this window. Null when there was none; the id undoes it. */
    clearTabs(): { id: string; closed: number } | null
    /** Undo for clearTabs: brings those tabs back in place. Returns how many came back. */
    undoClearTabs(id: string): number
    /** ⇧⌘T. Returns false when nothing is left to reopen. */
    reopenClosed(): boolean
    /** The back or forward list for long-press menus, nearest first. */
    history(tabId: string, direction: 'back' | 'forward'): NavigationEntry[]
    goToIndex(tabId: string, index: number): void
  }
  window: {
    state(): WindowState
    /** Saved per window; the ⌘S menu item flips the same state. */
    setSidebarOpen(open: boolean): void
    /** A custom window name (null follows the active tab's title). */
    setName(name: string | null): void
    /**
     * macOS: where the traffic lights sit, in the chrome's CSS pixels (top-left of the first button); null restores the default.
     * Returns the position AppKit took (getWindowButtonPosition, in CSS px), or null off macOS (DS-05).
     */
    setButtonPosition(position: { x: number; y: number } | null): { x: number; y: number } | null
    /** macOS: the traffic lights hide while the sidebar is collapsed (they travel with it). */
    setButtonsVisible(visible: boolean): void
    /** DS-14: the pointer entered the sidebar (its rect, in the chrome's CSS px) or left it (null); main watches for a missed leave. */
    trackSidebarPointer(rect: { x: number; y: number; width: number; height: number } | null): void
    close(): void
  }
  theme: {
    state(): ThemeState
  }
  onboarding: OnboardingMethods & {
    /** Setup finished: creates the getting-started plan and opens it once as a tab. */
    complete(): void
  }
  /** The getting-started plan (atelier://first-week). Every change returns the new view and also arrives as a 'first-week' event. */
  firstWeek: {
    /** The page's state; reruns the import and default-browser checks. */
    view(): FirstWeekView
    /** Marks a starter chat done (opening one does this) or not done. */
    setDone(itemId: string, done: boolean): FirstWeekView
    dismiss(itemId: string): FirstWeekView
    restore(itemId: string): FirstWeekView
    /** Clears every remaining card; refused until 30 days after setup. */
    dismissAll(): FirstWeekView
    /** Hides the plan until 9:00 tomorrow, local time. */
    snooze(): FirstWeekView
    unsnooze(): FirstWeekView
    /** Switches the plan off, recording why. */
    hide(reason: FirstWeekHideReason, note?: string): FirstWeekView
    show(): FirstWeekView
    /** The notice about a reset file has been seen. */
    acknowledge(): FirstWeekView
    /** Asks the system to make Atelier the default browser (macOS confirms), then rechecks. */
    makeDefaultBrowser(): FirstWeekView
  }
  /**
   * ST-58 to ST-60: what powers the companions. The engine choice and the
   * outside-access switch are settings (engine, externalAccess,
   * externalTabs); this service reports their live status. Changes also
   * arrive as 'engine' events. Engines a build adds bring their own
   * namespaces (ExtraEngineServices).
   */
  engine: {
    /** Where every engine stands; an engine's first look-up starts in the background when none has run. */
    status(): EngineStatus
    /** ST-60: copies the command that adds Atelier to Claude Code, secret included, to the clipboard. */
    copyCommand(): Promise<void>
    /** ST-60: runs that command for you (Claude Code must be on this computer). */
    addToClaudeCode(): Promise<{ ok: boolean; message: string }>
    /** ST-60: revokes access by making a new secret; the old command stops working at once. */
    revoke(): EngineStatus
  }
}

// The service namespaces of the engines a build adds (src/shared/engine.ts).
export interface Services extends ExtraEngineServices {}

// Speech, transcription, passwords, wallet, autofill, voice, meetings, meetingCapture; the old speech.state/start/stop is replaced
export interface Services extends SpeechServices, PasswordsServices, AutofillServices, VoiceServices, MeetingsServices, MeetingCaptureServices {}
/** WA-01: websites saved as apps. */
export interface Services extends WebAppsServices {}
// Declaration merging adds the attachments, files, extensions and profiles namespaces without touching the list above
export interface Services extends AttachmentsServices, ChatContextServices, FilesServices, ExtensionsServices, ProfilesServices {}
// Declaration merging adds the agent, usage, memory, workspace, platform and setup namespaces; their methods on existing namespaces are joined inline above
export interface Services extends AgentToolsServices, UsageServices, ChatToolsServices, MemoryFeatureServices, WorkspaceServices, PlatformServices, FirstRunServices {
  /** The request protocol, approval mode and prompt viewer, added to the agent namespace. */
  agent: ChatServices['agent'] & AgentToolsMethods
}

// ── media hub services ── (MD-01: the now-playing control, speed and picture-in-picture)
export interface Services extends MediaServices {}
// ── tweaks services ── (TWK-01: per-site hidden elements, style, CSS and scripts)
export interface Services extends TweaksServices {}
// ── privacy pack services ── (HTTPS-First exceptions, cookie-banner lists and the site info summary; src/main/privacy)
export interface Services extends PrivacyPackServices {}
// ── reader services ── (RD-01: the reader view of an article page)
export interface Services extends ReaderServices {}
// ── translate services ── (TR-01: translate a page, show the original, always and never)
export interface Services extends TranslateServices {}
// ── system permissions services ── (Settings › Privacy › Permissions: this Mac's permissions, read and asked for)
export interface Services extends SystemPermissionsServices {}
// ── packs services ── (docs/packs.md: install, review, export, remix, drafts, indexes and updates)
export interface Services extends PacksServices {}
// ── quick decisions services ── (docs/decisions.md: the decision model's status, keys, test and comparisons)
export interface Services extends DecisionsServices {}

export type ServiceName = keyof Services
export type MethodName<S extends ServiceName> = keyof Services[S] & string
type Fn<S extends ServiceName, M extends MethodName<S>> = Services[S][M] extends (...args: infer A) => infer R ? (...args: A) => R : never
export type ServiceArgs<S extends ServiceName, M extends MethodName<S>> = Parameters<Fn<S, M>>
export type ServiceResult<S extends ServiceName, M extends MethodName<S>> = ReturnType<Fn<S, M>>

export type AppEvent =
  | CoreEvent
  | AddressEvent
  | TabEvent
  | SiteEvent
  | MenuEvent
  | ChatEvent
  | SettingsEvent
  | UpdatesEvent
  | DiagnosticsEvent
  | MigrationsEvent
  | SystemEvent
  // These replace the old 'speech' and 'speech-state'
  | SpeechAppEvent
  | PasswordsAppEvent
  | VoiceAppEvent
  | MeetingsAppEvent
  | MeetingCaptureAppEvent
  | AttachmentsEvent
  | ChatContextEvent
  | FilesEvent
  | ExtensionsEvent
  | ProfilesEvent
  | ChatDuplicatedEvent
  | AgentToolsAppEvent
  | SkillsEvent
  | RoutinesEvent
  | MemoryFeatureEvent
  | WorkspaceEvent
  | PlatformEvent
  | FirstRunEvent
  | MediaEvent // media hub (MD-01)
  | TweaksEvent // tweaks (TWK-01)
  | PacksEvent // packs (docs/packs.md)
  | PackStatusEvent // an app's status on its sidebar row (docs/apps.md)
  | { type: 'downloads'; items: DownloadInfo[] }
  | { type: 'find'; result: FindResult }
  | { type: 'peek'; state: PeekState }
  | { type: 'split'; state: SplitState | null }
  | { type: 'bookmarks'; items: Bookmark[] }
  | { type: 'chats'; items: ChatSummary[] }
  | { type: 'chat-queue'; chatId: string; queued: QueuedMessage[] }
  | { type: 'chat-tabs'; owners: Record<string, string> }
  | { type: 'skills'; items: import('./skills').Skill[] } // skill records
  | { type: 'web-apps'; items: import('./webApps').WebApp[] } // WA-01: websites saved as apps
  | { type: 'connectors'; items: Connector[] }
  | { type: 'memory'; owner: Owner }
  | { type: 'routines'; items: import('./routines').Routine[] } // routine records
  | { type: 'companion'; profile: Companion }
  | { type: 'companions'; items: Companion[]; activeId: string }
  /** The OS opened a .ateliercompanion file (double-click): show the review sheet, or the error. */
  | { type: 'companion-import'; preview: CompanionImportPreview }
  | { type: 'companion-import-error'; message: string }
  /** A companion's Files folder changed through Atelier. */
  | { type: 'companion-files'; companionId: string }
  | { type: 'settings'; view: SettingsView }
  | { type: 'theme'; theme: ThemeState }
  | { type: 'window'; state: WindowState }
  /** DS-14: main saw the pointer leave the sidebar (into a page view, an overlay or out of the window). */
  | { type: 'sidebar-pointer'; inside: boolean }
  | { type: 'first-week'; view: FirstWeekView }
  /** Engine status changed: an engine's look-up finished or its sign-in or limit changed, outside access. */
  | { type: 'engine'; status: EngineStatus }
  | { type: 'spend'; view: SpendView }
  /** Reload on a tab the chrome draws (an atelier:// page or the new tab): remount that tab's page. */
  | { type: 'reload-page'; tabId: string }
