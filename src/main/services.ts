/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { UI } from '@shared/ipc'
import type { MenuItemSpec } from '@shared/menu'
import type { ServiceName, Services } from '@shared/services'
import { COMPANION_INSTRUCTIONS_MAX, COMPANION_NAME_MAX } from '@shared/companion'
import { ENGINES } from '@shared/engine'
import { EXTRA_SERVICE_SCHEMAS } from '@internal/engines/main'
import { CHAT_TITLE_MAX } from './chats'
import { DOCK_ICON_MAX, DOCK_ICON_PREFIX, PERSONA_ID, lookSchema } from './companion'
import { COMPANION_FILE_MAX_BYTES, COMPANION_ID, EFFORTS } from './companions'
import { FOLDER_FILE_MAX_BYTES } from './companionFiles'
import { ITEM_ID } from './firstWeek'
import { HIDE_NOTE_MAX, HIDE_REASONS } from '@shared/firstWeek'
import { isTrustedUiSender } from './ipc'
import { MODELS } from './settings'
// One map per feature area
import { ADDRESS_SCHEMAS, BOOKMARKS_SCHEMA_ADDITIONS, FIND_SCHEMA_ADDITIONS, PEEK_SCHEMA_ADDITIONS } from './schemas/address'
import { CHAT_SCHEMAS, CHATS_SCHEMA_ADDITIONS } from './schemas/chat'
import { CORE_SCHEMAS } from './schemas/core'
import { DOWNLOADS_SCHEMA_ADDITIONS, MENU_SCHEMAS } from './schemas/menus'
import { SETTINGS_SCHEMAS } from './schemas/settings'
import { SITE_SCHEMAS } from './schemas/sites'
import { SPLIT_SCHEMA_ADDITIONS, TAB_SCHEMAS, TABS_SCHEMA_ADDITIONS } from './schemas/tabs'
import { DIAGNOSTICS_SCHEMAS } from './diagnostics/schemas'
import { MIGRATIONS_SCHEMAS } from './migrations/schemas'
import { NATIVE_SCHEMAS } from './native/schemas'
import { SYSTEM_SCHEMAS } from './system/schemas'
import { UPDATES_SCHEMAS } from './updates/schemas'
import { CHATS_COMPACTION_SCHEMAS, editAndResendArgs } from './agent/richChatSchemas'
import { CONNECTORS_SCHEMAS, CONNECTORS_SAVE_SCHEMA } from './connectors/schemas'
import { EXTENSIONS_SCHEMAS } from './extensions/schemas'
import { FILES_SCHEMAS } from './files/schemas'
import { INTAKE_SCHEMAS } from './intake/schemas'
import { PROFILES_SCHEMAS } from './profiles/schemas'
import { WEB_APPS_SCHEMAS } from './webAppsSchemas'
// One map per domain
import { AUTOFILL_SCHEMAS } from './autofill/schemas'
import { MEETING_CAPTURE_SCHEMAS } from './meetings/capture/schemas'
import { MEETINGS_SCHEMAS } from './meetings/schemas'
import { PASSWORDS_SCHEMAS } from './passwords/schemas'
import { SPEECH_SCHEMAS } from './speech/schemas'
import { VOICE_SCHEMAS } from './voice/schemas'
// One map per feature; methods on existing namespaces are merged into them below
import { MEMORY_JOBS_SCHEMAS, MEMORY_UPKEEP_SCHEMAS } from './activity/schemas'
import { AGENT_TOOLS_SCHEMAS, AGENT_TOOLS_METHOD_SCHEMAS, PRIVATE_CHATS_SCHEMAS } from './agent/agentToolsSchemas'
import { PLATFORM_SCHEMAS } from './apps/schemas'
import { CHAT_TOOLS_SCHEMAS, CHATS_PROJECT_SCHEMAS } from './chatFeatures'
import { COMPANIONS_SETUP_SCHEMAS, FIRST_RUN_SCHEMAS, ONBOARDING_SCHEMAS } from './guides/schemas'
import { ROUTINES_SCHEMAS, SKILLS_SCHEMAS } from './routines/schemas'
import { WORKSPACE_SCHEMAS } from './workspace/schemas'
import { idSchema } from './schemas/types'
import { MEDIA_SCHEMAS } from './media/report' // media hub (MD-01)
import { TWEAKS_SCHEMAS } from './tweaks/schemas' // tweaks (TWK-01)
import { PACKS_SCHEMAS } from './packs/schemas' // packs (docs/packs.md)
import { DECISIONS_SCHEMAS } from './decisions/schemas' // quick decisions (docs/decisions.md)
import { READER_SCHEMAS } from './reader/schemas' // reader (RD-01)
import { PRIVACY_PACK_SCHEMAS } from './privacy/schemas' // privacy pack
import { TRANSLATE_SCHEMAS } from './translate/schemas' // translate (TR-01)
import { SYSTEM_PERMISSIONS_SCHEMAS } from './systemPermissions' // this Mac's permissions

// One invoke channel for the chrome's feature services. Every method has an
// argument schema; calls from anything but the chrome's main frame, unknown
// methods and malformed arguments are rejected before the implementation runs.

const id = z.string().min(1).max(128)
const url = z.string().min(1).max(8192)
const text = (max: number) => z.string().max(max)
const tabId = z.string().min(1).max(64)
const point = z.number().finite().min(-10_000).max(100_000)
const menuItem: z.ZodType<MenuItemSpec> = z.lazy(() =>
  z.object({
    id: z.string().max(128),
    label: z.string().max(200),
    type: z.enum(['normal', 'checkbox', 'radio', 'separator']).optional(),
    accelerator: z.string().max(40).optional(),
    enabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    danger: z.boolean().optional(),
    submenu: z.array(menuItem).max(100).optional(),
  }).strict(),
)
const orderEntry = z.object({ kind: z.enum(['tab', 'chat']), id }).strict()
const schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string().max(5), days: z.array(z.number().int().min(0).max(6)).max(7) }),
  z.object({ kind: z.literal('interval'), hours: z.number().min(1).max(168) }),
])
const uuid = z.string().uuid()
const chatId = z.string().regex(/^[0-9a-f-]{36}$/)
const chatIds = z.union([chatId, z.array(chatId).min(1).max(1000)])
const companionId = z.string().regex(COMPANION_ID)
/** A companion id or 'shared'. */
const owner = z.string().regex(COMPANION_ID)
/** A path inside a companion's Files folder; CompanionFiles confines it further. */
const filePath = z.string().max(1024).refine((p) => !p.includes('\0') && !p.split(/[\\/]/).includes('..'))
const newChatOptions = z.object({ companionId: companionId.optional(), model: z.enum(MODELS).optional(), effort: z.enum(EFFORTS).optional(), engine: z.enum(ENGINES).optional() }).strict()
const chatFilter = z.object({
  query: text(500).optional(),
  companionId: companionId.optional(),
  routine: z.enum(['only', 'exclude']).optional(),
  status: z.enum(['unread', 'needs-input', 'archived']).optional(),
  sort: z.enum(['recent', 'oldest', 'best-match']).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  // ChatListFilter: projects, delegated children and imported transcripts.
  projectId: idSchema.optional(),
  children: z.enum(['exclude', 'only', 'include']).optional(),
  imported: z.enum(['only', 'exclude']).optional(),
}).strict()
const pngDataUrl = z.string().startsWith(DOCK_ICON_PREFIX).max(DOCK_ICON_MAX).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)

export const SERVICE_SCHEMAS: { [S in ServiceName]: { [M in keyof Services[S]]: z.ZodType<unknown[]> } } = {
  bookmarks: {
    ...BOOKMARKS_SCHEMA_ADDITIONS,
    list: z.tuple([]),
    toggle: z.tuple([url, text(1024)]),
    remove: z.tuple([id]),
    rename: z.tuple([id, text(1024)]),
  },
  downloads: {
    ...DOWNLOADS_SCHEMA_ADDITIONS,
    list: z.tuple([]),
    open: z.tuple([id]),
    showInFolder: z.tuple([id]),
    cancel: z.tuple([id]),
    clear: z.tuple([]),
  },
  history: {
    search: z.tuple([text(512), z.number().int().min(1).max(2000)]),
    remove: z.tuple([url]),
    clear: z.tuple([]),
  },
  find: {
    ...FIND_SCHEMA_ADDITIONS,
    start: z.tuple([text(512), z.boolean(), z.boolean()]),
    stop: z.tuple([]),
  },
  chats: {
    ...CHATS_SCHEMA_ADDITIONS,
    ...CHATS_COMPACTION_SCHEMAS,
    ...PRIVATE_CHATS_SCHEMAS,
    ...CHATS_PROJECT_SCHEMAS,
    list: z.tuple([chatFilter.optional()]),
    get: z.tuple([chatId]),
    create: z.tuple([newChatOptions.optional()]),
    configure: z.tuple([chatId, newChatOptions]),
    rename: z.tuple([chatId, z.string().trim().min(1).max(CHAT_TITLE_MAX)]),
    pin: z.tuple([chatIds]),
    unpin: z.tuple([chatIds]),
    markRead: z.tuple([chatIds]),
    markUnread: z.tuple([chatIds]),
    markAllRead: z.tuple([]),
    archive: z.tuple([chatIds]),
    unarchive: z.tuple([chatIds]),
    duplicate: z.tuple([chatId]),
    export: z.tuple([chatId]),
    remove: z.tuple([chatIds]),
    // CH-09: with the message's attachments.
    editAndResend: editAndResendArgs,
    retry: z.tuple([chatId, uuid.optional()]),
    feedback: z.tuple([chatId, uuid, z.enum(['helpful', 'not-helpful']).nullable(), text(2000).optional()]),
    details: z.tuple([chatId, uuid]),
    editQueued: z.tuple([chatId, uuid, z.string().max(20_000).nullable()]),
    setViewing: z.tuple([z.string().min(1).max(64), chatId.nullable()]),
    tabOwners: z.tuple([]),
  },
  // The whole namespaces, the original methods widened (filters, steps, schedules).
  skills: SKILLS_SCHEMAS,
  routines: ROUTINES_SCHEMAS,
  memory: {
    ...MEMORY_JOBS_SCHEMAS,
    list: z.tuple([owner.optional()]),
    read: z.tuple([text(512), owner.optional()]),
    write: z.tuple([text(512), text(262_144), owner.optional()]),
    remove: z.tuple([text(512), owner.optional()]),
  },
  connectors: {
    ...CONNECTORS_SCHEMAS.connectors,
    list: z.tuple([]),
    save: CONNECTORS_SAVE_SCHEMA, // the original remote input or ConnectorInputV2
    remove: z.tuple([id]),
  },
  companion: {
    get: z.tuple([]),
    set: z.tuple([z.object({
      name: z.string().trim().min(1).max(COMPANION_NAME_MAX).optional(),
      persona: z.string().regex(PERSONA_ID).optional(),
      look: lookSchema.optional(),
      dockIcon: z.boolean().optional(),
    }).strict()]),
    presets: z.tuple([]),
    setDockIcon: z.tuple([pngDataUrl]),
  },
  companions: {
    ...COMPANIONS_SETUP_SCHEMAS,
    list: z.tuple([]),
    activeId: z.tuple([]),
    get: z.tuple([companionId]),
    setActive: z.tuple([companionId]),
    update: z.tuple([companionId, z.object({
      name: z.string().trim().min(1).max(COMPANION_NAME_MAX).optional(),
      persona: z.string().regex(PERSONA_ID).optional(),
      look: lookSchema.optional(),
      dockIcon: z.boolean().optional(),
      instructions: text(COMPANION_INSTRUCTIONS_MAX).optional(),
      model: z.enum(MODELS).nullable().optional(),
      effort: z.enum(EFFORTS).nullable().optional(),
      engine: z.enum(ENGINES).nullable().optional(),
    }).strict()]),
    create: z.tuple([z.object({
      presetId: z.string().regex(PERSONA_ID).optional(),
      name: z.string().trim().min(1).max(COMPANION_NAME_MAX).optional(),
      persona: z.string().regex(PERSONA_ID).optional(),
      look: lookSchema.optional(),
      activate: z.boolean().optional(),
    }).strict()]),
    duplicate: z.tuple([companionId]),
    hide: z.tuple([companionId]),
    unhide: z.tuple([companionId]),
    reset: z.tuple([companionId]),
    remove: z.tuple([companionId]),
    export: z.tuple([companionId, z.object({
      includeSkills: z.boolean().optional(),
      includeRoutines: z.boolean().optional(),
      includeMemory: z.boolean().optional(),
      note: text(500).optional(),
      shareImage: pngDataUrl.optional(),
    }).strict().optional()]),
    pickImport: z.tuple([]),
    previewImport: z.tuple([z.string().min(1).max(COMPANION_FILE_MAX_BYTES)]),
    confirmImport: z.tuple([uuid]),
  },
  companionFiles: {
    list: z.tuple([companionId, filePath]),
    // 25 MB of bytes is about 33.4 million base64 characters.
    add: z.tuple([companionId, filePath, z.string().min(1).max(255), z.string().max(Math.ceil((FOLDER_FILE_MAX_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/)]),
    open: z.tuple([companionId, filePath.min(1)]),
    reveal: z.tuple([companionId, filePath]),
    remove: z.tuple([companionId, filePath.min(1)]),
  },
  importer: {
    sources: z.tuple([]),
    run: z.tuple([id]),
  },
  peek: {
    ...PEEK_SCHEMA_ADDITIONS,
    open: z.tuple([url]),
    close: z.tuple([]),
    promote: z.tuple([]),
  },
  split: {
    ...SPLIT_SCHEMA_ADDITIONS,
    open: z.tuple([]),
    close: z.tuple([]),
    swap: z.tuple([]),
    openWith: z.tuple([tabId, tabId]),
  },
  spend: {
    view: z.tuple([]),
  },
  pages: {
    open: z.tuple([z.string().startsWith('apex://').max(512), z.object({ newTab: z.boolean().optional(), background: z.boolean().optional() }).strict().optional()]),
    snapshot: z.tuple([tabId]),
  },
  menu: {
    popup: z.tuple([z.array(menuItem).min(1).max(100), point, point]),
  },
  tabs: {
    ...TABS_SCHEMA_ADDITIONS,
    setOrder: z.tuple([z.array(orderEntry).max(2000)]),
    move: z.tuple([tabId, z.number().int().min(0).max(10_000)]),
    setPinned: z.tuple([tabId, z.boolean()]),
    setMuted: z.tuple([tabId, z.boolean()]),
    duplicate: z.tuple([tabId]),
    closeMany: z.tuple([z.array(tabId).max(2000)]),
    clearTabs: z.tuple([]),
    undoClearTabs: z.tuple([z.string().uuid()]),
    reopenClosed: z.tuple([]),
    history: z.tuple([tabId, z.enum(['back', 'forward'])]),
    goToIndex: z.tuple([tabId, z.number().int().min(0).max(100_000)]),
  },
  window: {
    state: z.tuple([]),
    setSidebarOpen: z.tuple([z.boolean()]),
    setName: z.tuple([z.string().max(200).nullable()]),
    setButtonPosition: z.tuple([z.object({ x: z.number().finite().min(0).max(400), y: z.number().finite().min(0).max(200) }).strict().nullable()]),
    setButtonsVisible: z.tuple([z.boolean()]),
    trackSidebarPointer: z.tuple([z.object({ x: z.number().finite().min(-10_000).max(10_000), y: z.number().finite().min(-10_000).max(10_000), width: z.number().finite().min(0).max(10_000), height: z.number().finite().min(0).max(10_000) }).strict().nullable()]),
    close: z.tuple([]),
  },
  theme: {
    state: z.tuple([]),
  },
  onboarding: {
    ...ONBOARDING_SCHEMAS,
    complete: z.tuple([]),
  },
  firstWeek: {
    view: z.tuple([]),
    setDone: z.tuple([z.string().regex(ITEM_ID), z.boolean()]),
    dismiss: z.tuple([z.string().regex(ITEM_ID)]),
    restore: z.tuple([z.string().regex(ITEM_ID)]),
    dismissAll: z.tuple([]),
    snooze: z.tuple([]),
    unsnooze: z.tuple([]),
    hide: z.tuple([z.enum(HIDE_REASONS), z.string().max(HIDE_NOTE_MAX).optional()]),
    show: z.tuple([]),
    acknowledge: z.tuple([]),
    makeDefaultBrowser: z.tuple([]),
  },
  engine: {
    status: z.tuple([]),
    copyCommand: z.tuple([]),
    addToClaudeCode: z.tuple([]),
    revoke: z.tuple([]),
  },
  // The service methods of the engines a build adds (src/main/engines/extras.ts).
  ...EXTRA_SERVICE_SCHEMAS,
  ...SPEECH_SCHEMAS,
  ...PASSWORDS_SCHEMAS,
  ...AUTOFILL_SCHEMAS,
  ...VOICE_SCHEMAS,
  ...MEETINGS_SCHEMAS,
  ...MEETING_CAPTURE_SCHEMAS,
  ...CORE_SCHEMAS,
  ...ADDRESS_SCHEMAS,
  ...TAB_SCHEMAS,
  ...SITE_SCHEMAS,
  ...MENU_SCHEMAS,
  ...CHAT_SCHEMAS,
  ...SETTINGS_SCHEMAS,
  ...UPDATES_SCHEMAS,
  ...DIAGNOSTICS_SCHEMAS,
  ...MIGRATIONS_SCHEMAS,
  ...SYSTEM_SCHEMAS,
  ...NATIVE_SCHEMAS,
  ...INTAKE_SCHEMAS,
  ...FILES_SCHEMAS,
  ...EXTENSIONS_SCHEMAS,
  ...PROFILES_SCHEMAS,
  ...AGENT_TOOLS_SCHEMAS,
  ...CHAT_TOOLS_SCHEMAS,
  ...MEMORY_UPKEEP_SCHEMAS,
  ...WORKSPACE_SCHEMAS,
  ...PLATFORM_SCHEMAS,
  ...FIRST_RUN_SCHEMAS,
  agent: { ...CHAT_SCHEMAS.agent, ...AGENT_TOOLS_METHOD_SCHEMAS },
  ...MEDIA_SCHEMAS, // media hub (MD-01)
  ...TWEAKS_SCHEMAS, // tweaks (TWK-01)
  ...WEB_APPS_SCHEMAS, // websites saved as apps (WA-01)
  ...READER_SCHEMAS, // reader (RD-01)
  ...PRIVACY_PACK_SCHEMAS, // privacy pack
  ...TRANSLATE_SCHEMAS, // translate (TR-01)
  ...SYSTEM_PERMISSIONS_SCHEMAS, // this Mac's permissions
  ...PACKS_SCHEMAS, // packs (docs/packs.md)
  ...DECISIONS_SCHEMAS, // quick decisions (docs/decisions.md)
}

const request = z.tuple([z.string(), z.string(), z.array(z.unknown())])

// Every call resolves its window's services from the sender
type ServiceRouter = (event: IpcMainInvokeEvent) => Services | null
let router: ServiceRouter | null = null

/** Routes calls from every window's chrome and overlay renderers to that window's services. */
export function setServiceRouter(fn: ServiceRouter | null): void {
  router = fn
}

export function registerServices(ui: WebContents, firstServices: Services): void {
  ipcMain.handle(UI.invoke, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
    // The first window's chrome, or whatever the router resolves (other windows, overlay renderers).
    const services = isTrustedUiSender(event, ui) ? firstServices : router?.(event)
    if (!services) throw new Error('Rejected IPC from an untrusted sender.')
    const [serviceName, methodName, args] = request.parse(raw)
    const schemas = (SERVICE_SCHEMAS as Record<string, Record<string, z.ZodType<unknown[]>> | undefined>)[serviceName]
    const schema = schemas && Object.hasOwn(schemas, methodName) ? schemas[methodName] : undefined
    if (!schema) throw new Error(`Unknown service method ${serviceName}.${methodName}.`)
    const service = services[serviceName as ServiceName] as unknown as Record<string, (...a: unknown[]) => unknown>
    return service[methodName]?.(...schema.parse(args))
  })
}
