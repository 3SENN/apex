/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for connectors: the directory, custom remote and
// local (stdio) MCP servers, OAuth, per-tool policies and record search.
// The store lives in src/main/connectors/store.ts; services.ts's Connector is
// ConnectorV2 plus the original `url` and `hasToken`, so older callers keep working.

export type ConnectorTransport =
  | { kind: 'remote'; url: string; headerName: string | null }
  | {
    kind: 'local'
    command: string
    args: string[]
    /** Values never leave main; the UI sees whether one is set. Secret values are masked in the UI and logs. */
    env: { name: string; secret: boolean; hasValue: boolean }[]
    cwd: string | null
  }

export type ConnectorAuth = 'none' | 'bearer' | 'api-key' | 'oauth'
export type ConnectorHealth = 'unknown' | 'checking' | 'ok' | 'needs-reconnect' | 'needs-approval' | 'starting' | 'error' | 'stopped'
/** `off` is enforced live for local tools only; remote policy changes apply to new chats. */
export type ToolPolicy = 'ask' | 'allow' | 'off'
export const TOOL_POLICIES: readonly ToolPolicy[] = ['ask', 'allow', 'off']

export interface ConnectorTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  policy: ToolPolicy
  inputSchema: unknown
}

export interface ConnectorV2 {
  id: string
  name: string
  enabled: boolean
  /** A companion id, or 'shared'. */
  owner: string
  displayName: string
  source: 'directory' | 'custom'
  directoryId: string | null
  transport: ConnectorTransport
  auth: ConnectorAuth
  /** 'server': Anthropic's MCP connector calls it; 'local': Apex's own client does (localhost URLs and stdio). */
  execution: 'server' | 'local'
  labelColor: string | null
  /** A runtime favicon data URL, or null for Apex's generic icon. Never a bundled brand logo. */
  logo: string | null
  health: ConnectorHealth
  healthDetail: string | null
  tools: ConnectorTool[]
  toolsCheckedAt: number | null
  settings: Record<string, string>
  accountLabel: string | null
  isDefault: boolean
  hasSecret: boolean
  /** Offers records to # search (CH-08). */
  searchable: boolean
}

/** What `connectors.save` takes; secrets go in, never out. */
export interface ConnectorInputV2 {
  id?: string
  name: string
  displayName?: string
  source?: 'directory' | 'custom'
  directoryId?: string | null
  transport:
    | { kind: 'remote'; url: string; headerName?: string | null }
    | { kind: 'local'; command: string; args: string[]; env: { name: string; value?: string | null; secret: boolean }[]; cwd?: string | null }
  auth: ConnectorAuth
  /** undefined keeps the saved secret, null removes it. */
  secret?: string | null
  enabled: boolean
  owner?: string
  labelColor?: string | null
  /** A custom logo as an image data URL (at most LOGO_MAX_BYTES); undefined keeps it, null removes it. */
  logo?: string | null
  settings?: Record<string, string>
}

export interface DirectoryEntry {
  id: string
  name: string
  /** One line on what it does. */
  description: string
  category: string
  /** The verified official remote MCP endpoint. */
  url: string
  /** 'none' is for public servers that need no sign-in. */
  auth: 'oauth' | 'token' | 'none'
  /** The service's site, for the runtime favicon. */
  site: string
  docsUrl: string
  fields?: { key: string; label: string; placeholder: string }[]
  /** 'google' shows the illustrated Google setup. */
  setup?: 'google'
  /** Scopes the sign-in asks for when the server lists none it needs (Google's). */
  scopes?: string[]
}

export interface ConnectorRecordHit {
  connectorId: string
  uri: string
  title: string
  snippet: string
}

/** A local tool as a chat fixes it at its first message (ChatCapabilities.localTools). */
export interface LocalToolSnapshot {
  connectorId: string
  /** `<connectorSlug>__<toolSlug>`: at most 64 of [a-zA-Z0-9_-]; a 6-character hash suffix on a collision. */
  apiName: string
  toolName: string
  description: string
  inputSchema: unknown
  /** What the approval card's button says ("Create issue"). */
  actionLabel: string
}

export const LOCAL_TOOL_API_NAME = /^[a-zA-Z0-9_-]{1,64}$/
export const DIRECTORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The methods added to the original `connectors` namespace, whose list, save and remove take the v2 shapes. */
export interface ConnectorsServices {
  connectors: {
    directory(): DirectoryEntry[]
    setEnabled(id: string, on: boolean): ConnectorV2
    rename(id: string, name: string): ConnectorV2
    setLabelColor(id: string, color: string | null): ConnectorV2
    setDefault(id: string): ConnectorV2
    setToolPolicy(id: string, tool: string, policy: ToolPolicy): ConnectorV2
    setAllTools(id: string, policy: ToolPolicy): ConnectorV2
    /** Connects and lists the tools again. */
    check(id: string): Promise<ConnectorV2>
    /** Signs in again (OAuth) or restarts a local server. */
    reconnect(id: string): Promise<ConnectorV2>
    connectDirectory(entryId: string, opts?: { token?: string; fields?: Record<string, string> }): Promise<ConnectorV2>
    /** OV-09: you saw the exact command and allowed it; any later change asks again. */
    approveLocalStart(id: string): ConnectorV2
    /** Claude Desktop style mcpServers JSON; nothing it describes starts until approved. */
    parseConfig(json: string): { inputs: ConnectorInputV2[]; errors: { index: number; field: string; message: string }[] }
    search(query: string, connectorIds?: string[]): Promise<ConnectorRecordHit[]>
    readRecord(connectorId: string, uri: string): Promise<{ title: string; text: string }>
    favicon(site: string): Promise<string | null>
    /** A local server's recent stderr lines, secrets masked. */
    logs(id: string): string[]
  }
}

/** apex://connectors?connect=<directoryId>: the directory with that entry's connect banner. */
export function connectorConnectUrl(directoryId: string): string {
  return `apex://connectors?connect=${encodeURIComponent(directoryId)}`
}

/** Who asked to connect (an app's name), from an apex://connectors?connect=… address; null when a plain link did. */
export function connectFromOf(url: string): string | null {
  if (!url.startsWith('apex://connectors')) return null
  const from = new URLSearchParams(url.split('#')[0]?.split('?')[1] ?? '').get('from')?.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return from ? from.slice(0, 60) : null
}

/** The directory id an apex://connectors address asks to connect, or null. */
export function connectRequestOf(url: string): string | null {
  if (!url.startsWith('apex://connectors')) return null
  const query = url.split('#')[0]?.split('?')[1]
  if (!query) return null
  const id = new URLSearchParams(query).get('connect')
  return id && DIRECTORY_ID.test(id) ? id : null
}

// Shared by main's store and the renderer's forms

/** Apex's own directory categories, in display order. */
export const CONNECTOR_CATEGORIES = ['work', 'mail-calendar', 'code', 'design', 'sales-support', 'finance', 'data', 'web'] as const
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number]

/** Label colours a connector can carry (data, like profile hues; the UI mixes them with tokens). */
export const CONNECTOR_SWATCHES = ['#d9534f', '#e8833a', '#d4a72c', '#4f9d5b', '#2f9e9e', '#3f7fd9', '#7a5cd6', '#c2569b', '#7d7d7d'] as const

/** A custom logo is an image file of at most 256 KB, kept as a data URL. */
export const LOGO_MAX_BYTES = 256 * 1024
export const LOGO_DATA_URL = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/

/** apex://connectors/<id>: one connector's detail page. */
export function connectorDetailUrl(id: string): string {
  return `apex://connectors/${encodeURIComponent(id)}`
}

/** localhost, loopback, private and link-local ranges, and names that only resolve on this network. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  if (!host.includes('.') && !host.includes(':')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0
  }
  if (host.includes(':')) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  return false
}

export type UrlProblem = 'invalid' | 'scheme' | 'insecure' | 'credentials' | 'too-long'

/** The remote URL rules: https anywhere; plain http only for localhost and private addresses. */
export function checkConnectorUrl(raw: string): { ok: true; href: string; private: boolean } | { ok: false; problem: UrlProblem } {
  const text = raw.trim()
  if (text.length > 2048) return { ok: false, problem: 'too-long' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, problem: 'invalid' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, problem: 'scheme' }
  if (url.username || url.password) return { ok: false, problem: 'credentials' }
  const priv = isPrivateHost(url.hostname)
  if (url.protocol === 'http:' && !priv) return { ok: false, problem: 'insecure' }
  return { ok: true, href: url.href, private: priv }
}

/**
 * Where a connector runs. Anthropic's MCP connector reaches only public https
 * servers with a Bearer token, so anything private, with a custom header or
 * started from a command runs through Apex's own client instead.
 */
export function executionOf(transport: ConnectorInputV2['transport'] | ConnectorTransport, auth: ConnectorAuth): 'server' | 'local' {
  if (transport.kind === 'local') return 'local'
  const check = checkConnectorUrl(transport.url)
  if (!check.ok || check.private) return 'local'
  if (transport.headerName) return 'local'
  return auth === 'api-key' ? 'local' : 'server'
}

/** create_issue → "Create issue"; listRepos → "List repos". */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) return name
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What a confirm button says for a tool: its annotated title, or its humanized name. */
export function actionLabelOf(tool: { name: string; title?: string | null }): string {
  const title = tool.title?.trim()
  return title && title !== tool.name ? title.slice(0, 60) : humanizeToolName(tool.name).slice(0, 60)
}

/** The policies a tool may take: ask-first only for locally run tools, since server-side calls never pause. */
export function policiesFor(execution: 'server' | 'local'): readonly ToolPolicy[] {
  return execution === 'local' ? TOOL_POLICIES : ['allow', 'off']
}

/** A new tool's policy: read-only tools run, others ask first where asking is possible. */
export function defaultPolicy(tool: { readOnly: boolean }, execution: 'server' | 'local'): ToolPolicy {
  return execution === 'local' && !tool.readOnly ? 'ask' : 'allow'
}
