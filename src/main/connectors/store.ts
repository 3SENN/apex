/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { safeStorage } from 'electron'
import { SHARED_OWNER } from '@shared/chats'
import {
  TOOL_POLICIES,
  executionOf,
  type ConnectorAuth,
  type ConnectorHealth,
  type ConnectorInputV2,
  type ConnectorTool,
  type ConnectorTransport,
  type ToolPolicy,
} from '@shared/connectors'
import type { Connector, ConnectorInput, Owner } from '@shared/services'
import { mainT } from '../i18n/mainT'
import { registerSecret } from '../log'
import { writeAtomic } from '../settings'
import { checkConnectorInput, connectorSlug, legacyToV2 } from './config'

// Connector v2: remote and local MCP servers with per-tool policies,
// health and OAuth. Records live in connectors.json; every secret (tokens,
// OAuth tokens, env values) lives encrypted in connector-secrets.bin, mode
// 0600. Older records ({ name, url, enabled, owner }) and its id → token
// secrets file migrate field by field on load.

const CONNECTOR_HEALTH: readonly ConnectorHealth[] = ['unknown', 'checking', 'ok', 'needs-reconnect', 'needs-approval', 'starting', 'error', 'stopped']
const AUTHS: readonly ConnectorAuth[] = ['none', 'bearer', 'api-key', 'oauth']
/** Health that survives a restart; the rest is runtime state and reads as unknown. */
const PERSISTED_HEALTH = new Set<ConnectorHealth>(['ok', 'needs-reconnect', 'needs-approval', 'error'])
const TOOL_SCHEMA_MAX = 32_000

/** The original request shape: the chat's remote connectors with their tokens. */
export interface ResolvedConnector {
  id: string
  name: string
  url: string
  token: string | null
}

export interface OAuthSecret {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms, or null when the server gave no lifetime. */
  expiresAt: number | null
  issuer: string
  tokenEndpoint: string
  resource: string
  clientId: string
  clientSecret: string | null
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  scope: string | null
}

export interface ConnectorSecret {
  token?: string
  /** Every env value of a local server, secret or not; the UI only learns which are set. */
  env?: Record<string, string>
  oauth?: OAuthSecret
  /** A pre-registered OAuth client (Google's setup), used by the next sign-in. */
  client?: { clientId: string; clientSecret: string | null }
}

type StoredTransport =
  | { kind: 'remote'; url: string; headerName: string | null }
  | { kind: 'local'; command: string; args: string[]; env: { name: string; secret: boolean }[]; cwd: string | null }

export interface StoredConnector {
  id: string
  /** The MCP server name: a unique slug. */
  name: string
  displayName: string
  enabled: boolean
  owner: Owner
  source: 'directory' | 'custom'
  directoryId: string | null
  transport: StoredTransport
  auth: ConnectorAuth
  labelColor: string | null
  logo: string | null
  health: ConnectorHealth
  healthDetail: string | null
  tools: ConnectorTool[]
  toolsCheckedAt: number | null
  settings: Record<string, string>
  accountLabel: string | null
  isDefault: boolean
  searchable: boolean
  /** OV-09: the hash of the exact command you approved; any change asks again. */
  approvedHash: string | null
  createdAt: number
}

export interface SecretCipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** The system keychain through safeStorage; unavailable in unit tests without Electron. */
export const safeStorageCipher: SecretCipher = {
  available: () => Boolean(safeStorage?.isEncryptionAvailable?.()),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const strOr = (v: unknown, fallback: string): string => (str(v) ? v : fallback)
const strOrNull = (v: unknown): string | null => (str(v) && v.length > 0 ? v : null)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** "My Linear!!" → "my-linear"; the MCP server name. */
export function connectorName(name: string): string {
  const slug = connectorSlug(name)
  if (!slug) throw new Error(mainT('connectors.error.nameMissing'))
  return slug
}

/** The URL check: https, or plain http on this computer and private addresses. */
export function validateConnectorUrl(url: string): string {
  const result = checkConnectorInput({ name: 'x', transport: { kind: 'remote', url }, auth: 'none', enabled: true })
  if (!result.ok) throw new Error(result.message)
  return new URL(url.trim()).href
}

/** The exact command's identity: command, arguments, folder, env names, flags and values. */
export function approvalHash(transport: StoredTransport, env: Record<string, string> | undefined): string | null {
  if (transport.kind !== 'local') return null
  const values = transport.env.map((e) => [e.name, e.secret, createHash('sha256').update(env?.[e.name] ?? '').digest('hex')])
  return createHash('sha256').update(JSON.stringify({ c: transport.command, a: transport.args, d: transport.cwd, e: values })).digest('hex')
}

function normalizeTool(v: unknown): ConnectorTool | null {
  if (!isObject(v) || !str(v.name) || !v.name) return null
  const policy = TOOL_POLICIES.includes(v.policy as ToolPolicy) ? (v.policy as ToolPolicy) : 'allow'
  let schema: unknown = isObject(v.inputSchema) ? v.inputSchema : { type: 'object' }
  if (JSON.stringify(schema).length > TOOL_SCHEMA_MAX) schema = { type: 'object' }
  return { name: v.name.slice(0, 128), title: strOr(v.title, v.name).slice(0, 200), description: strOr(v.description, '').slice(0, 2000), readOnly: bool(v.readOnly, false), policy, inputSchema: schema }
}

function normalizeTransport(raw: Record<string, unknown>): StoredTransport | null {
  const t = raw.transport
  if (isObject(t) && t.kind === 'local' && str(t.command) && t.command) {
    const args = Array.isArray(t.args) ? t.args.filter(str).slice(0, 64) : []
    const env = Array.isArray(t.env) ? t.env.filter((e): e is Record<string, unknown> => isObject(e) && str(e.name) && e.name.length > 0).map((e) => ({ name: e.name as string, secret: bool(e.secret, true) })) : []
    return { kind: 'local', command: t.command, args, env, cwd: strOrNull(t.cwd) }
  }
  if (isObject(t) && t.kind === 'remote' && str(t.url) && t.url) return { kind: 'remote', url: t.url, headerName: strOrNull(t.headerName) }
  // A remote server with only a url.
  if (str(raw.url) && raw.url) return { kind: 'remote', url: raw.url, headerName: null }
  return null
}

/** Field-by-field fallback over a v2 record, or an older record migrated (bearer when it had a token). */
export function normalizeStored(raw: unknown, secrets: Record<string, ConnectorSecret>, now = Date.now()): StoredConnector | null {
  if (!isObject(raw) || !str(raw.id) || !raw.id) return null
  const transport = normalizeTransport(raw)
  if (!transport) return null
  const name = connectorSlug(strOr(raw.name, '')) || 'connector'
  const legacy = !isObject(raw.transport)
  const auth = AUTHS.includes(raw.auth as ConnectorAuth) ? (raw.auth as ConnectorAuth) : legacy && secrets[raw.id]?.token ? 'bearer' : 'none'
  const health = CONNECTOR_HEALTH.includes(raw.health as ConnectorHealth) && PERSISTED_HEALTH.has(raw.health as ConnectorHealth) ? (raw.health as ConnectorHealth) : 'unknown'
  const settings = isObject(raw.settings) ? Object.fromEntries(Object.entries(raw.settings).filter((e): e is [string, string] => str(e[1])).slice(0, 20)) : {}
  return {
    id: raw.id,
    name,
    displayName: strOr(raw.displayName, strOr(raw.name, name)).slice(0, 48) || name,
    enabled: bool(raw.enabled, true),
    owner: str(raw.owner) && raw.owner ? raw.owner : SHARED_OWNER,
    source: raw.source === 'directory' ? 'directory' : 'custom',
    directoryId: strOrNull(raw.directoryId),
    transport,
    auth: auth === 'oauth' && transport.kind === 'local' ? 'none' : auth,
    labelColor: str(raw.labelColor) && /^#[0-9a-f]{6}$/i.test(raw.labelColor) ? raw.labelColor : null,
    logo: str(raw.logo) && raw.logo.startsWith('data:image/') ? raw.logo : null,
    health,
    healthDetail: health === 'unknown' ? null : strOrNull(raw.healthDetail),
    tools: Array.isArray(raw.tools) ? raw.tools.map(normalizeTool).filter((t): t is ConnectorTool => t !== null).slice(0, 500) : [],
    toolsCheckedAt: typeof raw.toolsCheckedAt === 'number' ? raw.toolsCheckedAt : null,
    settings,
    accountLabel: strOrNull(raw.accountLabel),
    isDefault: bool(raw.isDefault, false),
    searchable: bool(raw.searchable, false),
    approvedHash: strOrNull(raw.approvedHash),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
  }
}

/** Older secrets were id → token; v2 keeps an object per connector. */
export function normalizeSecrets(raw: unknown): Record<string, ConnectorSecret> {
  if (!isObject(raw)) return {}
  const out: Record<string, ConnectorSecret> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (str(value)) out[id] = { token: value }
    else if (isObject(value)) {
      const s: ConnectorSecret = {}
      if (str(value.token) && value.token) s.token = value.token
      if (isObject(value.env)) s.env = Object.fromEntries(Object.entries(value.env).filter((e): e is [string, string] => str(e[1])))
      if (isObject(value.oauth) && str(value.oauth.accessToken)) s.oauth = value.oauth as unknown as OAuthSecret
      if (isObject(value.client) && str(value.client.clientId)) s.client = { clientId: value.client.clientId, clientSecret: strOrNull(value.client.clientSecret) }
      out[id] = s
    }
  }
  return out
}

function registerAll(secret: ConnectorSecret): void {
  if (secret.token) registerSecret(secret.token)
  for (const value of Object.values(secret.env ?? {})) registerSecret(value)
  if (secret.oauth) {
    registerSecret(secret.oauth.accessToken)
    if (secret.oauth.refreshToken) registerSecret(secret.oauth.refreshToken)
    if (secret.oauth.clientSecret) registerSecret(secret.oauth.clientSecret)
  }
  if (secret.client?.clientSecret) registerSecret(secret.client.clientSecret)
}

/** The service key several accounts share: the directory entry, or the server itself. */
function serviceKey(c: Pick<StoredConnector, 'directoryId' | 'transport'>): string {
  if (c.directoryId) return `dir:${c.directoryId}`
  return c.transport.kind === 'remote' ? `url:${c.transport.url}` : `cmd:${c.transport.command} ${c.transport.args.join(' ')}`
}

const instances = new Map<string, ConnectorStore>()

/** The store index.ts made for this data folder (the feature shares it), or a new one. */
export function connectorStoreFor(dataDir: string): ConnectorStore {
  return instances.get(resolvePath(dataDir)) ?? new ConnectorStore(dataDir)
}

export class ConnectorStore extends EventEmitter<{ changed: [Connector[]]; removed: [string] }> {
  readonly #path: string
  readonly #secretsPath: string
  readonly #cipher: SecretCipher
  #items: StoredConnector[]
  #secretCache: Record<string, ConnectorSecret> | null = null

  constructor(dataDir: string, cipher: SecretCipher = safeStorageCipher) {
    super()
    this.#path = join(dataDir, 'connectors.json')
    this.#secretsPath = join(dataDir, 'connector-secrets.bin')
    this.#cipher = cipher
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch {
      raw = undefined
    }
    const secrets = this.#secrets()
    for (const s of Object.values(secrets)) registerAll(s)
    const items = Array.isArray(raw) ? raw.map((r) => normalizeStored(r, secrets)).filter((c): c is StoredConnector => c !== null) : []
    // Names are server names, so they stay unique even across hand-edited files.
    const seen = new Set<string>()
    for (const c of items) {
      let name = c.name
      for (let n = 2; seen.has(name); n++) name = `${c.name.slice(0, 44)}-${n}`
      c.name = name
      seen.add(name)
    }
    this.#items = items
    if (Array.isArray(raw) && raw.some((r) => isObject(r) && !isObject(r.transport))) this.#write()
    instances.set(resolvePath(dataDir), this)
  }

  list(): StoredConnector[] {
    return this.#items.slice()
  }

  get(id: string): StoredConnector | undefined {
    return this.#items.find((c) => c.id === id)
  }

  view(id: string): Connector | undefined {
    const c = this.get(id)
    return c ? this.#view(c, this.#secrets()) : undefined
  }

  views(): Connector[] {
    const secrets = this.#secrets()
    return this.#items.map((c) => this.#view(c, secrets))
  }

  /** The legacy remote input or a ConnectorInputV2; invalid fields throw an error that names the field. */
  save(input: ConnectorInput | ConnectorInputV2, extra: Partial<Pick<StoredConnector, 'logo' | 'accountLabel' | 'searchable'>> = {}): Connector {
    const v2 = 'transport' in input ? input : legacyToV2(input)
    const checked = checkConnectorInput(v2)
    if (!checked.ok) throw new Error(checked.message)
    const existing = v2.id ? this.get(v2.id) : undefined
    if (v2.id && !existing) throw new Error(mainT('connectors.error.gone'))
    const id = existing?.id ?? v2.id ?? randomUUID()
    const name = this.#uniqueName(connectorName(v2.name), id)
    const transport: StoredTransport =
      v2.transport.kind === 'remote'
        ? { kind: 'remote', url: new URL(v2.transport.url.trim()).href, headerName: v2.transport.headerName?.trim() || null }
        : { kind: 'local', command: v2.transport.command.trim(), args: v2.transport.args.slice(), env: v2.transport.env.map((e) => ({ name: e.name.trim(), secret: e.secret })), cwd: v2.transport.cwd?.trim() || null }

    const secrets = this.#secrets()
    const secret: ConnectorSecret = { ...(secrets[id] ?? {}) }
    if (v2.secret !== undefined) {
      if (v2.secret === null || v2.secret.trim() === '') delete secret.token
      else secret.token = v2.secret.trim()
    }
    if (v2.transport.kind === 'local') {
      const env: Record<string, string> = {}
      for (const e of v2.transport.env) {
        const key = e.name.trim()
        if (e.value === undefined) {
          if (secret.env?.[key] !== undefined) env[key] = secret.env[key]
        } else if (e.value !== null) env[key] = e.value
      }
      secret.env = env
    } else delete secret.env
    if (v2.auth !== 'oauth') delete secret.oauth
    registerAll(secret)

    const changedServer = !existing || JSON.stringify(existing.transport) !== JSON.stringify(transport) || existing.auth !== v2.auth || v2.secret !== undefined
    const key = serviceKey({ directoryId: v2.directoryId ?? existing?.directoryId ?? null, transport })
    const stored: StoredConnector = {
      id,
      name,
      displayName: (v2.displayName ?? v2.name).trim().slice(0, 48) || name,
      enabled: v2.enabled,
      owner: v2.owner ?? existing?.owner ?? SHARED_OWNER,
      source: v2.source ?? existing?.source ?? 'custom',
      directoryId: v2.directoryId !== undefined ? v2.directoryId : (existing?.directoryId ?? null),
      transport,
      auth: v2.auth,
      labelColor: v2.labelColor !== undefined ? v2.labelColor : (existing?.labelColor ?? null),
      logo: v2.logo !== undefined ? v2.logo : extra.logo !== undefined ? extra.logo : (existing?.logo ?? null),
      health: changedServer ? 'unknown' : (existing?.health ?? 'unknown'),
      healthDetail: changedServer ? null : (existing?.healthDetail ?? null),
      tools: existing && JSON.stringify(existing.transport) === JSON.stringify(transport) ? existing.tools : [],
      toolsCheckedAt: changedServer ? null : (existing?.toolsCheckedAt ?? null),
      settings: v2.settings ?? existing?.settings ?? {},
      accountLabel: extra.accountLabel !== undefined ? extra.accountLabel : (existing?.accountLabel ?? null),
      isDefault: existing?.isDefault ?? !this.#items.some((c) => c.id !== id && serviceKey(c) === key),
      searchable: extra.searchable ?? existing?.searchable ?? false,
      approvedHash: existing?.approvedHash ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
    }
    secrets[id] = secret
    this.#writeSecrets(secrets)
    this.#upsert(stored)
    return this.#view(stored, secrets)
  }

  /** Runtime updates (health, tools, flags); never touches secrets. */
  patch(id: string, fields: Partial<Omit<StoredConnector, 'id' | 'transport' | 'auth' | 'createdAt'>>): Connector {
    const c = this.get(id)
    if (!c) throw new Error(mainT('connectors.error.gone'))
    const next = { ...c, ...fields }
    if (JSON.stringify(next) !== JSON.stringify(c)) this.#upsert(next)
    return this.#view(next, this.#secrets())
  }

  setDefault(id: string): Connector {
    const target = this.get(id)
    if (!target) throw new Error(mainT('connectors.error.gone'))
    const key = serviceKey(target)
    this.#items = this.#items.map((c) => (serviceKey(c) === key ? { ...c, isDefault: c.id === id } : c))
    this.#write()
    this.#emit()
    return this.view(id) as Connector
  }

  remove(id: string): void {
    const c = this.get(id)
    if (!c) return
    this.#items = this.#items.filter((x) => x.id !== id)
    // The next account of the same service becomes the default.
    if (c.isDefault) {
      const next = this.#items.find((x) => serviceKey(x) === serviceKey(c))
      if (next) next.isDefault = true
    }
    const secrets = this.#secrets()
    if (id in secrets) {
      delete secrets[id]
      this.#writeSecrets(secrets)
    }
    this.#write()
    this.emit('removed', id)
    this.#emit()
  }

  secretOf(id: string): ConnectorSecret {
    return { ...(this.#secrets()[id] ?? {}) }
  }

  setSecret(id: string, update: (secret: ConnectorSecret) => ConnectorSecret): void {
    const secrets = this.#secrets()
    const next = update({ ...(secrets[id] ?? {}) })
    registerAll(next)
    secrets[id] = next
    this.#writeSecrets(secrets)
    this.#emit()
  }

  /** The command as it is now; compare with approvedHash. */
  currentApprovalHash(id: string): string | null {
    const c = this.get(id)
    return c ? approvalHash(c.transport, this.#secrets()[id]?.env) : null
  }

  isApproved(id: string): boolean {
    const c = this.get(id)
    const hash = this.currentApprovalHash(id)
    return Boolean(c && hash && c.approvedHash === hash)
  }

  /** The original request shape: enabled-at-start connectors Anthropic's MCP connector can reach, with fresh tokens. */
  resolve(ids: readonly string[]): ResolvedConnector[] {
    const secrets = this.#secrets()
    const out: ResolvedConnector[] = []
    for (const id of ids) {
      const c = this.get(id)
      if (!c) throw new Error(mainT('connectors.error.removedFromChat'))
      if (c.transport.kind !== 'remote' || executionOf(c.transport, c.auth) !== 'server') continue
      out.push({ id: c.id, name: c.name, url: c.transport.url, token: bearerOf(c, secrets[c.id]) })
    }
    return out
  }

  /** Enabled connectors a chat with this companion gets: shared ones and its own. Without an id, every enabled one. */
  enabledIds(companionId?: string): string[] {
    return this.#items.filter((c) => c.enabled && (companionId === undefined || c.owner === SHARED_OWNER || c.owner === companionId)).map((c) => c.id)
  }

  removeOwned(owner: Owner): void {
    for (const c of this.list()) if (c.owner === owner) this.remove(c.id)
  }

  #uniqueName(base: string, id: string): string {
    let name = base
    for (let n = 2; this.#items.some((c) => c.name === name && c.id !== id); n++) name = `${base.slice(0, 44)}-${n}`
    return name
  }

  #view(c: StoredConnector, secrets: Record<string, ConnectorSecret>): Connector {
    const secret = secrets[c.id] ?? {}
    const transport: ConnectorTransport =
      c.transport.kind === 'remote'
        ? { ...c.transport }
        : { ...c.transport, args: c.transport.args.slice(), env: c.transport.env.map((e) => ({ ...e, hasValue: secret.env?.[e.name] !== undefined })) }
    const hasSecret = Boolean(secret.token || secret.oauth || (secret.env && Object.keys(secret.env).length > 0))
    const execution = executionOf(transport, c.auth)
    const approved = c.transport.kind !== 'local' || c.approvedHash === approvalHash(c.transport, secret.env)
    const health: ConnectorHealth = !approved ? 'needs-approval' : c.health === 'needs-approval' ? 'unknown' : c.health
    return {
      id: c.id,
      name: c.name,
      displayName: c.displayName,
      enabled: c.enabled,
      owner: c.owner,
      source: c.source,
      directoryId: c.directoryId,
      transport,
      auth: c.auth,
      execution,
      labelColor: c.labelColor,
      logo: c.logo,
      health,
      healthDetail: health === 'needs-approval' ? null : c.healthDetail,
      tools: c.tools.map((t) => ({ ...t })),
      toolsCheckedAt: c.toolsCheckedAt,
      settings: { ...c.settings },
      accountLabel: c.accountLabel,
      isDefault: c.isDefault,
      hasSecret,
      searchable: c.searchable,
      url: c.transport.kind === 'remote' ? c.transport.url : [c.transport.command, ...c.transport.args].join(' '),
      hasToken: hasSecret,
    }
  }

  #upsert(c: StoredConnector): void {
    const i = this.#items.findIndex((x) => x.id === c.id)
    if (i >= 0) this.#items[i] = c
    else this.#items.push(c)
    this.#write()
    this.#emit()
  }

  #emit(): void {
    this.emit('changed', this.views())
  }

  #write(): void {
    writeAtomic(this.#path, JSON.stringify(this.#items, null, 2))
  }

  #secrets(): Record<string, ConnectorSecret> {
    if (this.#secretCache) return structuredClone(this.#secretCache)
    if (!existsSync(this.#secretsPath) || !this.#cipher.available()) return {}
    try {
      this.#secretCache = normalizeSecrets(JSON.parse(this.#cipher.decrypt(readFileSync(this.#secretsPath))))
    } catch {
      this.#secretCache = {}
    }
    return structuredClone(this.#secretCache)
  }

  #writeSecrets(secrets: Record<string, ConnectorSecret>): void {
    const kept = Object.fromEntries(Object.entries(secrets).filter(([, s]) => s.token || s.oauth || s.client || (s.env && Object.keys(s.env).length > 0)))
    if (Object.keys(kept).length === 0) {
      rmSync(this.#secretsPath, { force: true })
      this.#secretCache = {}
      return
    }
    if (!this.#cipher.available()) throw new Error(mainT('connectors.error.noKeychain'))
    writeAtomic(this.#secretsPath, this.#cipher.encrypt(JSON.stringify(kept)))
    this.#secretCache = structuredClone(kept)
  }
}

/** The token a server-side call sends as Bearer: OAuth's access token, or the saved token. */
export function bearerOf(c: Pick<StoredConnector, 'auth'>, secret: ConnectorSecret | undefined): string | null {
  if (c.auth === 'oauth') return secret?.oauth?.accessToken ?? null
  if (c.auth === 'bearer' || c.auth === 'api-key') return secret?.token ?? null
  return null
}
