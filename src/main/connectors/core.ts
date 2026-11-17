/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  actionLabelOf,
  defaultPolicy,
  executionOf,
  policiesFor,
  type ConnectorHealth,
  type ConnectorInputV2,
  type ConnectorRecordHit,
  type ConnectorTool,
  type DirectoryEntry,
  type LocalToolSnapshot,
  type ToolPolicy,
} from '@shared/connectors'
import type { Connector } from '@shared/services'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { McpAuthError, McpSession, type McpTool } from './client'
import { DIRECTORY, directoryEntry } from './directory'
import type { FaviconCache } from './favicons'
import { IDLE_MS, LocalServers, type LocalSpec, type LocalState } from './localServers'
import { localToolNames } from './naming'
import { OAuthError, discover, needsRefresh, refresh, signIn, type FetchFn } from './oauth'
import type { ConnectorRuntime, InputValidation, ResolvedConnector } from './runtime'
import { bearerOf, type ConnectorStore, type StoredConnector } from './store'
import { validateAgainst } from './validate'

// The connectors engine: health checks and tool lists through Atelier's
// own MCP client, local servers behind OV-09's approval, OAuth sign-in and
// refresh, record search (CH-08), and the ConnectorRuntime that the chat
// sessions and local tools build requests with. service.ts turns it into the service
// methods; the store is the one index.ts made, so the basic list, save and remove
// methods stay in step.

const SEARCH_TIMEOUT_MS = 8000
const SEARCH_LIMIT = 50
const REFRESH_EVERY_MS = 60_000

export interface CoreDeps {
  store: ConnectorStore
  dataDir: string
  icons: FaviconCache
  fetchFn: FetchFn
  /** Opens OAuth's authorization page in a new tab of the current profile; returns how to close it. */
  openSignIn(url: string): () => void
  loginPath(): Promise<string | null>
  /** needs-reconnect: a notification that opens the connector. */
  notify(title: string, body: string, url: string): void
  home?: string
}

export class ConnectorsCore {
  readonly #deps: CoreDeps
  readonly #local: LocalServers
  readonly #remote = new Map<string, { key: string; session: Promise<McpSession>; lastUsed: number }>()
  readonly #checks = new Map<string, Promise<Connector>>()
  readonly #refreshing = new Map<string, Promise<string>>()
  readonly #titles = new Map<string, string>()
  readonly #timer: NodeJS.Timeout

  constructor(deps: CoreDeps) {
    this.#deps = deps
    this.#local = new LocalServers({
      root: join(deps.dataDir, 'connector-servers'),
      loginPath: deps.loginPath,
      home: deps.home ?? homedir(),
      onState: (id, state) => this.#onLocalState(id, state),
    })
    deps.store.on('removed', (id) => void this.#drop(id))
    deps.store.on('changed', () => this.#reconcile())
    this.#timer = setInterval(() => void this.#refreshSoon(), REFRESH_EVERY_MS)
    this.#timer.unref?.()
  }

  get store(): ConnectorStore {
    return this.#deps.store
  }

  directory(): DirectoryEntry[] {
    return DIRECTORY.slice()
  }

  logs(id: string): string[] {
    return this.#local.logs(id)
  }

  async dispose(): Promise<void> {
    clearInterval(this.#timer)
    await this.#local.stopAll()
    await Promise.all([...this.#remote.values()].map((r) => r.session.then((s) => s.close()).catch(() => undefined)))
    this.#remote.clear()
  }

  // ---- edits ----

  setToolPolicy(id: string, tool: string, policy: ToolPolicy): Connector {
    const c = this.#get(id)
    this.#checkPolicy(c, policy)
    if (!c.tools.some((t) => t.name === tool)) throw new Error(mainT('connectors.error.toolGone'))
    return this.store.patch(id, { tools: c.tools.map((t) => (t.name === tool ? { ...t, policy } : t)) })
  }

  setAllTools(id: string, policy: ToolPolicy): Connector {
    const c = this.#get(id)
    this.#checkPolicy(c, policy)
    return this.store.patch(id, { tools: c.tools.map((t) => ({ ...t, policy })) })
  }

  /** OV-09: records the exact command you saw; the server may start from now on. */
  approveLocalStart(id: string): Connector {
    const c = this.#get(id)
    if (c.transport.kind !== 'local') throw new Error(mainT('connectors.error.notLocal'))
    return this.store.patch(id, { approvedHash: this.store.currentApprovalHash(id), health: 'unknown', healthDetail: null })
  }

  // ---- health and tools ----

  /** Connects with the stored credential and lists the tools again (one check per connector at a time). */
  check(id: string): Promise<Connector> {
    const running = this.#checks.get(id)
    if (running) return running
    const run = this.#check(id).finally(() => this.#checks.delete(id))
    this.#checks.set(id, run)
    return run
  }

  async #check(id: string): Promise<Connector> {
    const c = this.#get(id)
    if (c.transport.kind === 'local' && !this.store.isApproved(id)) return this.#health(id, 'needs-approval', null)
    this.#health(id, c.transport.kind === 'local' && !this.#local.isRunning(id) ? 'starting' : 'checking', null)
    try {
      const tools = await this.#withSession(id, async (s) => ({ tools: await s.listTools(), caps: s.capabilities() }))
      const fresh = this.#get(id)
      const execution = executionOf(fresh.transport, fresh.auth)
      const previous = new Map(fresh.tools.map((t) => [t.name, t.policy]))
      const allowed = policiesFor(execution)
      const merged: ConnectorTool[] = tools.tools.map((t: McpTool) => {
        const kept = previous.get(t.name)
        const base = { readOnly: t.readOnly }
        return {
          name: t.name,
          title: actionLabelOf({ name: t.name, title: t.title }),
          description: t.description.slice(0, 2000),
          readOnly: t.readOnly,
          policy: kept && allowed.includes(kept) ? kept : defaultPolicy(base, execution),
          inputSchema: JSON.stringify(t.inputSchema).length > 32_000 ? { type: 'object' } : t.inputSchema,
        }
      })
      const searchable = tools.caps.resources || merged.some((t) => t.name === 'search' && t.readOnly)
      return this.store.patch(id, { tools: merged, toolsCheckedAt: Date.now(), searchable, health: 'ok', healthDetail: null })
    } catch (err) {
      return this.#failed(id, err)
    }
  }

  /** Signs in again (OAuth), restarts a local server, or checks once more. */
  async reconnect(id: string): Promise<Connector> {
    const c = this.#get(id)
    if (c.auth === 'oauth') {
      if (c.transport.kind !== 'remote') throw new Error(mainT('connectors.error.notRemote'))
      const entry = c.directoryId ? directoryEntry(c.directoryId) : undefined
      const client = this.store.secretOf(id).client
      try {
        const oauth = await signIn({ resourceUrl: c.transport.url, fetchFn: this.#deps.fetchFn, open: this.#deps.openSignIn, preRegistered: client, scopes: entry?.scopes })
        this.store.setSecret(id, (s) => ({ ...s, oauth }))
      } catch (err) {
        // Cancelling leaves the connector as it was; any other failure needs another try.
        if (!(err instanceof OAuthError && (err.code === 'cancelled' || err.code === 'timeout'))) this.#needsReconnect(id, err instanceof Error ? err.message : String(err))
        throw err
      }
      await this.#closeRemote(id)
      return this.check(id)
    }
    if (c.transport.kind === 'local') {
      await this.#local.stop(id)
      return this.check(id)
    }
    await this.#closeRemote(id)
    return this.check(id)
  }

  /** Adds a directory entry: one-click sign-in where it offers one, else the token you pasted. */
  async connectDirectory(entryId: string, opts: { token?: string; fields?: Record<string, string> } = {}): Promise<Connector> {
    const entry = directoryEntry(entryId)
    if (!entry) throw new Error(mainT('connectors.error.unknownEntry'))
    const fields = opts.fields ?? {}
    for (const f of entry.fields ?? []) {
      if (f.key === 'clientSecret') continue
      if (!fields[f.key]?.trim()) throw new Error(mainT('connectors.error.fieldMissing', { field: f.label }))
    }
    const settings = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'clientId' && k !== 'clientSecret').map(([k, v]) => [k, v.trim()]))
    const url = entry.url.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => encodeURIComponent(settings[key] ?? ''))
    const client = fields.clientId?.trim() ? { clientId: fields.clientId.trim(), clientSecret: fields.clientSecret?.trim() || null } : undefined
    let auth: ConnectorInputV2['auth']
    let oauth: Awaited<ReturnType<typeof signIn>> | null = null
    if (opts.token?.trim()) auth = 'bearer'
    else if (entry.auth === 'none') auth = 'none'
    else if (entry.auth === 'token') throw new Error(mainT('connectors.error.tokenNeeded'))
    else {
      oauth = await signIn({ resourceUrl: url, fetchFn: this.#deps.fetchFn, open: this.#deps.openSignIn, preRegistered: client, scopes: entry.scopes })
      auth = 'oauth'
    }
    const others = this.store.list().filter((c) => c.directoryId === entry.id).length
    const logo = await this.#deps.icons.get(entry.site).catch(() => null)
    const saved = this.store.save(
      { name: entry.id, displayName: entry.name, source: 'directory', directoryId: entry.id, transport: { kind: 'remote', url, headerName: null }, auth, secret: opts.token?.trim() || undefined, enabled: true, settings },
      { logo, accountLabel: others > 0 ? mainT('connectors.accountN', { n: others + 1 }) : null },
    )
    if (oauth || client) this.store.setSecret(saved.id, (s) => ({ ...s, ...(oauth ? { oauth } : {}), ...(client ? { client } : {}) }))
    return this.check(saved.id)
  }

  // ---- records (CH-08) ----

  async search(query: string, ids?: readonly string[]): Promise<ConnectorRecordHit[]> {
    const q = query.trim().toLowerCase()
    const targets = this.store.list().filter((c) => c.enabled && c.searchable && (!ids || ids.includes(c.id)) && (c.transport.kind !== 'local' || this.store.isApproved(c.id)))
    const results = await Promise.all(
      targets.map((c) =>
        withTimeout(this.#searchOne(c, q), SEARCH_TIMEOUT_MS).catch((err: unknown) => {
          log.warn('connectors', `search failed for ${c.name}`, { error: err instanceof Error ? err.message : String(err) })
          return [] as ConnectorRecordHit[]
        }),
      ),
    )
    const hits = results.flat().slice(0, SEARCH_LIMIT)
    for (const h of hits) this.#titles.set(`${h.connectorId}\n${h.uri}`, h.title)
    return hits
  }

  async #searchOne(c: StoredConnector, q: string): Promise<ConnectorRecordHit[]> {
    return this.#withSession(c.id, async (s) => {
      const hits: ConnectorRecordHit[] = []
      if (s.capabilities().resources) {
        const resources = await s.listResources()
        for (const r of resources) {
          const text = `${r.name} ${r.uri} ${r.description}`.toLowerCase()
          if (!q || text.includes(q)) hits.push({ connectorId: c.id, uri: r.uri, title: r.name.slice(0, 200), snippet: r.description.slice(0, 300) })
          if (hits.length >= 20) break
        }
      }
      const tool = c.tools.find((t) => t.name === 'search' && t.readOnly && t.policy !== 'off')
      if (tool && q) {
        const result = await s.callTool('search', { query: q })
        if (!result.isError) hits.push(...parseSearchResult(c.id, result.content).slice(0, 20))
      }
      return hits
    })
  }

  async readRecord(connectorId: string, uri: string): Promise<{ title: string; text: string }> {
    const c = this.#get(connectorId)
    if (!c.enabled) throw new Error(mainT('connectors.error.off'))
    const title = this.#titles.get(`${connectorId}\n${uri}`) ?? uri
    return this.#withSession(connectorId, async (s) => {
      if (s.capabilities().resources) {
        try {
          return { title, text: await s.readResource(uri) }
        } catch (err) {
          if (err instanceof McpAuthError) throw err
        }
      }
      const fetchTool = c.tools.find((t) => t.name === 'fetch' && t.readOnly && t.policy !== 'off')
      if (!fetchTool) throw new Error(mainT('connectors.error.recordUnreadable'))
      const result = await s.callTool('fetch', { id: uri })
      const text = typeof result.content === 'string' ? result.content : (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
      if (result.isError) throw new Error(text.slice(0, 300) || mainT('connectors.error.recordUnreadable'))
      return { title, text }
    })
  }

  // ---- the runtime the chat sessions use ----

  runtime(): ConnectorRuntime {
    return {
      resolveServer: (ids) => this.#resolveServer(ids),
      localTools: (ids) => this.#localTools(ids),
      callLocal: (id, tool, input, signal) => this.#callLocal(id, tool, input, signal),
      livePolicy: (id, tool) => this.#livePolicy(id, tool),
      validateInput: (id, tool, input) => this.#validateInput(id, tool, input),
      readRecord: (id, uri) => this.readRecord(id, uri),
      forApp: (ref) => {
        const named = this.store.list().filter((c) => c.directoryId === ref || c.name === ref)
        const c = named.find((x) => x.enabled && x.isDefault) ?? named.find((x) => x.enabled) ?? named[0]
        return c ? { id: c.id, name: c.displayName || c.name, enabled: c.enabled, tools: c.tools } : null
      },
      callForApp: (id, tool, input, signal) => this.#callForApp(id, tool, input, signal),
    }
  }

  async #callForApp(id: string, tool: string, input: unknown, signal: AbortSignal): Promise<{ content: ToolContent; isError: boolean; structured: unknown }> {
    const c = this.store.get(id)
    const refused = (text: string): { content: ToolContent; isError: boolean; structured: unknown } => ({ content: [{ type: 'text', text }], isError: true, structured: null })
    if (!c || !c.enabled) return refused(mainT('connectors.error.off'))
    if (this.#livePolicy(id, tool) === 'off') return refused(mainT('connectors.error.toolOff', { tool }))
    if (c.transport.kind === 'local' && !this.store.isApproved(id)) {
      this.#health(id, 'needs-approval', null)
      return refused(mainT('connectors.error.needsApproval', { name: c.displayName }))
    }
    try {
      const result = await this.#withSession(id, (s) => s.callTool(tool, input, signal))
      const raw = result.raw as { structuredContent?: unknown } | null
      return { content: result.content, isError: result.isError, structured: raw?.structuredContent ?? null }
    } catch (err) {
      if (signal.aborted) return refused(mainT('connectors.error.stopped'))
      const failed = this.#failed(id, err)
      return refused(failed.healthDetail ?? (err instanceof Error ? err.message : String(err)))
    }
  }

  #resolveServer(ids: readonly string[]): ResolvedConnector[] {
    const out: ResolvedConnector[] = []
    for (const id of ids) {
      const c = this.store.get(id)
      if (!c || c.transport.kind !== 'remote' || executionOf(c.transport, c.auth) !== 'server') continue
      const secret = this.store.secretOf(id)
      // Refresh in the background when close to expiry; this request uses the token it has.
      if (c.auth === 'oauth' && secret.oauth && needsRefresh(secret.oauth)) void this.#freshToken(c).catch(() => undefined)
      out.push({ connectorId: id, serverName: c.name, url: c.transport.url, authorizationToken: bearerOf(c, secret), disabledTools: c.tools.filter((t) => t.policy === 'off').map((t) => t.name) })
    }
    return out
  }

  #localTools(ids: readonly string[]): LocalToolSnapshot[] {
    const entries = ids
      .map((id) => this.store.get(id))
      .filter((c): c is StoredConnector => !!c && c.enabled && executionOf(c.transport, c.auth) === 'local')
      .flatMap((c) => c.tools.filter((t) => t.policy !== 'off').map((t) => ({ connectorId: c.id, connectorName: c.name, toolName: t.name, tool: t })))
    return localToolNames(entries).map((e) => ({
      connectorId: e.connectorId,
      apiName: e.apiName,
      toolName: e.toolName,
      description: e.tool.description,
      inputSchema: e.tool.inputSchema,
      actionLabel: actionLabelOf({ name: e.tool.name, title: e.tool.title }),
    }))
  }

  #livePolicy(id: string, tool: string): ToolPolicy {
    const c = this.store.get(id)
    if (!c || !c.enabled) return 'off'
    return c.tools.find((t) => t.name === tool)?.policy ?? (executionOf(c.transport, c.auth) === 'local' ? 'ask' : 'allow')
  }

  #validateInput(id: string, tool: string, input: unknown): InputValidation {
    const schema = this.store.get(id)?.tools.find((t) => t.name === tool)?.inputSchema
    return validateAgainst(schema ?? { type: 'object' }, input)
  }

  async #callLocal(id: string, tool: string, input: unknown, signal: AbortSignal): Promise<{ content: ToolContent; isError: boolean }> {
    const errorResult = (text: string): { content: ToolContent; isError: boolean } => ({ content: [{ type: 'text', text }], isError: true })
    const c = this.store.get(id)
    if (!c) return errorResult(mainT('connectors.error.removedFromChat'))
    if (this.#livePolicy(id, tool) === 'off') return errorResult(mainT('connectors.error.toolOff', { tool }))
    if (c.transport.kind === 'local' && !this.store.isApproved(id)) {
      this.#health(id, 'needs-approval', null)
      return errorResult(mainT('connectors.error.needsApproval', { name: c.displayName }))
    }
    try {
      const result = await this.#withSession(id, (s) => s.callTool(tool, input, signal))
      return { content: result.content, isError: result.isError }
    } catch (err) {
      if (signal.aborted) return errorResult(mainT('connectors.error.stopped'))
      const failed = this.#failed(id, err)
      return errorResult(failed.healthDetail ?? (err instanceof Error ? err.message : String(err)))
    }
  }

  // ---- sessions and credentials ----

  /** Runs `fn` on a connected session: the local server's own, or a remote one kept warm for ten idle minutes. */
  async #withSession<T>(id: string, fn: (s: McpSession) => Promise<T>): Promise<T> {
    const c = this.#get(id)
    if (c.transport.kind === 'local') {
      const session = await this.#local.session(this.#localSpec(c))
      return fn(session)
    }
    const attempt = async (forceRefresh: boolean): Promise<T> => {
      const headers = await this.#headers(c, forceRefresh)
      const key = JSON.stringify([c.transport, headers])
      let entry = this.#remote.get(id)
      if (entry && entry.key !== key) {
        void entry.session.then((s) => s.close()).catch(() => undefined)
        entry = undefined
      }
      if (!entry) {
        const url = (c.transport as { url: string }).url
        entry = { key, session: McpSession.remote({ url, headers }), lastUsed: Date.now() }
        this.#remote.set(id, entry)
        entry.session.catch(() => this.#remote.get(id) === entry && this.#remote.delete(id))
      }
      entry.lastUsed = Date.now()
      const session = await entry.session
      return await fn(session)
    }
    try {
      return await attempt(false)
    } catch (err) {
      await this.#closeRemote(id)
      // An OAuth token the server refused gets one forced refresh before giving up.
      if (err instanceof McpAuthError && c.auth === 'oauth') return attempt(true)
      throw err
    } finally {
      this.#reapRemote()
    }
  }

  #localSpec(c: StoredConnector): LocalSpec {
    if (c.transport.kind !== 'local') throw new Error(mainT('connectors.error.notLocal'))
    const env = this.store.secretOf(c.id).env ?? {}
    const values: Record<string, string> = {}
    for (const e of c.transport.env) if (env[e.name] !== undefined) values[e.name] = env[e.name] as string
    return { id: c.id, command: c.transport.command, args: c.transport.args, cwd: c.transport.cwd, env: values, secrets: c.transport.env.filter((e) => e.secret).map((e) => values[e.name] ?? '').filter(Boolean) }
  }

  async #headers(c: StoredConnector, forceRefresh: boolean): Promise<Record<string, string>> {
    if (c.transport.kind !== 'remote') return {}
    const secret = this.store.secretOf(c.id)
    const header = c.transport.headerName
    if (c.auth === 'oauth') {
      if (!secret.oauth) throw new OAuthError('expired')
      const token = forceRefresh || needsRefresh(secret.oauth) ? await this.#freshToken(c, forceRefresh) : secret.oauth.accessToken
      return { Authorization: `Bearer ${token}` }
    }
    if (!secret.token || c.auth === 'none') return {}
    if (c.auth === 'api-key') return { [header ?? 'X-API-Key']: secret.token }
    return header ? { [header]: secret.token } : { Authorization: `Bearer ${secret.token}` }
  }

  /** An access token refreshed before use; a failed refresh marks the connector needs-reconnect. */
  #freshToken(c: StoredConnector, force = false): Promise<string> {
    const pending = this.#refreshing.get(c.id)
    if (pending) return pending
    const run = (async () => {
      const current = this.store.secretOf(c.id).oauth
      if (!current) throw new OAuthError('expired')
      if (!force && !needsRefresh(current)) return current.accessToken
      try {
        const next = await refresh(current, this.#deps.fetchFn)
        this.store.setSecret(c.id, (s) => ({ ...s, oauth: next }))
        return next.accessToken
      } catch (err) {
        this.#needsReconnect(c.id, err instanceof Error ? err.message : String(err))
        throw err
      }
    })().finally(() => this.#refreshing.delete(c.id))
    this.#refreshing.set(c.id, run)
    return run
  }

  async #refreshSoon(): Promise<void> {
    for (const c of this.store.list()) {
      if (c.auth !== 'oauth' || !c.enabled || c.health === 'needs-reconnect') continue
      const oauth = this.store.secretOf(c.id).oauth
      if (oauth && oauth.expiresAt !== null && oauth.expiresAt - Date.now() < 5 * 60_000) await this.#freshToken(c).catch(() => undefined)
    }
  }

  // ---- health ----

  #failed(id: string, err: unknown): Connector {
    const message = err instanceof Error ? err.message : String(err)
    const c = this.store.get(id)
    if (!c) throw err instanceof Error ? err : new Error(message)
    if (err instanceof OAuthError || (err instanceof McpAuthError && c.auth === 'oauth')) return this.#needsReconnect(id, message)
    if (err instanceof McpAuthError) {
      // A server that wants sign-in though none was set up: offer Sign in when it describes one.
      const noCredential = c.auth === 'none' || (c.auth === 'bearer' && !this.store.secretOf(id).token)
      if (noCredential && c.transport.kind === 'remote') void this.#offerSignIn(c)
      return this.#health(id, 'error', noCredential ? mainT('connectors.health.wantsSignIn') : mainT('connectors.health.tokenRefused'))
    }
    return this.#health(id, 'error', message.slice(0, 300))
  }

  async #offerSignIn(c: StoredConnector): Promise<void> {
    if (c.transport.kind !== 'remote') return
    try {
      await discover(c.transport.url, this.#deps.fetchFn)
    } catch {
      return
    }
    const now = this.store.get(c.id)
    if (!now || now.transport.kind !== 'remote') return
    this.store.save({ id: now.id, name: now.name, displayName: now.displayName, transport: { kind: 'remote', url: now.transport.url, headerName: now.transport.headerName }, auth: 'oauth', enabled: now.enabled })
    this.#needsReconnect(c.id, mainT('connectors.health.signInOffered'))
  }

  #needsReconnect(id: string, detail: string): Connector {
    const before = this.store.get(id)
    const view = this.#health(id, 'needs-reconnect', detail)
    if (before && before.health !== 'needs-reconnect') {
      this.#deps.notify(mainT('connectors.notify.reconnectTitle', { name: before.displayName }), mainT('connectors.notify.reconnectBody'), `atelier://connectors/${id}`)
    }
    return view
  }

  #health(id: string, health: ConnectorHealth, detail: string | null): Connector {
    return this.store.patch(id, { health, healthDetail: detail })
  }

  #onLocalState(id: string, state: LocalState): void {
    if (!this.store.get(id)) return
    if (state.state === 'error') this.#health(id, 'error', state.detail)
    else if (state.state === 'stopped') this.#health(id, 'stopped', null)
    else if (state.state === 'starting') this.#health(id, 'starting', null)
    else this.#health(id, 'ok', null)
  }

  /** A local server whose command changed, lost its approval or was turned off stops. */
  #reconcile(): void {
    for (const c of this.store.list()) {
      if (c.transport.kind !== 'local' || !this.#local.isRunning(c.id)) continue
      if (!c.enabled || !this.store.isApproved(c.id)) void this.#local.stop(c.id)
    }
  }

  async #drop(id: string): Promise<void> {
    await this.#local.stop(id)
    await this.#closeRemote(id)
  }

  async #closeRemote(id: string): Promise<void> {
    const entry = this.#remote.get(id)
    this.#remote.delete(id)
    await entry?.session.then((s) => s.close()).catch(() => undefined)
  }

  #reapRemote(): void {
    const now = Date.now()
    for (const [id, entry] of this.#remote) if (now - entry.lastUsed > IDLE_MS) void this.#closeRemote(id)
  }

  #get(id: string): StoredConnector {
    const c = this.store.get(id)
    if (!c) throw new Error(mainT('connectors.error.gone'))
    return c
  }

  #checkPolicy(c: StoredConnector, policy: ToolPolicy): void {
    if (!policiesFor(executionOf(c.transport, c.auth)).includes(policy)) throw new Error(mainT('connectors.error.askLocalOnly'))
  }
}

type ToolContent = Awaited<ReturnType<ConnectorRuntime['callLocal']>>['content']

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** A read-only `search` tool's answer: JSON results ({ results: [...] } or an array) with a title and an id or URL. */
export function parseSearchResult(connectorId: string, content: ToolContent): ConnectorRecordHit[] {
  const texts = typeof content === 'string' ? [content] : (content ?? []).map((b) => (b.type === 'text' ? b.text : ''))
  const hits: ConnectorRecordHit[] = []
  for (const text of texts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const list = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { results?: unknown }).results) ? (parsed as { results: unknown[] }).results : []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const uri = [r.uri, r.id, r.url].find((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096)
      const title = [r.title, r.name].find((v): v is string => typeof v === 'string' && v.length > 0)
      if (!uri) continue
      const snippet = [r.snippet, r.text, r.description].find((v): v is string => typeof v === 'string') ?? ''
      hits.push({ connectorId, uri, title: (title ?? uri).slice(0, 200), snippet: snippet.slice(0, 300) })
    }
  }
  return hits
}
