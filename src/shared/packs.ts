/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Packs (docs/packs.md): the one unit you make, install, share and remix. A
// pack is a folder with apex-pack.json listing what it adds (skills, routine
// templates, tweaks, themes, companions, connectors, panels, apps, commands,
// page menu items and agent tools) and the permissions its code may use. This
// module holds the contract both sides share: the manifest's types and
// limits, path and host rules, and the plain-words permission lines the
// install card shows, with the diff an update is checked against.
import { BRAND_NAME } from './branding'
import type { MessageKey } from './i18n/core'
import type { CompanionFileSchedule } from './companion'
import { normalizeTweakHost } from './tweaks'

export const PACK_FORMAT = 'apex-pack'
/** The newest manifest version this Apex reads (2 added apps). */
export const PACK_MANIFEST_VERSION = 2
/** What Apex writes into a new manifest: 1 still reads in older Apex; a pack needs 2 only once it holds an app. */
export const PACK_MANIFEST_NEW_VERSION = 1
export const PACK_MANIFEST_FILE = 'apex-pack.json'
export const PACK_FILE_EXTENSION = 'apexpack'
/** The same archive, for a pack that holds an app (docs/apps.md › Sharing). */
export const PACK_APP_FILE_EXTENSION = 'apexapp'
/** Every extension an archive may have, for open dialogs and the OS. */
/** A pack that holds only worlds travels as .apexworld (docs/apps.md › Worlds); same archive. */
export const PACK_WORLD_FILE_EXTENSION = 'apexworld'
export const PACK_ARCHIVE_EXTENSIONS: readonly string[] = [PACK_FILE_EXTENSION, PACK_APP_FILE_EXTENSION, PACK_WORLD_FILE_EXTENSION]

/** Whether a file name is a pack archive (.apexpack, .apexapp or .apexworld). */
export function isPackArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return PACK_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`))
}
export const PACK_SCHEME = 'apex-pack'
/** Each pack runs in its own persistent, locked-down partition: persist:apex-pack-<id>. */
export const PACK_PARTITION_PREFIX = 'persist:apex-pack-'
/** Apex's own files inside a pack's address (the tool host, the signature); a pack can't ship them. */
export const PACK_RESERVED_DIR = '__apex'
export const PACK_SIGNATURE_FILE = `${PACK_RESERVED_DIR}/signature.json`
/** Share… adds a note and a share image beside the signed files (docs/apps.md › Sharing); neither is signed. */
export const PACK_SHARE_FILE = `${PACK_RESERVED_DIR}/share.json`
export const PACK_SHARE_IMAGE_FILE = `${PACK_RESERVED_DIR}/share.png`
export const PACK_SHARE_NOTE_MAX = 500
export const PACK_SHARE_IMAGE_MAX = 4 * 1024 * 1024
export const PACK_TOOL_HOST_PATH = `${PACK_RESERVED_DIR}/tool-host.html`
export const PACK_TOOL_HOST_SCRIPT = `${PACK_RESERVED_DIR}/tool-host.js`
export const PACK_INDEX_FORMAT = 'apex-pack-index'
/** What an index entry is (docs/apps.md › The community index): a pack, an app (or game), or a world. */
export const PACK_INDEX_KINDS = ['pack', 'app', 'world'] as const
export type PackIndexKind = (typeof PACK_INDEX_KINDS)[number]
export const PACK_INDEX_CATEGORIES = ['games', 'tools', 'worlds', 'creative', 'learning', 'productivity', 'companions', 'other'] as const
export type PackIndexCategory = (typeof PACK_INDEX_CATEGORIES)[number]
/** The community index Apex starts with (github.com/3SENN/apex-packs); you can remove it on Browse. */
export const DEFAULT_PACK_INDEXES: ReadonlyArray<{ url: string; name: string }> = [{ url: 'https://raw.githubusercontent.com/3SENN/apex-packs/main/index.json', name: 'Community packs' }]

export const PACK_LIMITS = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  packBytes: 10 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  perContribution: 50,
  storageBytes: 1024 * 1024,
  logLines: 500,
  /** Under PackAuditLog: what each pack's log keeps (a few MB at most). */
  auditLogLines: 20_000,
  fetchBytes: 5 * 1024 * 1024,
  fetchBodyBytes: 1024 * 1024,
  fetchTimeoutMs: 20_000,
  toolTimeoutMs: 60_000,
  toolIdleMs: 5 * 60_000,
  pageTextChars: 100_000,
  queryMatches: 50,
  /** A .js line longer than this reads as minified, and the pack is refused. */
  minifiedLine: 2_000,
  opensPerMinute: 5,
  indexBytes: 2 * 1024 * 1024,
  /** Drafts a companion may keep at once. */
  drafts: 50,
} as const

/** Limits on a pack's files: PACK_LIMITS, or the larger APP_PACK_LIMITS for a pack with an app. */
export interface PackFileLimits {
  files: number
  fileBytes: number
  packBytes: number
}

/** A pack with an app may hold a game's assets (docs/apps.md › The manifest; starting values). */
export const APP_PACK_LIMITS: PackFileLimits = { files: 5_000, fileBytes: 50 * 1024 * 1024, packBytes: 300 * 1024 * 1024 }

/** At most this many apps per pack. */
export const PACK_APPS_MAX = 5

export function packFileLimits(hasApps: boolean): PackFileLimits {
  return hasApps ? APP_PACK_LIMITS : { files: PACK_LIMITS.files, fileBytes: PACK_LIMITS.fileBytes, packBytes: PACK_LIMITS.packBytes }
}

/** Whether a parsed manifest (checked or not) lists any apps, which picks the limits. */
export function manifestHasApps(raw: unknown): boolean {
  const apps = raw && typeof raw === 'object' ? (raw as { contributes?: { apps?: unknown } }).contributes?.apps : undefined
  return Array.isArray(apps) && apps.length > 0
}

/** Whether a parsed manifest lists asset sets (an asset pack can be as big as an app's art). */
export function manifestHasAssets(raw: unknown): boolean {
  const assets = raw && typeof raw === 'object' ? (raw as { contributes?: { assets?: unknown } }).contributes?.assets : undefined
  return Array.isArray(assets) && assets.length > 0
}

/** Whether a manifest gets the larger limits: it holds an app or an asset set. */
export function manifestIsBig(raw: unknown): boolean {
  return manifestHasApps(raw) || manifestHasAssets(raw)
}

export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
/** Ids of a pack's own items: panels, commands, menus, tweaks, themes, routines, connectors. */
export const PACK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const PACK_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/
export const PACK_VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
/** One path segment: letters, digits, dot, dash and underscore; never only dots. */
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/

/** First-party packs (docs/packs.md › First-party packs). */
export const BUILTIN_SKILLS_PACK_ID = 'apex-builtin-skills'
export const EXAMPLE_PACK_ID = 'apex-example-reading-time'

/** The bridge's IPC channels (src/preload/pack.ts ↔ src/main/packs/bridge.ts). */
export const PACK_IPC = {
  /** sendSync at boot: the pack's id, name and version, or null outside a pack page. */
  info: 'apex-pack:info',
  /** invoke({ op, args }): every window.apex call. */
  bridge: 'apex-pack:bridge',
  /** main → tool host: one tool call. */
  toolCall: 'apex-pack:tool-call',
  /** tool host → main: the call's result. */
  toolResult: 'apex-pack:tool-result',
  /** tool host → main: apex.tools.serve was called. */
  toolReady: 'apex-pack:tool-ready',
  /** main → a pack page that called apex.services.provide: one service call. */
  serviceCall: 'apex-pack:service-call',
  /** that page → main: the call's result. */
  serviceResult: 'apex-pack:service-result',
  /** main → a pack page or tool host: an event it listens to (docs/apps.md › Events). */
  event: 'apex-pack:event',
  /** main → the page that called apex.ai.stream: one piece of the reply. */
  aiChunk: 'apex-pack:ai-chunk',
} as const

export type PackBridgeReply = { ok: true; value: unknown } | { ok: false; error: string }

export interface PackToolCallMessage {
  callId: string
  name: string
  input: unknown
  ctx: { chatId: string | null; companionId: string | null; test: boolean }
}

export type PackToolResultMessage = { callId: string; ok: true; value: unknown } | { callId: string; ok: false; error: string }

/** One call to a service a page provides; `from` is the calling pack's id, or 'companion' for use_app. */
export interface PackServiceCallMessage {
  callId: string
  service: string
  method: string
  input: unknown
  from: string
}

export interface PackEventMessage {
  /** `<packId>/<event>` for a pack's event, `apex.<event>` for Apex's own. */
  name: string
  data: unknown
}

// ---- the manifest ----

/** `skill:<name>` (one of the pack's own skills), `panel:<id>`, `app:<id>` or `tool:<name>`. */
export type PackRun = string

export interface PackRoutineTemplate {
  id: string
  name: string
  /** Instructions, or a skill to start with: `/name` at the start runs one of the pack's skills. */
  prompt: string
  schedule: CompanionFileSchedule
}

export interface PackTweak {
  id: string
  /** Hosts, as tweaks take them (www. dropped). */
  match: string[]
  subdomains?: boolean
  css?: string
  js?: string
}

export interface PackTheme {
  id: string
  name: string
  /** #rrggbb; Apex derives the rest of the accent from it, with readable text. */
  accent: string
}

export interface PackConnector {
  id: string
  name: string
  /** A remote MCP server (https, or http on this computer). */
  url?: string
  /** A local server: the program and its arguments. Its first start still needs your approval. */
  command?: string
  args?: string[]
}

export interface PackPanel {
  id: string
  title: string
  html: string
  /** A row in the sidebar's Packs block that opens it beside the page. */
  sidebar?: boolean
  /** A .png or .svg (up to 64 KB) for its sidebar row; a package glyph without one. */
  icon?: string
}

/**
 * An app (docs/apps.md): a full page under its own folder of the pack, served
 * with the app CSP, in the pack's partition. `kit` apps are readable modules,
 * reviewed like any pack code; `bundled` apps are a build tool's output, and
 * the review says it can't show that code.
 */
export interface PackApp {
  id: string
  name: string
  /** The app's folder in the pack; everything under it gets the app CSP. */
  root: string
  /** The page that opens, relative to `root`. */
  entry: string
  build: PackAppBuild
  /** Games may go full screen and lock the pointer without asking. */
  kind: PackAppKind
  /** A .png or .svg (up to 64 KB) for its sidebar row. */
  icon?: string
  /** A row in the sidebar's Packs block that opens it. */
  sidebar?: boolean
  orientation?: PackAppOrientation
  /** Served cross-origin isolated (COOP and COEP), for SharedArrayBuffer: threaded WebAssembly such as Godot, Unity or Emscripten builds. */
  isolated?: boolean
  /** Lets its scripts run code they make while running (eval, new Function); some older engines need it. */
  eval?: boolean
  /** What asset packs may replace (docs/apps.md › Asset slots and asset packs). */
  assets?: PackAssetSlot[]
  /** The Apex kit major it builds on (docs/apps.md › The kit): its pages get an import map for three, three/addons/ and apex-kit/. */
  kit?: number
  /** It casts the person's companions as characters (docs/apps.md › The cast): how many it can use. */
  cast?: { min: number; max: number }
}

/** A companion as an app sees it: a name and a look, under a ref that differs in every app. */
export interface PackCastMember {
  ref: string
  name: string
  rig: string
  look: import('./companion').CompanionLook
}

/** The kit majors this Apex serves. */
export const KIT_MAJORS: readonly number[] = [1]
/** Where a pack's pages load the kit: inside their own origin, so modules and isolation need nothing extra. */
export const PACK_KIT_DIR = `${PACK_RESERVED_DIR}/kit`

/** One thing in an app that asset packs may replace: its art, its voices, a level set. */
export interface PackAssetSlot {
  id: string
  name: string
  description: string
  /** The app's own folder this slot mirrors, so a pack can copy it and change files; a file a pack lacks comes from here. */
  layout?: string
}

/** A set of assets for another pack's app: no code, only files. */
export interface PackAssetSet {
  id: string
  name: string
  for: { pack: string; app: string; slot: string }
  /** Its folder in this pack. */
  root: string
}

/** Where an app page reads the person's own files (apex.files.own): copies in the app's private space, never part of the pack. */
export const PACK_OWN_DIR = `${PACK_RESERVED_DIR}/own`

/** A path relative to a granted folder or the own-files space: `/`-separated, no `..`, nothing absolute; null when it isn't one. */
export function safeRelativePath(path: string): string | null {
  if (typeof path !== 'string' || path.length > 500) return null
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..' || /^[A-Za-z]:$/.test(p) || /[\u0000-\u001f<>:"|?*]/.test(p))) return null
  return parts.join('/')
}

/** Where an app page reads a slot's files: the chosen asset pack's, else the app's own layout. */
export const PACK_ASSETS_DIR = `${PACK_RESERVED_DIR}/assets`

/** What can't be in an asset set's folder: anything that runs. */
export function isAssetCode(path: string): boolean {
  return /\.(m?js|cjs|html?|xhtml|wasm)$/i.test(path)
}

/** The address an app page reads one of a slot's files at (slot ids are unique within a pack). */
export function packAssetPath(slot: string, path: string): string {
  return `${PACK_ASSETS_DIR}/${slot}/${path}`
}

/** An app page's asset address as its parts, or null. */
export function parseAssetPath(path: string): { slot: string; path: string } | null {
  if (!path.startsWith(`${PACK_ASSETS_DIR}/`)) return null
  const [slot, ...rest] = path.slice(PACK_ASSETS_DIR.length + 1).split('/')
  if (!slot || rest.length === 0) return null
  return { slot, path: rest.join('/') }
}

export type PackAppBuild = 'kit' | 'bundled'
export const PACK_APP_BUILDS: readonly PackAppBuild[] = ['kit', 'bundled']
export type PackAppKind = 'game' | 'tool'
export const PACK_APP_KINDS: readonly PackAppKind[] = ['game', 'tool']
export type PackAppOrientation = 'any' | 'landscape' | 'portrait'
export const PACK_APP_ORIENTATIONS: readonly PackAppOrientation[] = ['any', 'landscape', 'portrait']

/** The app whose folder holds a path, or null for the pack's other files. */
export function packAppAt<A extends Pick<PackApp, 'root'>>(apps: readonly A[] | undefined, path: string): A | null {
  return apps?.find((a) => path === a.root || path.startsWith(`${a.root}/`)) ?? null
}

/** Where an app's entry page is inside the pack. */
export function packAppEntryPath(app: Pick<PackApp, 'root' | 'entry'>): string {
  return `${app.root}/${app.entry}`
}

/**
 * A card on the new tab page. Its module exports `async function run(ctx)`
 * and returns text lines (or one string); Apex draws them itself, so no pack
 * code runs in the new tab page. `open` runs when the card is clicked.
 */
export interface PackCard {
  id: string
  title: string
  module: string
  open?: PackRun
}

/** What a card shows, as Apex draws it. */
export interface PackCardView {
  packId: string
  packName: string
  cardId: string
  title: string
  lines: string[]
  error: string | null
  canOpen: boolean
}

/** A sidebar row for a pack panel or app. */
export interface PackSidebarEntry {
  packId: string
  kind: 'panel' | 'app'
  /** The panel's or the app's id. */
  itemId: string
  title: string
  /** A data: URL of the pack's icon, or null for the package glyph. */
  icon: string | null
  /** An app's status (apex.status.set), while one of its pages is open. */
  status: PackAppStatus | null
}

/** AP-01: every app and panel of the packs that run, for Apps and the sidebar (sidebar is where it starts). */
export interface PackItem extends PackSidebarEntry {
  packName: string
  sidebar: boolean
}

export const PACK_CARD_LIMITS = { lines: 5, lineChars: 160, iconBytes: 64 * 1024, timeoutMs: 10_000, freshMs: 5 * 60_000 } as const

export interface PackCommand {
  id: string
  title: string
  run: PackRun
}

export type PackMenuContext = 'page' | 'selection' | 'link'
export const PACK_MENU_CONTEXTS: readonly PackMenuContext[] = ['page', 'selection', 'link']

export interface PackMenuItem {
  id: string
  title: string
  context: PackMenuContext
  run: PackRun
}

export interface PackTool {
  name: string
  description: string
  /** A JSON Schema object for the input. */
  inputSchema: Record<string, unknown>
  module: string
}

export interface PackContributions {
  skills?: string[]
  routines?: PackRoutineTemplate[]
  tweaks?: PackTweak[]
  themes?: PackTheme[]
  companions?: string[]
  connectors?: PackConnector[]
  panels?: PackPanel[]
  apps?: PackApp[]
  /** Asset sets for other packs' apps (docs/apps.md › Asset slots and asset packs). */
  assets?: PackAssetSet[]
  commands?: PackCommand[]
  menus?: PackMenuItem[]
  tools?: PackTool[]
  cards?: PackCard[]
  /** World files (docs/apps.md › Worlds), each a .json in the pack (manifest version 2). */
  worlds?: string[]
}

export interface PackPermissions {
  /** Hosts the pack's code may read and its tweaks change; `*.example.com` also covers example.com. */
  sites: string[]
  /** Hosts apex.fetch may reach: https, or http on localhost and 127.0.0.1. */
  network: string[]
  /** Tweak scripts on the tweaks' sites. */
  pageScripts: boolean
  notifications: boolean
  /** apex.ask: one-shot model calls on your chosen engine. */
  model: boolean
  clipboard: boolean
  /** apex.files: files the person picks, a folder they choose, files of their own (docs/apps.md › Assets › Your own files). */
  files?: boolean
  /** apex.cast.speak: the person's companions say lines in this app, in character (needs model). */
  speak?: boolean
  /** apex.worlds: lists, reads, changes and opens the person's worlds (the world viewer). */
  worlds?: boolean
  /**
   * apex.connectors: the person's connectors it uses, by their directory
   * entry (atlassian, github) or a server's name. Each tool runs as the person
   * set it in Connectors: off refuses, "ask" asks them every time.
   */
  connectors?: string[]
  /**
   * apex.server (docs/packs.md › A web server of its own): an app's page may
   * start a small web server that Apex runs for it, on this computer only, or
   * with `lan` for phones and computers on the same Wi-Fi too.
   */
  server?: PackServerPermission
}

/** permissions.server: present means an app may serve this computer; `lan` adds the same Wi-Fi. */
export interface PackServerPermission {
  lan?: boolean
}

/** A connector a pack names: a directory id or a server name. */
export const PACK_CONNECTOR_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PACK_CONNECTOR_LIMITS = { connectors: 10, inputChars: 100_000, resultChars: 200_000 } as const

/** A connector as an app sees it: whether the person has it on, and its name; never its address or credentials. */
export interface PackConnectorState {
  connected: boolean
  name: string | null
}

export const NO_PACK_PERMISSIONS: PackPermissions = { sites: [], network: [], pageScripts: false, notifications: false, model: false, clipboard: false }

/** What a pack may ask for while it runs (apex.permissions.request, docs/apps.md › Freedom), and what the person granted of it. */
export interface PackOptionalPermissions {
  sites?: string[]
  network?: string[]
  notifications?: boolean
  model?: boolean
  clipboard?: boolean
}

// ---- your own servers, keys and settings (docs/apps.md › Your own servers) ----

/**
 * A key or token the person enters for a pack: their API key for a service,
 * their account's token. Apex keeps it in the system keychain and adds it to
 * requests to its hosts; the pack's code never reads it.
 */
export interface PackSecret {
  /** Written like an environment variable (API_KEY). The same name in a linked folder's .env fills it while you develop. */
  id: string
  name: string
  /** Where to find it, in a sentence. */
  description?: string
  /** Where Apex sends it: hosts from permissions.network or optionalPermissions.network. */
  hosts: string[]
  /** The request header it goes in, such as Authorization or X-Api-Key. */
  header: string
  /** Written before the value, such as "Bearer ". */
  prefix?: string
}

/** Names of env values and secrets: API_KEY, SERVER_URL. */
export const PACK_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
export const PACK_SECRET_LIMITS = { secrets: 10, valueChars: 8_192, env: 50, envValueChars: 2_000, prefixChars: 40 } as const
export const PACK_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/
/** Headers a secret can't go in: the browser sets them, or they would carry sign-ins. */
export const PACK_SECRET_HEADER_FORBIDDEN = /^(cookie|cookie2|host|origin|referer|connection|content-length|content-type|keep-alive|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i

/** Whether a secret has a value now: entered in Apex, set by the organisation's policy, from a linked folder's .env (developer mode), or neither. */
export type PackSecretState = 'set' | 'policy' | 'env' | 'none'

/**
 * A sign-in an app runs through Apex (docs/apps.md › Apps for organisations):
 * OAuth 2 or OpenID Connect with PKCE against the issuer, in a tab, with a
 * loopback redirect. Apex keeps the tokens in the system keychain, refreshes
 * them, and adds the access token (Authorization: Bearer) to the app's
 * requests to its hosts; the app's code never sees a token.
 */
export interface PackAuth {
  /** Lowercase letters, digits and dashes: corp, crm. */
  id: string
  /** What the person signs in with, such as "Contoso account". */
  name: string
  /** The identity provider; its metadata is under /.well-known/. https, or http on this computer while you develop. */
  issuer: string
  /** The app's client there: a public client (no secret) whose redirect is http://127.0.0.1/callback on any port. */
  clientId: string
  scopes?: string[]
  /** Where the access token goes: hosts from permissions.network or optionalPermissions.network. */
  hosts: string[]
}

export const PACK_AUTH_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const PACK_AUTH_LIMITS = { auth: 4, scopes: 20, scopeChars: 200, clientIdChars: 200 } as const

/** A sign-in as the app and the pack's page see it: who is signed in (the ID token's name or email), never a token. */
export interface PackAuthState {
  signedIn: boolean
  user: string | null
}

/** A pack's permissions with what the person granted later added in. */
export function mergePermissions(base: PackPermissions, granted: PackOptionalPermissions | null | undefined): PackPermissions {
  if (!granted) return base
  const union = (a: readonly string[], b: readonly string[] | undefined): string[] => [...new Set([...a, ...(b ?? [])])]
  return {
    ...base,
    sites: union(base.sites, granted.sites),
    network: union(base.network, granted.network),
    notifications: base.notifications || granted.notifications === true,
    model: base.model || granted.model === true,
    clipboard: base.clipboard || granted.clipboard === true,
  }
}

/** What of `asked` isn't covered by `have` yet: null when it all is. */
export function permissionsMissing(have: PackPermissions, asked: PackOptionalPermissions): PackOptionalPermissions | null {
  const out: PackOptionalPermissions = {}
  const sites = (asked.sites ?? []).filter((h) => !have.sites.includes(h))
  const network = (asked.network ?? []).filter((h) => !have.network.includes(h))
  if (sites.length) out.sites = sites
  if (network.length) out.network = network
  if (asked.notifications && !have.notifications) out.notifications = true
  if (asked.model && !have.model) out.model = true
  if (asked.clipboard && !have.clipboard) out.clipboard = true
  return Object.keys(out).length > 0 ? out : null
}

/** Whether every part of `asked` is in what a manifest lists as optional. */
export function withinOptional(optional: PackOptionalPermissions | undefined, asked: PackOptionalPermissions): boolean {
  const o = optional ?? {}
  return (asked.sites ?? []).every((h) => (o.sites ?? []).includes(h)) && (asked.network ?? []).every((h) => (o.network ?? []).includes(h)) && (!asked.notifications || o.notifications === true) && (!asked.model || o.model === true) && (!asked.clipboard || o.clipboard === true)
}

/** The kinds of permission lines a set of permissions (not contributions) produces. */
export const PERMISSION_LINE_KINDS: readonly PackGrantKind[] = ['exfil', 'read', 'network', 'model', 'notifications', 'clipboard', 'server']

/** The lines a set of optional or granted permissions reads as, on a pack that has code. */
export function describeOptional(m: Pick<PackManifest, 'contributes'>, p: PackOptionalPermissions | null | undefined): PackPermissionLine[] {
  if (!p) return []
  return describePackPermissions({ contributes: m.contributes, permissions: mergePermissions(NO_PACK_PERMISSIONS, p) }).filter((l) => PERMISSION_LINE_KINDS.includes(l.kind))
}

// ---- the plugin model (docs/apps.md › Everything is a plugin) ----

export const PACK_SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,47}$/
export const PACK_SERVICE_METHOD_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/
/** A pack's own event name; others hear it as `<packId>/<name>`. */
export const PACK_EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const PACK_REQUIRE_PATTERN = /^(>=)?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
/** Names Apex keeps for its own services (docs/apps.md › Services): no pack may provide one. */
export const APEX_SERVICE_NAMES: readonly string[] = ['ai', 'apex', 'assets', 'auth', 'cast', 'connectors', 'events', 'files', 'guide', 'kit', 'notify', 'pad', 'rooms', 'status', 'storage', 'world']
/** Apex's own services a pack can already list in `uses`; the other reserved names have no service yet. */
export const APEX_SERVICES_AVAILABLE: readonly string[] = []
/** Events Apex itself sends to packs that list them in `events.on`. */
export const APEX_EVENTS: readonly string[] = ['apex.theme']
export const PACK_SERVICE_LIMITS = { services: 10, methods: 30, uses: 20, emits: 20, listens: 30, requires: 20, payloadBytes: 1024 * 1024, eventBytes: 64 * 1024, callTimeoutMs: 30_000, eventsPerSecond: 50 } as const

export interface PackServiceMethod {
  description?: string
  /** A JSON Schema object for the input; Apex checks every call against it. */
  input: Record<string, unknown>
}

/** A service a pack provides to other packs (and, with `agent`, to companions through use_app). */
export interface PackService {
  service: string
  description: string
  methods: Record<string, PackServiceMethod>
  /** A module the tool host runs while no page of the pack serves it: `export async function <method>(input, ctx)`. */
  module?: string
  agent?: boolean
}

export interface PackEvents {
  /** Events the pack sends: its own names, which others hear as `<packId>/<name>`. */
  emits?: string[]
  /** Events it hears: `<packId>/<name>` or one of APEX_EVENTS. */
  on?: string[]
}

export interface PackRequires {
  /** Other packs, by id: `1.2.0` or `>=1.2.0` (the same thing: that version or newer). */
  packs?: Record<string, string>
}

/** A notification a pack set for later (apex.notifications.schedule). */
export interface PackScheduledNotification {
  id: string
  /** When, in ms since the epoch. */
  at: number
  title: string
  body: string
}
export const PACK_SCHEDULE_LIMITS = { count: 50, aheadMs: 30 * 24 * 60 * 60_000, lateMs: 60 * 60_000 } as const

/** What an app shows on its sidebar row and tab (apex.status.set). */
export interface PackAppStatus {
  text: string | null
  badge: number | null
  /** 0 to 1, or null for none. */
  progress: number | null
}
export const PACK_STATUS_TEXT_MAX = 40

export type PackStatusEvent = { type: 'pack-status'; packId: string; itemId: string; status: PackAppStatus | null }

/** One call of window.apex as apex_inspect lists it; `op` is the bridge op it becomes (none for calls the preload answers itself). */
export interface PackApiEntry {
  call: string
  op: string | null
  needs: string
  status: 'available' | 'planned'
}

/** window.apex, for apex_inspect and the build guide (docs/apps.md › window.apex). A test keeps it in step with the bridge's ops. */
export const PACK_API: readonly PackApiEntry[] = [
  { call: 'apex.pack', op: null, needs: '–', status: 'available' },
  { call: 'apex.storage.get(key)', op: 'storage.get', needs: '–', status: 'available' },
  { call: 'apex.storage.set(key, value)', op: 'storage.set', needs: '– (JSON, 1 MB per pack)', status: 'available' },
  { call: 'apex.storage.remove(key)', op: 'storage.remove', needs: '–', status: 'available' },
  { call: 'apex.storage.keys()', op: 'storage.keys', needs: '–', status: 'available' },
  { call: 'apex.page.info()', op: 'page.info', needs: 'the page’s host in permissions.sites', status: 'available' },
  { call: 'apex.page.text()', op: 'page.text', needs: 'the page’s host in permissions.sites', status: 'available' },
  { call: 'apex.page.query(selector)', op: 'page.query', needs: 'the page’s host in permissions.sites', status: 'available' },
  { call: 'apex.fetch(url, init)', op: 'fetch', needs: 'the host in permissions.network (from main: no CORS, no cookies, text bodies up to the fetch limit)', status: 'available' },
  { call: 'fetch(), WebSocket, EventSource, <img>, <audio> to your own hosts', op: null, needs: 'an app’s own pages and the host in permissions.network; normal CORS (the page’s origin is apex-pack://<pack id>); no WebRTC', status: 'available' },
  { call: 'apex.env.NAME', op: null, needs: '– (public values from the manifest’s env; a linked folder’s .env overrides them while you develop)', status: 'available' },
  { call: 'apex.secrets.status() → { NAME: true | false }', op: 'secrets.status', needs: 'secrets in the manifest (whether each has a value, never the value)', status: 'available' },
  { call: 'apex.secrets.request(NAME) → { set }', op: 'secrets.request', needs: 'the secret in the manifest; opens the pack’s page so the person can enter it', status: 'available' },
  { call: 'apex.auth.status() → { id: { signedIn, user } }', op: 'auth.status', needs: 'auth in the manifest (who is signed in, never a token)', status: 'available' },
  { call: 'apex.auth.signIn(id) → { signedIn, user }', op: 'auth.signIn', needs: `the sign-in in the manifest; opens the identity provider in a tab, then ${BRAND_NAME} sends the token to its hosts`, status: 'available' },
  { call: 'apex.auth.signOut(id)', op: 'auth.signOut', needs: 'the sign-in in the manifest', status: 'available' },
  { call: 'apex.notify({ title, body })', op: 'notify', needs: 'permissions.notifications', status: 'available' },
  { call: 'apex.notifications.schedule({ id, at, title, body }) / cancel(id) / list()', op: 'notify.schedule', needs: `permissions.notifications (fires while ${BRAND_NAME} runs, even with the app closed; up to 50, 30 days ahead)`, status: 'available' },
  { call: 'apex.notifications.cancel(id)', op: 'notify.cancel', needs: 'permissions.notifications', status: 'available' },
  { call: 'apex.notifications.list()', op: 'notify.list', needs: 'permissions.notifications', status: 'available' },
  { call: 'apex.ask(prompt, { system })', op: 'ask', needs: 'permissions.model', status: 'available' },
  { call: 'apex.clipboard.write(text)', op: 'clipboard.write', needs: 'permissions.clipboard', status: 'available' },
  { call: 'apex.open(url)', op: 'open', needs: 'the host in permissions.network', status: 'available' },
  { call: 'apex.log(...values)', op: 'log', needs: '–', status: 'available' },
  { call: 'apex.tools.serve(handler)', op: null, needs: '– (the tool host only)', status: 'available' },
  { call: 'apex.test.ready(state)', op: 'test.ready', needs: '– (what test_pack’s playtest reads; call it whenever the state changes, every frame is fine)', status: 'available' },
  { call: 'apex.services.call(service, method, input)', op: 'services.call', needs: 'the service in uses', status: 'available' },
  { call: 'apex.services.provide(service, { method: async (input, ctx) => … })', op: 'services.provide', needs: 'the service in provides', status: 'available' },
  { call: 'apex.events.on(name, fn)', op: 'events.on', needs: 'the name in events.on', status: 'available' },
  { call: 'apex.events.emit(name, data)', op: 'events.emit', needs: 'the name in events.emits', status: 'available' },
  { call: 'apex.status.set({ text, badge, progress }) / apex.status.clear()', op: 'status.set', needs: '– (an app’s own pages)', status: 'available' },
  { call: 'apex.permissions.request({ sites, network, notifications, model, clipboard })', op: 'permissions.request', needs: 'the permission in optionalPermissions', status: 'available' },
  { call: 'apex.assets.active(slot) / apex.assets.url(slot, path)', op: 'assets.active', needs: 'the slot in the app’s assets (an app’s own pages)', status: 'available' },
  { call: 'apex.ai.ask(prompt, { system, tier: "fast" | "smart", maxTokens })', op: 'ai.ask', needs: 'permissions.model (60 model calls an hour, 500 a day per pack)', status: 'available' },
  { call: 'apex.ai.json(prompt, { schema, system, tier })', op: 'ai.json', needs: 'permissions.model', status: 'available' },
  { call: 'apex.ai.decide(state, { key: { type: "noul" | "choice" | "score", instructions, criteria } })', op: 'ai.decide', needs: 'permissions.model (the person’s decision model when one is on: 600 an hour, 5,000 a day; otherwise their Claude engine within the model budget)', status: 'available' },
  { call: 'apex.ai.stream(prompt, { onText, system, tier })', op: 'ai.stream', needs: 'permissions.model (pieces as they arrive with an API key; one piece on other engines)', status: 'available' },
  { call: 'apex.ai.session({ system, tier, tools: [{ name, description, input, run }] }).send(text)', op: 'ai.turn', needs: 'permissions.model (on any engine: Messages API tools with an API key, one JSON-answering run per round on other engines)', status: 'available' },
  { call: 'apex.cast.members() → [{ ref, name, rig, look }]', op: 'cast.members', needs: 'cast on the app (an app’s own pages)', status: 'available' },
  { call: 'apex.cast.pick({ max, title })', op: 'cast.pick', needs: 'cast on the app; the person picks', status: 'available' },
  { call: 'apex.cast.speak(ref, { situation, mood })', op: 'cast.speak', needs: 'permissions.model and permissions.speak', status: 'available' },
  { call: 'apex.cast.sprites() / model()', op: null, needs: '– (bundled apps’ renders of a look)', status: 'planned' },
  { call: 'apex.guide.say(text, { mood })', op: 'guide.say', needs: '–', status: 'planned' },
  { call: 'apex.files.open({ accept, multiple }) → [{ name, size, data }]', op: 'files.open', needs: 'permissions.files', status: 'available' },
  { call: 'apex.files.save(name, data)', op: 'files.save', needs: 'permissions.files', status: 'available' },
  { call: 'apex.files.folder() then list(path) / read(path) / write(path, data)', op: 'files.folder', needs: 'permissions.files (one folder the person picks, until taken back)', status: 'available' },
  { call: 'apex.files.list(path)', op: 'files.list', needs: 'permissions.files and a picked folder', status: 'available' },
  { call: 'apex.files.read(path)', op: 'files.read', needs: 'permissions.files and a picked folder', status: 'available' },
  { call: 'apex.files.write(path, data)', op: 'files.write', needs: 'permissions.files and a picked folder', status: 'available' },
  { call: 'apex.files.own({ accept, multiple, folder, note }) / apex.files.ownUrl(path)', op: 'files.own', needs: 'permissions.files (copies stay on this computer, never in the pack)', status: 'available' },
  { call: 'apex.world.context() → { world, place, cast } or null', op: 'world.context', needs: '– (an app opened from a world’s place; the cast are the residents there)', status: 'available' },
  { call: 'apex.worlds.list()', op: 'worlds.list', needs: 'permissions.worlds (the world viewer)', status: 'available' },
  { call: 'apex.worlds.get(ref) → { world, residents }', op: 'worlds.get', needs: 'permissions.worlds', status: 'available' },
  { call: 'apex.worlds.save(world)', op: 'worlds.save', needs: 'permissions.worlds (your own worlds; a pack’s world is saved as a copy)', status: 'available' },
  { call: 'apex.worlds.remove(ref)', op: 'worlds.remove', needs: 'permissions.worlds', status: 'available' },
  { call: 'apex.worlds.apps()', op: 'worlds.apps', needs: 'permissions.worlds (the apps a place can open)', status: 'available' },
  { call: 'apex.worlds.enter(ref, placeId)', op: 'worlds.enter', needs: 'permissions.worlds (opens the place’s app with its residents as the cast)', status: 'available' },
  { call: 'apex.worlds.speak(ref, residentId, { situation })', op: 'worlds.speak', needs: 'permissions.worlds, model and speak', status: 'available' },
  { call: 'apex.worlds.find(packId)', op: 'worlds.find', needs: 'permissions.worlds (opens Browse at a pack a place opens and the person lacks)', status: 'available' },
  { call: 'apex.worlds.share(ref)', op: 'worlds.share', needs: 'permissions.worlds (saves an .apexworld; your companions become open spots)', status: 'available' },
  { call: 'apex.rooms.create / join', op: 'rooms.create', needs: 'permissions.rooms', status: 'planned' },
  { call: 'apex.pad.pair / on / vibrate', op: 'pad.pair', needs: 'permissions.rooms and the app’s pad', status: 'planned' },
  { call: 'apex.connectors.status() → { ref: { connected, name } }', op: 'connectors.status', needs: 'permissions.connectors', status: 'available' },
  { call: 'apex.connectors.tools(ref) → [{ name, title, description, readOnly, inputSchema }]', op: 'connectors.tools', needs: 'the connector in permissions.connectors (tools the person turned off are left out)', status: 'available' },
  { call: 'apex.connectors.call(ref, tool, input) → { text, data, isError }', op: 'connectors.call', needs: 'the connector in permissions.connectors; the tool runs as the person set it (off refuses, ask asks them each time)', status: 'available' },
  { call: 'apex.connectors.connect(ref)', op: 'connectors.connect', needs: 'the connector in permissions.connectors; opens Connectors at it so the person can connect it', status: 'available' },
  { call: 'apex.server.start({ lan, root, token, maxConnections }) → { url, lanUrl, port, qr, token }', op: 'server.start', needs: `permissions.server (lan: true in it and in the call for phones and computers on the same Wi-Fi: https with ${BRAND_NAME}’s certificate); an app’s own pages; the server stops when the page closes`, status: 'available' },
  { call: 'apex.server.stop()', op: 'server.stop', needs: 'permissions.server', status: 'available' },
  { call: 'apex.server.status() → { running, url, lanUrl, port, qr, lan, connections }', op: 'server.status', needs: 'permissions.server', status: 'available' },
  { call: 'apex.server.onRequest(async (req) => ({ status, headers, body }))', op: 'server.respond', needs: 'permissions.server (requests no file in root answers: { method, path, query, headers, body, json }; text or JSON back, 2 MB)', status: 'available' },
  { call: 'apex.server.onConnection((socket) => { socket.onMessage(fn); socket.onClose(fn); socket.send(data) }) / apex.server.broadcast(data)', op: 'server.send', needs: 'permissions.server (served pages connect to __apex/socket, or use __apex/client.js; text messages, 16 KB in, 64 KB out)', status: 'available' },
  { call: 'socket.close(code)', op: 'server.close', needs: 'permissions.server', status: 'available' },
  { call: 'apex.env, secrets and sign-ins set by an organisation’s AppConfig policy', op: null, needs: '– (managed packs)', status: 'available' },
]

/** A place in Apex that packs fill (docs/apps.md › Surfaces), for apex_inspect. */
export interface PackSurfaceEntry {
  id: string
  cardinality: 'list' | 'single' | 'keyed'
  entry: string
  /** How a manifest fills it today, or what will. */
  via: string
  status: 'available' | 'planned'
}

export const PACK_SURFACES: readonly PackSurfaceEntry[] = [
  { id: 'tab', cardinality: 'list', entry: 'hosted: an app or panel in a tab', via: 'contributes.apps, contributes.panels', status: 'available' },
  { id: 'beside', cardinality: 'list', entry: 'hosted: a panel beside the page in split view', via: 'contributes.panels', status: 'available' },
  { id: 'sidebar', cardinality: 'list', entry: 'drawn: a row with icon, title and status', via: 'sidebar: true on an app or panel; apex.status.set', status: 'available' },
  { id: 'newtab.cards', cardinality: 'list', entry: 'drawn: up to five lines from a module', via: 'contributes.cards', status: 'available' },
  { id: 'commands', cardinality: 'list', entry: 'drawn: command bar rows (Open <app> for every app)', via: 'contributes.commands', status: 'available' },
  { id: 'page.menu', cardinality: 'list', entry: 'drawn: page, selection and link menu items', via: 'contributes.menus', status: 'available' },
  { id: 'status', cardinality: 'keyed', entry: 'drawn: an app’s text, badge or progress on its row', via: 'apex.status.set', status: 'available' },
  { id: 'newtab.page', cardinality: 'single', entry: 'hosted: the new tab page, when the person picks it', via: 'planned', status: 'planned' },
  { id: 'share', cardinality: 'list', entry: 'drawn: Send to <app> for a page, selection, link or file', via: 'planned', status: 'planned' },
  { id: 'open.with', cardinality: 'keyed', entry: 'drawn: Open with <app> for a file type', via: 'planned', status: 'planned' },
  { id: 'chat.cards', cardinality: 'list', entry: 'drawn: a card in a chat from structured data', via: 'planned', status: 'planned' },
  { id: 'float', cardinality: 'list', entry: 'hosted: a small always-on-top window', via: 'planned', status: 'planned' },
  { id: 'settings', cardinality: 'list', entry: 'hosted: the app’s own section in Settings › Apps', via: 'planned', status: 'planned' },
  { id: 'app.assets', cardinality: 'single', entry: 'drawn: which asset pack fills one of an app’s slots', via: 'assets on an app; contributes.assets in an asset pack', status: 'available' },
  { id: 'world.places', cardinality: 'list', entry: 'drawn: a place in a world that opens an app', via: 'contributes.worlds (places with opens); apex.world.context() in the app', status: 'available' },
]

/** Whether a required version is met: `1.2.0` and `>=1.2.0` both mean that version or newer. */
export function packVersionMeets(have: string, want: string): boolean {
  return comparePackVersions(have, want.replace(/^>=/, '')) >= 0
}

export interface PackForkedFrom {
  id: string
  version: string
  hash: string
}

export interface PackManifest {
  format: typeof PACK_FORMAT
  manifestVersion: number
  id: string
  name: string
  version: string
  description: string
  author?: { name: string }
  /** The companion that built it, by name (shown, never trusted). */
  builtBy?: string
  homepage?: string
  updateUrl?: string
  forkedFrom?: PackForkedFrom
  contributes: PackContributions
  permissions: PackPermissions
  /** What it may ask for while it runs, one feature at a time (manifest version 2). */
  optionalPermissions?: PackOptionalPermissions
  /** Services it offers to other packs (manifest version 2). */
  provides?: PackService[]
  /** Services it uses, from other packs or Apex; it waits until they are there. */
  uses?: string[]
  events?: PackEvents
  requires?: PackRequires
  /** Keys the person enters, which Apex adds to requests to their hosts (manifest version 2). */
  secrets?: PackSecret[]
  /** Public settings the pack's pages read as apex.env (manifest version 2); a linked folder's .env overrides them while you develop. */
  env?: Record<string, string>
  /** Sign-ins Apex runs for the pack's apps, whose access tokens go to their hosts (manifest version 2). */
  auth?: PackAuth[]
}

// ---- paths, hosts and names ----

/** Whether a manifest path is a safe relative file path inside the pack (not under __apex/). */
export function isPackPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) return false
  const parts = path.split('/')
  if (parts[0] === PACK_RESERVED_DIR) return false
  return parts.every((p) => SEGMENT.test(p) && !/^\.+$/.test(p))
}

/**
 * One segment of a file inside an app's folder. Games and build tools name
 * assets with spaces and punctuation ("bangers & mash.png"), so these allow
 * more than manifest paths do, but never a character Windows or macOS refuse,
 * nothing that changes what an address means (# % ?), no leading or trailing
 * space, no trailing dot and no Windows device name.
 */
const ASSET_SEGMENT = /^[A-Za-z0-9._\-+=,!@&'()[\]~ ]{1,120}$/
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Whether a path is a safe file path for a file inside an app's folder (docs/apps.md). */
export function isPackAssetPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 400) return false
  const parts = path.split('/')
  if (parts[0] === PACK_RESERVED_DIR) return false
  return parts.every((p) => ASSET_SEGMENT.test(p) && !/^\.+$/.test(p) && p.trim() === p && !p.endsWith('.') && !WINDOWS_DEVICE.test(p))
}

/** Whether a file may be in a pack at this path: a manifest-style path, or an asset path inside one of these app folders. */
export function isPackFilePath(path: string, appRoots: readonly string[] = []): boolean {
  if (isPackPath(path)) return true
  return appRoots.some((r) => path.startsWith(`${r}/`)) && isPackAssetPath(path)
}

/** The asset sets' folders an unchecked manifest names, for the path rules before it is checked. */
export function manifestAssetRoots(raw: unknown): string[] {
  if (!manifestHasAssets(raw)) return []
  const sets = (raw as { contributes: { assets: unknown[] } }).contributes.assets
  return sets.flatMap((a) => (a && typeof a === 'object' && typeof (a as { root?: unknown }).root === 'string' && isPackPath((a as { root: string }).root) ? [(a as { root: string }).root] : []))
}

/** The app folders an unchecked manifest names (each defaults to "app"), for the path rules before it is checked. */
export function manifestAppRoots(raw: unknown, which: 'all' | 'bundled' = 'all'): string[] {
  if (!manifestHasApps(raw)) return []
  const apps = (raw as { contributes: { apps: unknown[] } }).contributes.apps
  return apps.flatMap((a) => {
    if (!a || typeof a !== 'object') return []
    if (which === 'bundled' && (a as { build?: unknown }).build !== 'bundled') return []
    const root = (a as { root?: unknown }).root ?? 'app'
    return typeof root === 'string' && isPackPath(root) ? [root] : []
  })
}

/**
 * The prefix of a pack's tool names. Pack ids have no underscores and tool
 * names no dashes, so the first underscore after `pk_` always ends the id and
 * no two packs' tools share a name.
 */
/** What every pack tool's name starts with, as the agent sees it. */
export const PACK_TOOL_NAME_PREFIX = 'pk_'

export function packToolPrefix(packId: string): string {
  return `${PACK_TOOL_NAME_PREFIX}${packId}_`
}

/** The name the agent sees for a pack's tool. */
export function packToolName(packId: string, tool: string): string {
  return `${packToolPrefix(packId)}${tool}`
}

/** `sites: ["*"]`: every web site (never sign-in pages). Not allowed in `network` or a tweak's `match`. */
export const ALL_SITES = '*'

/** A site or network entry in its stored shape (`*.` kept), or null when it isn't a host. */
export function normalizePackHost(entry: string): string | null {
  const text = entry.trim().toLowerCase()
  if (text === ALL_SITES) return ALL_SITES
  const wildcard = text.startsWith('*.')
  const host = normalizeTweakHost(wildcard ? text.slice(2) : text)
  if (!host || host.startsWith('[')) return null
  // A wildcard needs a registrable name under it: no `*.com`.
  if (wildcard && !host.includes('.')) return null
  return wildcard ? `*.${host}` : host
}

/** Whether a host pattern from `sites` or `network` covers a host. */
export function packHostMatches(pattern: string, host: string): boolean {
  const h = normalizeTweakHost(host)
  if (!h) return false
  if (pattern === ALL_SITES) return true
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return h === base || h.endsWith(`.${base}`)
  }
  return h === pattern
}

export function packCoversHost(patterns: readonly string[], host: string): boolean {
  return patterns.some((p) => packHostMatches(p, host))
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Whether apex.fetch may reach this address under a pack's `network` list. */
export function packFetchAllowed(network: readonly string[], url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === 'http:') return LOCAL_HOSTS.has(host) && packCoversHost(network, host)
  if (parsed.protocol !== 'https:') return false
  return packCoversHost(network, host)
}

/**
 * Whether an app's page may connect straight to this address (fetch,
 * WebSocket, EventSource, images and media) under the hosts it may reach now:
 * https and wss, or http and ws on localhost and 127.0.0.1.
 */
export function packDirectAllowed(network: readonly string[], url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') return LOCAL_HOSTS.has(host) && packCoversHost(network, host)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return false
  return packCoversHost(network, host)
}

/** Whether a host is this computer (a pack in developer mode may reach it without listing it). */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase())
}

export type PackRunKind = 'skill' | 'panel' | 'app' | 'tool'

/** Whether a `run` names something the pack has. */
export function parsePackRun(run: string): { kind: PackRunKind; target: string } | null {
  const m = /^(skill|panel|app|tool):([a-z0-9][a-z0-9_-]{0,63})$/.exec(run)
  return m ? { kind: m[1] as PackRunKind, target: m[2] as string } : null
}

/** Compares two major.minor.patch versions: negative when a is older. */
export function comparePackVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The next patch version, for a companion's new draft of an installed pack. */
export function bumpPackVersion(version: string): string {
  const [a, b, c] = version.split('.').map(Number)
  return `${a ?? 0}.${b ?? 0}.${(c ?? 0) + 1}`
}

/** apex-pack://<id>/<path>. */
export function packUrl(packId: string, path = ''): string {
  return `${PACK_SCHEME}://${packId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** The pack and path an apex-pack address names, or null. */
export function parsePackUrl(url: string): { packId: string; path: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PACK_SCHEME}:`) return null
  const packId = parsed.hostname
  if (!PACK_ID_PATTERN.test(packId)) return null
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  return { packId, path: path || 'index.html' }
}

// ---- permissions in plain words ----

export type PackPermissionLevel = 'info' | 'notice' | 'warning' | 'danger'
const LEVEL_RANK: Record<PackPermissionLevel, number> = { info: 0, notice: 1, warning: 2, danger: 3 }

/** One atomic thing a pack is allowed: what a diff compares. */
export interface PackGrant {
  id: string
  kind: PackGrantKind
  level: PackPermissionLevel
  /** The host, tool, connector or command it is about; '' for pack-wide grants. */
  subject: string
}

export type PackGrantKind =
  | 'skills'
  | 'routines'
  | 'themes'
  | 'companions'
  | 'commands'
  | 'panels'
  | 'apps'
  /** A bundled app: built code the review can't show (the sandbox still holds it to the other lines). */
  | 'bundled'
  /** Asset sets that change how another pack's app looks or sounds. */
  | 'assets'
  /** An app whose scripts may run code they make (eval). */
  | 'eval'
  /** apex.files. */
  | 'files'
  /** The person's companions as characters, and their lines. */
  | 'cast'
  | 'speak'
  | 'cards'
  /** Services it offers other packs; `agentService`, the ones it offers companions too. */
  | 'provides'
  | 'agentService'
  /** Services it uses from other packs. */
  | 'uses'
  /** Other packs it needs. */
  | 'requires'
  /** Other packs' events it hears. */
  | 'listens'
  /** Permissions it may ask for later (apex.permissions.request). */
  | 'optional'
  /** Keys the person enters, which Apex sends to their hosts. */
  | 'secrets'
  /** Sign-ins Apex runs, whose tokens go to their hosts. */
  | 'signIn'
  /** The person's connectors its apps use (apex.connectors). */
  | 'usesConnectors'
  /** World files it adds. */
  | 'worlds'
  /** apex.worlds: your worlds, read, changed and opened. */
  | 'worldAccess'
  /** apex.server: a web server of its own, on this computer (subject '') or on the Wi-Fi too (subject 'lan'). */
  | 'server'
  | 'styles'
  | 'notifications'
  | 'clipboard'
  | 'read'
  | 'network'
  | 'model'
  | 'tools'
  | 'connector'
  | 'scripts'
  | 'exfil'
  | 'localConnector'
  /** An update changes what a skill or tool tells the assistant (service.ts adds it; no manifest grant). */
  | 'prompts'

/** One line on the install card. */
export interface PackPermissionLine {
  kind: PackGrantKind
  level: PackPermissionLevel
  key: MessageKey
  vars: Record<string, string | number>
}

const KEYS: Record<PackGrantKind, MessageKey> = {
  skills: 'packs.perm.skills',
  routines: 'packs.perm.routines',
  themes: 'packs.perm.themes',
  companions: 'packs.perm.companions',
  commands: 'packs.perm.commands',
  panels: 'packs.perm.panels',
  apps: 'packs.perm.apps',
  bundled: 'packs.perm.bundled',
  eval: 'packs.perm.eval',
  files: 'packs.perm.files',
  cast: 'packs.perm.cast',
  speak: 'packs.perm.speak',
  assets: 'packs.perm.assets',
  provides: 'packs.perm.provides',
  agentService: 'packs.perm.agentService',
  uses: 'packs.perm.uses',
  requires: 'packs.perm.requires',
  listens: 'packs.perm.listens',
  optional: 'packs.perm.optional',
  secrets: 'packs.perm.secrets',
  signIn: 'packs.perm.signIn',
  usesConnectors: 'packs.perm.usesConnectors',
  worlds: 'packs.perm.worlds',
  worldAccess: 'packs.perm.worldAccess',
  server: 'packs.perm.server',
  cards: 'packs.perm.cards',
  styles: 'packs.perm.styles',
  notifications: 'packs.perm.notifications',
  clipboard: 'packs.perm.clipboard',
  read: 'packs.perm.read',
  network: 'packs.perm.network',
  model: 'packs.perm.model',
  tools: 'packs.perm.tools',
  connector: 'packs.perm.connector',
  scripts: 'packs.perm.scripts',
  exfil: 'packs.perm.exfil',
  localConnector: 'packs.perm.localConnector',
  prompts: 'packs.perm.promptsChanged',
}

const ORDER: PackGrantKind[] = ['exfil', 'localConnector', 'scripts', 'read', 'network', 'server', 'secrets', 'signIn', 'tools', 'model', 'usesConnectors', 'connector', 'prompts', 'agentService', 'speak', 'uses', 'eval', 'bundled', 'styles', 'notifications', 'clipboard', 'files', 'worldAccess', 'cast', 'apps', 'worlds', 'assets', 'skills', 'routines', 'companions', 'themes', 'panels', 'cards', 'commands', 'provides', 'requires', 'listens', 'optional']

/** Whether a pack has code that can call the bridge: a panel, an app, a tool or a new-tab card. */
export function packHasCode(m: Pick<PackManifest, 'contributes'>): boolean {
  const c = m.contributes
  return (c.panels?.length ?? 0) > 0 || (c.apps?.length ?? 0) > 0 || (c.tools?.length ?? 0) > 0 || (c.cards?.length ?? 0) > 0
}

function tweakHosts(tweaks: readonly PackTweak[], withJs: boolean): string[] {
  const out = new Set<string>()
  for (const b of tweaks) {
    if (withJs && !b.js) continue
    for (const h of b.match) out.add(b.subdomains ? `*.${h}` : h)
  }
  return [...out]
}

/** What of a manifest its grants read. */
export type PackGrantManifest = Pick<PackManifest, 'contributes' | 'permissions' | 'provides' | 'uses' | 'events' | 'requires' | 'optionalPermissions'> & Partial<Pick<PackManifest, 'secrets' | 'auth'>>

/** Every atomic grant a manifest asks for. */
export function packGrants(m: PackGrantManifest): PackGrant[] {
  const c = m.contributes
  const p = m.permissions
  const grants: PackGrant[] = []
  const add = (kind: PackGrantKind, level: PackPermissionLevel, subject = ''): void => {
    grants.push({ id: subject ? `${kind}:${subject}` : kind, kind, level, subject })
  }
  const count = (kind: PackGrantKind, n: number | undefined): void => {
    if (n) add(kind, 'info')
  }
  count('skills', c.skills?.length)
  count('routines', c.routines?.length)
  count('themes', c.themes?.length)
  count('companions', c.companions?.length)
  count('panels', c.panels?.length)
  for (const set of c.assets ?? []) add('assets', 'info', set.for.pack)
  for (const a of c.apps ?? []) {
    add('apps', 'info', a.id)
    if (a.build === 'bundled') add('bundled', 'notice', a.id)
    if (a.eval) add('eval', 'notice', a.id)
  }
  count('cards', c.cards?.length)
  count('worlds', c.worlds?.length)
  count('commands', (c.commands?.length ?? 0) + (c.menus?.length ?? 0))
  const tweaks = c.tweaks ?? []
  for (const h of tweakHosts(tweaks, false)) add('styles', 'notice', h)
  if (p.notifications) add('notifications', 'notice')
  if (p.clipboard) add('clipboard', 'notice')
  if (p.files) add('files', 'notice')
  if (p.worlds) add('worldAccess', 'notice')
  // Only an app's own pages start a server; on the Wi-Fi it is a grant of its own, so an update that adds lan asks again.
  if (p.server && (c.apps?.length ?? 0) > 0) {
    add('server', 'notice')
    if (p.server.lan) add('server', 'warning', 'lan')
  }
  for (const ref of p.connectors ?? []) add('usesConnectors', 'warning', ref)
  for (const a of c.apps ?? []) if (a.cast) add('cast', 'info', a.id)
  if (p.speak && p.model) add('speak', 'warning')
  const code = packHasCode(m)
  if (code) for (const h of p.sites) add('read', 'warning', h)
  if (code) for (const h of p.network) add('network', 'warning', h)
  if (code && p.model) add('model', 'warning')
  // The hosts are part of the grant: an update that sends a key somewhere new asks again.
  for (const secret of m.secrets ?? []) add('secrets', 'notice', `${secret.id}>${secret.hosts.join(',')}`)
  // Likewise a sign-in: a new issuer or a new host for its token asks again.
  for (const a of m.auth ?? []) add('signIn', 'notice', `${a.id}>${a.issuer}>${a.hosts.join(',')}`)
  for (const t of c.tools ?? []) add('tools', 'warning', t.name)
  for (const conn of c.connectors ?? []) {
    if (conn.command) add('localConnector', 'danger', [conn.command, ...(conn.args ?? [])].join(' '))
    else if (conn.url) add('connector', 'warning', conn.url)
  }
  if (p.pageScripts) for (const h of tweakHosts(tweaks, true)) add('scripts', 'danger', h)
  if (code && p.sites.length > 0 && p.network.length > 0) add('exfil', 'danger')
  for (const svc of m.provides ?? []) {
    add('provides', 'info', svc.service)
    if (svc.agent) add('agentService', 'notice', svc.service)
  }
  for (const name of m.uses ?? []) add('uses', 'notice', name)
  for (const id of Object.keys(m.requires?.packs ?? {})) add('requires', 'info', id)
  for (const name of m.events?.on ?? []) if (!name.startsWith('apex.')) add('listens', 'info', name)
  const o = m.optionalPermissions
  if (o) for (const part of [...(o.sites ?? []).map((h) => `site:${h}`), ...(o.network ?? []).map((h) => `network:${h}`), ...(['notifications', 'model', 'clipboard'] as const).filter((k) => o[k] === true)]) add('optional', 'info', part)
  return grants
}

const listOf = (items: readonly string[]): string => (items.length <= 4 ? items.join(', ') : `${items.slice(0, 4).join(', ')} +${items.length - 4}`)

/** How a review names another pack (one an asset pack changes, one a pack needs); main sets it to installed packs' names. */
let packName: (id: string) => string = (id) => id
export function setPackNames(name: (id: string) => string): void {
  packName = name
}

/** How a review names a connector a pack uses; main sets it to the directory's names and the person's own (atlassian → Jira and Confluence). */
let connectorName: (ref: string) => string = (ref) => ref
export function setPackConnectorNames(name: (ref: string) => string): void {
  connectorName = name
}

/** Grants grouped into the lines a person reads, most serious first. */
export function describeGrants(grants: readonly PackGrant[], m: PackGrantManifest): PackPermissionLine[] {
  const lines: PackPermissionLine[] = []
  const c = m.contributes
  for (const kind of ORDER) {
    const of = grants.filter((g) => g.kind === kind)
    if (of.length === 0) continue
    const subjects = of.map((g) => g.subject).filter(Boolean)
    const level = of.reduce<PackPermissionLevel>((a, g) => (LEVEL_RANK[g.level] > LEVEL_RANK[a] ? g.level : a), 'info')
    const key = KEYS[kind]
    if (kind === 'localConnector') {
      for (const s of subjects) lines.push({ kind, level, key, vars: { command: s } })
      continue
    }
    if (kind === 'connector') {
      lines.push({ kind, level, key, vars: { hosts: listOf(subjects.map(hostOf)), count: subjects.length } })
      continue
    }
    const vars: Record<string, string | number> = {}
    if (kind === 'skills') vars.count = c.skills?.length ?? 0
    else if (kind === 'routines') vars.count = c.routines?.length ?? 0
    else if (kind === 'themes') vars.count = c.themes?.length ?? 0
    else if (kind === 'companions') vars.count = c.companions?.length ?? 0
    else if (kind === 'panels') vars.count = c.panels?.length ?? 0
    else if (kind === 'optional') vars.count = subjects.length
    else if (kind === 'provides' || kind === 'agentService' || kind === 'uses' || kind === 'requires' || kind === 'listens') {
      vars.count = subjects.length
      vars.names = listOf(subjects)
    } else if (kind === 'assets') {
      vars.count = subjects.length
      vars.names = listOf([...new Set(subjects)].map((id) => packName(id)))
    } else if (kind === 'apps' || kind === 'bundled' || kind === 'eval' || kind === 'cast') {
      vars.count = subjects.length
      vars.names = listOf(subjects.map((id) => c.apps?.find((a) => a.id === id)?.name ?? id))
    } else if (kind === 'secrets') {
      const ids = new Set(subjects.map((s) => s.split('>')[0]))
      const list = (m.secrets ?? []).filter((s) => ids.has(s.id))
      vars.count = list.length
      vars.names = listOf(list.map((s) => s.name))
      vars.hosts = listOf([...new Set(list.flatMap((s) => s.hosts))])
    } else if (kind === 'usesConnectors') {
      vars.count = subjects.length
      vars.names = listOf(subjects.map((ref) => connectorName(ref)))
    } else if (kind === 'signIn') {
      const ids = new Set(subjects.map((s) => s.split('>')[0]))
      const list = (m.auth ?? []).filter((a) => ids.has(a.id))
      const hostOf = (url: string): string => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      }
      vars.count = list.length
      vars.names = listOf(list.map((a) => a.name))
      vars.issuers = listOf([...new Set(list.map((a) => hostOf(a.issuer)))])
      vars.hosts = listOf([...new Set(list.flatMap((a) => a.hosts))])
    } else if (kind === 'cards') vars.count = c.cards?.length ?? 0
    else if (kind === 'worlds') vars.count = c.worlds?.length ?? 0
    else if (kind === 'commands') vars.count = (c.commands?.length ?? 0) + (c.menus?.length ?? 0)
    else if (kind === 'tools') {
      vars.count = subjects.length
      vars.names = listOf(subjects)
    } else if (kind === 'exfil') {
      vars.sites = listOf(m.permissions.sites)
      vars.hosts = listOf(m.permissions.network)
    } else if (subjects.length > 0) {
      vars.sites = listOf(subjects)
      vars.count = subjects.length
    }
    if (kind === 'server') {
      lines.push({ kind, level, key: subjects.includes('lan') ? 'packs.perm.serverLan' : key, vars: {} })
      continue
    }
    if (kind === 'read' && subjects.includes(ALL_SITES)) {
      lines.push({ kind, level, key: 'packs.perm.readAll', vars: {} })
      continue
    }
    if (kind === 'exfil' && m.permissions.sites.includes(ALL_SITES)) {
      lines.push({ kind, level, key: 'packs.perm.exfilAll', vars: { hosts: listOf(m.permissions.network) } })
      continue
    }
    lines.push({ kind, level, key, vars })
  }
  return lines
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function describePackPermissions(m: PackGrantManifest): PackPermissionLine[] {
  return describeGrants(packGrants(m), m)
}

/**
 * What an update adds that needs approval: grants above info level that the
 * installed version doesn't have. Empty means the update can apply on its own.
 */
export function permissionDiff(before: PackGrantManifest | null, after: PackGrantManifest): PackPermissionLine[] {
  const had = new Set(before ? packGrants(before).map((g) => g.id) : [])
  const added = packGrants(after).filter((g) => g.level !== 'info' && !had.has(g.id))
  return describeGrants(added, after)
}

/** The line an update gets when it changes what its skills, tools or companions tell the assistant. */
export function promptsChangedLine(): PackPermissionLine {
  return { kind: 'prompts', level: 'notice', key: KEYS.prompts, vars: {} }
}

/**
 * A pack's CSS as it goes into a page: a tweak's own sanitising, then nothing
 * that loads from elsewhere (url() and image-set() other than data:, which a
 * selector could use to send what's on the page out), so CSS stays a look.
 */
export function packSafeCss(css: string): string {
  return css
    .replace(/@import\b[^;{}]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?\s*data:)[^)]*\)/gi, 'none')
    .replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)/gi, (m) => (/(['"])\s*(?!data:)[a-z]+:|['"]\s*\/\//i.test(m) ? 'none' : m))
}

export function highestLevel(lines: readonly PackPermissionLine[]): PackPermissionLevel {
  return lines.reduce<PackPermissionLevel>((a, l) => (LEVEL_RANK[l.level] > LEVEL_RANK[a] ? l.level : a), 'info')
}

// ---- installed packs, drafts and reviews ----

/** `dev`: a folder loaded in developer mode (docs/apps.md › Freedom); its `url` is the folder's path. */
export type PackSourceKind = 'file' | 'link' | 'index' | 'draft' | 'first-party' | 'dev'

export interface PackSource {
  kind: PackSourceKind
  /** The link or index address it came from. */
  url?: string
}

/** 'signed' by an author key, 'unsigned', or shipped with Apex. */
export type PackSignatureState = 'signed' | 'unsigned' | 'first-party'

export interface PackContributionCounts {
  skills: number
  routines: number
  tweaks: number
  themes: number
  companions: number
  connectors: number
  panels: number
  apps: number
  assets: number
  commands: number
  menus: number
  tools: number
  cards: number
  worlds: number
}

export interface PackUpdateInfo {
  version: string
  url: string
  /** Lines the update adds; non-empty means it waits for your approval. */
  added: PackPermissionLine[]
}

export interface PackSummary {
  id: string
  name: string
  version: string
  description: string
  author: string | null
  builtBy: string | null
  homepage: string | null
  enabled: boolean
  source: PackSource
  installedAt: number
  updatedAt: number
  hash: string
  signature: PackSignatureState
  /** The author key's short fingerprint. */
  keyId: string | null
  counts: PackContributionCounts
  permissions: PackPermissionLine[]
  /** Contributions that couldn't load (a skill name already taken, a file that went missing). */
  problems: string[]
  update: PackUpdateInfo | null
  forkedFrom: PackForkedFrom | null
  panels: Array<{ id: string; title: string; sidebar: boolean }>
  apps: Array<{ id: string; name: string; kind: PackAppKind; build: PackAppBuild; sidebar: boolean }>
  /** Its apps' asset slots, with what fills each now and what could. */
  assetSlots: Array<{ appId: string; appName: string; slot: string; name: string; description: string; chosen: string | null; options: Array<{ value: string; label: string }> }>
  /** Why a pack that is on isn't running yet: the services or packs it needs (docs/apps.md › Services). */
  waiting: string[]
  /** The folder it may read and write (apex.files.folder), and the size of the person's own files it keeps. */
  folder: string | null
  ownBytes: number
  /** What it may ask for later, not granted yet; and what the person granted of it. */
  optional: PackPermissionLine[]
  granted: PackPermissionLine[]
  provides: Array<{ service: string; description: string; agent: boolean; usedBy: string[] }>
  uses: Array<{ service: string; from: string | null }>
  /** Installed by the organisation's policy: it stays on and can't be removed. */
  managed: boolean
  /** Packs it waits for that aren't installed or on, by id (for Find in Browse). */
  waitingFor: string[]
  /** Set when an index it came from (or any index) lists it as withdrawn: it keeps working, with no updates offered. */
  withdrawn: { index: string; reason: string | null } | null
  /** The worlds it brings (docs/apps.md › Worlds). */
  worlds: Array<{ ref: string; name: string }>
  /** The keys it asks for, where each goes, and whether it has a value (never the value). */
  secrets: Array<{ id: string; name: string; description: string | null; hosts: string[]; state: PackSecretState }>
  /** The sign-ins its apps use, where each token goes, and who is signed in; `managed` when the organisation set the issuer or client. */
  signIns: Array<{ id: string; name: string; issuer: string; hosts: string[]; signedIn: boolean; user: string | null; managed: boolean }>
  /** The person's connectors its apps use, and whether each is connected here. */
  connectorsUsed: Array<{ ref: string; name: string | null; connected: boolean }>
  cards: Array<{ id: string; title: string }>
  routines: Array<{ id: string; name: string }>
  companions: Array<{ path: string; name: string }>
  connectors: Array<{ id: string; name: string; local: boolean }>
  themes: Array<{ id: string; name: string; accent: string }>
}

export interface PackFileInfo {
  path: string
  size: number
}

export interface PackLogLine {
  at: number
  level: 'info' | 'warn' | 'error'
  /** Where it came from: a tool, a panel, the bridge, Apex. */
  source: string
  message: string
}

export interface PackDetail extends PackSummary {
  manifest: PackManifest
  files: PackFileInfo[]
  log: PackLogLine[]
}

export interface PackDraftSummary {
  id: string
  name: string
  version: string
  description: string
  updatedAt: number
  builtBy: string | null
  /** What validatePack found; a draft with problems can't be installed. */
  problems: string[]
  permissions: PackPermissionLine[]
  /** The installed version of the same id, if any. */
  installedVersion: string | null
  /** Whether what is installed is exactly this draft. */
  installedSame: boolean
}

export interface PackReview {
  token: string
  id: string
  name: string
  version: string
  description: string
  author: string | null
  builtBy: string | null
  source: PackSource
  signature: PackSignatureState
  keyId: string | null
  /** Signed with a key the organisation's policy trusts (PackTrustedKeys). */
  organisationKey: boolean
  counts: PackContributionCounts
  permissions: PackPermissionLine[]
  /** For an update or reinstall: the version it replaces and the lines it adds. */
  replaces: { version: string; added: PackPermissionLine[] } | null
  /** Reasons it can't be installed; empty when it can. */
  problems: string[]
  files: PackFileInfo[]
  /** The readable text of every code file, so the card can show what runs. */
  code: Array<{ path: string; text: string }>
  /** What it tells the assistant: each skill's instructions, each tool's description, and each companion's standing instructions, skills and routine prompts. */
  prompts: Array<{ kind: 'skill' | 'tool' | 'companion'; name: string; text: string }>
  /** What Share… put beside the files: a note and a PNG data URL. Not signed, so the card says who it's from only as "whoever shared it". */
  shared: { note: string | null; image: string | null }
}

/** What Share… adds to an export: a note, and a share image as a PNG data URL. */
export interface PackShareInput {
  note?: string
  image?: string
}

export interface PackIndexSource {
  url: string
  name: string | null
  addedAt: number
  lastError: string | null
  /** A private index (the organisation's policy): who is signed in to it, if anyone. Browse can't read it before. */
  signIn?: { issuer: string; signedIn: boolean; user: string | null } | null
}

export interface PackIndexEntry {
  indexUrl: string
  id: string
  name: string
  description: string
  version: string
  url: string
  sha256: string
  author: string | null
  installedVersion: string | null
  kind: PackIndexKind
  category: PackIndexCategory | null
  /** The archive's size in bytes, when the index says. */
  size: number | null
  /** The colour its card is washed in, #rrggbb. */
  color: string | null
  /** Whether the index has a picture for it (packs.browseImage fetches it). */
  hasImage: boolean
}

export interface PacksState {
  packs: PackSummary[]
  drafts: PackDraftSummary[]
  indexes: PackIndexSource[]
  /** Your author key's fingerprint, once you have exported a pack. */
  authorKey: string | null
  /** What an organisation's policy changes here (docs/apps.md › Apps for organisations); all false without one. */
  policy: { managed: boolean; sideloading: boolean; indexesLocked: boolean; audit: boolean; aiProvider: boolean }
}

export type PackShareKind = 'skill' | 'tweak' | 'app' | 'companion'

export interface PacksServices {
  packs: {
    state(): PacksState
    get(id: string): PackDetail
    setEnabled(id: string, enabled: boolean): PackSummary
    remove(id: string): void
    /** The review of an .apexpack opened from Finder (apex://packs?opened=<token>), once; null when it's gone. */
    openedReview(token: string): PackReview | null
    /** Picks an .apexpack file; null when cancelled. */
    reviewFile(): Promise<PackReview | null>
    reviewLink(url: string): Promise<PackReview>
    reviewDraft(id: string): PackReview
    reviewIndexEntry(indexUrl: string, id: string): Promise<PackReview>
    reviewUpdate(id: string): Promise<PackReview>
    confirmInstall(token: string): PackSummary
    cancelReview(token: string): void
    /** Saves an .apexpack (.apexapp for a pack with an app) of an installed pack or a draft; with `share`, its note and share image go inside and the image is saved beside it. The path, or null when cancelled. */
    exportPack(id: string, from: 'installed' | 'draft', share?: PackShareInput): Promise<string | null>
    /** A still of an installed app, rendered off-screen in its sandbox (1200×630 PNG data URL), or null when it can't draw. */
    appStill(id: string, appId: string): Promise<string | null>
    /** Copies an installed pack into a draft and opens a chat that edits it; returns the chat id. */
    remix(id: string, companionId?: string): string
    /** A chat whose companion builds a new pack from your description; returns the chat id. */
    startBuild(description: string, companionId?: string): string
    /** Opens a chat whose companion keeps working on a draft; returns the chat id. */
    editDraft(id: string, companionId?: string): string
    removeDraft(id: string): void
    revealDraft(id: string): void
    /** Opens a panel in a tab, or beside the page in front (split view) with `beside`. */
    openPanel(id: string, panelId: string, beside?: boolean): void
    /** Opens an app in a tab (docs/apps.md), or brings its open tab to the front. */
    openApp(id: string, appId: string): void
    /** Opens a world in the world viewer (docs/apps.md › Worlds): `own:<id>` or `pack:<packId>/<path>`. */
    openWorld(ref: string): void
    /** Takes back everything a pack was granted later (apex.permissions.request), and the folder it was given. */
    revokeGranted(id: string): PackSummary
    /** Developer mode: picks a pack folder and reviews it; installing links the folder (no copy) and reloads on every change. Null when cancelled. */
    loadFolder(): Promise<PackReview | null>
    /** Reads a linked folder again now. */
    reloadFolder(id: string): PackSummary
    /** Keeps a key the person entered for one of a pack's secrets (in the system keychain); the next request to its hosts carries it, and an app waiting in apex.secrets.request hears at once. */
    setSecret(id: string, secretId: string, value: string): PackSummary
    /** Forgets a key the person entered; requests go without it from then on. */
    clearSecret(id: string, secretId: string): PackSummary
    /** Runs one of a pack's sign-ins in a tab (the identity provider's page); resolves once it is done, cancelled or failed. */
    signIn(id: string, authId: string): Promise<PackSummary>
    /** Forgets a sign-in's tokens; the app's requests go without one from then on. */
    signOut(id: string, authId: string): PackSummary
    /** Picks what fills one of an app's asset slots: `<pack>/<set>`, or null for the app's own files. The app reloads. */
    chooseAssets(id: string, appId: string, slot: string, choice: string | null): PackSummary
    /** The sidebar's pack rows: panels and apps of packs that are on and asked for one. */
    sidebar(): PackSidebarEntry[]
    /** AP-01: every app and panel of the packs that run, sidebar or not. */
    items(): PackItem[]
    /** The new tab page's pack cards, run (or from a short cache) in each pack's sandbox. */
    cards(): Promise<PackCardView[]>
    /** A card's click: runs its `open`. */
    openCard(id: string, cardId: string): void
    addRoutine(id: string, templateId: string): void
    addCompanion(id: string, path: string): Promise<string>
    /** Adds the connector and returns its id, so its page can open for a token or sign-in. */
    addConnector(id: string, connectorId: string): string
    checkUpdates(): Promise<PackSummary[]>
    addIndex(url: string): Promise<PackIndexSource>
    removeIndex(url: string): void
    browse(): Promise<PackIndexEntry[]>
    /** Signs in to a private index (in a tab of the identity provider), then Browse can read it. */
    signInIndex(url: string): Promise<PacksState>
    /** An index entry's picture as a data URL (fetched by main, capped, PNG or JPEG only), or null. */
    browseImage(indexUrl: string, id: string): Promise<string | null>
    /** Opens Browse at one pack by id: what a world's place opens, when the person doesn't have it. */
    findInBrowse(id: string): void
    clearLog(id: string): void
    /** Saves a pack's log as a file (JSON lines), for the person or their organisation's support; the path, or null when cancelled. */
    saveLog(id: string): Promise<string | null>
    /** Turns a skill, tweak, app or companion into a draft pack; returns the draft's id. */
    shareAs(kind: PackShareKind, itemId: string): string
  }
}

export type PacksEvent = { type: 'packs'; state: PacksState }

/** apex://packs[?pack=<id>[&key=<secret>|&open=<app>]|?draft=<id>[&review=1]|?tab=browse[&find=<text>]|?install=<url>]. */
export function packsPageUrl(target?: { pack?: string; key?: string; open?: string; draft?: string; review?: boolean; tab?: 'installed' | 'drafts' | 'browse'; find?: string; install?: string }): string {
  if (target?.install) return `apex://packs?install=${encodeURIComponent(target.install)}`
  if (target?.draft) return `apex://packs?draft=${encodeURIComponent(target.draft)}${target.review ? '&review=1' : ''}`
  if (target?.pack) return `apex://packs?pack=${encodeURIComponent(target.pack)}${target.key ? `&key=${encodeURIComponent(target.key)}` : ''}${target.open ? `&open=${encodeURIComponent(target.open)}` : ''}`
  if (target?.tab) return `apex://packs?tab=${target.tab}${target.find ? `&find=${encodeURIComponent(target.find)}` : ''}`
  return 'apex://packs'
}

export function emptyCounts(): PackContributionCounts {
  return { skills: 0, routines: 0, tweaks: 0, themes: 0, companions: 0, connectors: 0, panels: 0, apps: 0, assets: 0, commands: 0, menus: 0, tools: 0, cards: 0, worlds: 0 }
}

export function countContributions(c: PackContributions): PackContributionCounts {
  return {
    skills: c.skills?.length ?? 0,
    routines: c.routines?.length ?? 0,
    tweaks: c.tweaks?.length ?? 0,
    themes: c.themes?.length ?? 0,
    companions: c.companions?.length ?? 0,
    connectors: c.connectors?.length ?? 0,
    panels: c.panels?.length ?? 0,
    apps: c.apps?.length ?? 0,
    assets: c.assets?.length ?? 0,
    commands: c.commands?.length ?? 0,
    menus: c.menus?.length ?? 0,
    tools: c.tools?.length ?? 0,
    cards: c.cards?.length ?? 0,
    worlds: c.worlds?.length ?? 0,
  }
}

/** A card module's answer as lines: a string splits on new lines, a list keeps its strings; capped. */
export function cardLines(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split('\n') : Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { lines?: unknown }).lines) ? (value as { lines: unknown[] }).lines : []
  return raw
    .filter((l): l is string | number => typeof l === 'string' || typeof l === 'number')
    .map((l) => String(l).replace(/\s+/g, ' ').trim().slice(0, PACK_CARD_LIMITS.lineChars))
    .filter(Boolean)
    .slice(0, PACK_CARD_LIMITS.lines)
}
