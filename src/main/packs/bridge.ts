/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge (docs/packs.md › The sandbox and the bridge): main's side of
// window.atelier. Every call arrives as one op from a pack's page or tool host;
// before anything runs, the sender must be the top frame of its own pack's
// address, the pack must be on (or a draft under test), the arguments must
// pass zod, and the op's permission must be granted. A refusal is logged to
// the pack's log and reaches the caller as a plain error.
import { BRAND_NAME } from '@shared/branding'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { DECISION_REQUEST_SCHEMA, type DecisionRequest, type DecisionResult } from '@shared/decisions'
import { isSignInUrl } from '@shared/signInHosts'
import { pageTweakHost } from '@shared/tweaks'
import { WORLD_ID_PATTERN, parseWorldRef } from '@shared/worlds'
import { SERVER_LIMITS, SERVER_REQUEST_ID_PATTERN, SERVER_SOCKET_ID_PATTERN } from '@shared/localServer'
import {
  PACK_AUTH_ID_PATTERN,
  PACK_CONNECTOR_REF_PATTERN,
  PACK_ENV_NAME_PATTERN,
  PACK_EVENT_NAME_PATTERN,
  PACK_IPC,
  PACK_ITEM_ID_PATTERN,
  PACK_LIMITS,
  PACK_SERVICE_METHOD_PATTERN,
  PACK_SERVICE_NAME_PATTERN,
  PACK_STATUS_TEXT_MAX,
  packCoversHost,
  packFetchAllowed,
  parsePackUrl,
  type PackAppStatus,
  type PackAuthState,
  type PackBridgeReply,
  type PackConnectorState,
  type PackLogLine,
  type PackManifest,
  type PackOptionalPermissions,
} from '@shared/packs'

/** Scripts that read a page for a pack run in their own world, out of the page's reach. */
export const PACK_READ_WORLD = 1263

export interface PackContext {
  packId: string
  /** 'test': a draft running in test_pack's throwaway sandbox. */
  mode: 'installed' | 'test'
  manifest: PackManifest
}

export interface BridgeDeps {
  /** The pack (or draft under test) a sender's session belongs to, while it may run. */
  contextOf(sender: WebContents): PackContext | null
  /** The web page a call acts on: the chat's tab for a tool, the window's last web tab for a panel. */
  targetFor(sender: WebContents, ctx: PackContext): WebContents | null
  /** Whether the sender is the pack's tool host (only it may serve tools). */
  isToolHost(sender: WebContents): boolean
  storage: { read(ctx: PackContext): Record<string, unknown>; write(ctx: PackContext, data: Record<string, unknown>): void }
  log(ctx: PackContext, line: Omit<PackLogLine, 'at'>): void
  notify(ctx: PackContext, n: { title: string; body: string }): void
  ask(ctx: PackContext, prompt: string, system: string | null): Promise<string>
  copy(text: string): void
  open(url: string): void
  /**
   * What the installed version of a pack may already use, for a test run of its
   * draft: a test never gets more network or model access than you granted.
   */
  installedGrants(packId: string): { network: string[]; model: boolean } | null
  /** atelier.env: the pack's public values (docs/apps.md › Your own servers). */
  env?(ctx: PackContext): Record<string, string>
  /** Records a permission a pack just used (an organisation's audit log; a no-op without one). */
  audit?(ctx: PackContext, op: string, detail: string): void
  /** A request's headers with the pack's keys for its host, or null when nothing changes (atelier.fetch, hop by hop). */
  requestHeaders?(ctx: PackContext, url: string, headers: Record<string, string>): Record<string, string> | null
  /** The plugin model (docs/apps.md › Services, Events): checked against the manifests by the runtime. */
  plugin: {
    call(sender: WebContents, ctx: PackContext, service: string, method: string, input: unknown): Promise<unknown>
    provide(sender: WebContents, ctx: PackContext, services: string[]): void
    emit(sender: WebContents, ctx: PackContext, name: string, data: unknown): void
    listen(sender: WebContents, ctx: PackContext, names: string[]): void
    status(sender: WebContents, ctx: PackContext, status: PackAppStatus | null): void
    /** atelier.permissions.request: asks the person for some of the pack's optionalPermissions. */
    request(sender: WebContents, ctx: PackContext, asked: PackOptionalPermissions): Promise<{ granted: boolean }>
    /** atelier.secrets: whether each key has a value (never the value), and asking the person for one. */
    secrets?: {
      status(ctx: PackContext): Record<string, boolean>
      request(sender: WebContents, ctx: PackContext, id: string): Promise<{ set: boolean }>
    }
    /** atelier.connectors: the person's connectors the pack names, as they set each tool. */
    connectors?: {
      status(ctx: PackContext): Record<string, PackConnectorState>
      tools(ctx: PackContext, ref: string): Array<{ name: string; title: string; description: string; readOnly: boolean; inputSchema: unknown }>
      call(sender: WebContents, ctx: PackContext, ref: string, tool: string, input: unknown): Promise<{ text: string; data: unknown; isError: boolean }>
      connect(sender: WebContents, ctx: PackContext, ref: string): null
    }
    /** atelier.auth: the pack's sign-ins (who is signed in, never a token), signing in in a tab, and signing out. */
    auth?: {
      status(ctx: PackContext): Promise<Record<string, PackAuthState>>
      signIn(sender: WebContents, ctx: PackContext, id: string): Promise<PackAuthState>
      signOut(ctx: PackContext, id: string): PackAuthState
    }
    /** atelier.ai (docs/apps.md › Atelier as the AI engine): the model on the person's engine, within the pack's budget. */
    ai: {
      text(ctx: PackContext, r: AiRequest): Promise<string>
      json(ctx: PackContext, r: AiRequest & { schema: Record<string, unknown> }): Promise<unknown>
      /** atelier.ai.decide (docs/decisions.md): typed answers with probabilities. */
      /** `beforeClaude` charges the model budget when the decision model can't answer and the Claude engine does instead. */
      decide(ctx: PackContext, r: DecisionRequest, beforeClaude: (() => void) | null): Promise<{ answers: DecisionResult['answers']; model: string; source: DecisionResult['source'] }>
      /** A decision model is on, so a decide call costs next to nothing and uses its own, larger budget. */
      decidesOnModel(): boolean
      stream(sender: WebContents, ctx: PackContext, r: AiRequest, streamId: string): Promise<string>
      turn(sender: WebContents, ctx: PackContext, r: AiTurn): Promise<{ text: string; history: unknown[] }>
    }
    /** atelier.test.ready: the state a page reports for test_pack's playtest (kept only while a draft is under test). */
    testState(sender: WebContents, ctx: PackContext, state: unknown): void
    /** atelier.cast (docs/apps.md › The cast): the person's companions as characters; lines written in main. */
    cast(sender: WebContents, ctx: PackContext, op: 'cast.members' | 'cast.pick' | 'cast.speak', args: unknown[]): Promise<unknown>
    /** atelier.notifications: notifications set for later, fired while Atelier runs. */
    schedule(ctx: PackContext, op: 'notify.schedule' | 'notify.cancel' | 'notify.list', args: unknown[]): unknown
    /** atelier.files (docs/apps.md › Assets › Your own files): what the person picks, and nothing else on the disk. */
    files(sender: WebContents, ctx: PackContext, op: FilesOp, args: unknown[]): Promise<unknown>
    /** atelier.worlds (the world viewer) and atelier.world.context (an app opened from a world's place). */
    worlds?(sender: WebContents, ctx: PackContext, op: WorldsOp, args: unknown[]): Promise<unknown>
    /** atelier.server (docs/packs.md › A web server of its own): the app page's own web server, run by Atelier. */
    server?(sender: WebContents, ctx: PackContext, op: ServerOp, args: unknown[]): Promise<unknown>
    /** atelier.assets.active: what fills one of the pack's asset slots (null: the app's own files). */
    assets(sender: WebContents, ctx: PackContext, slot: string): { pack: string; packName: string; set: string; setName: string } | null
  }
  fetch?: typeof fetch
  now?: () => number
}

export class BridgeRefusal extends Error {}

/** One atelier.ai request: the model tier the pack asks for, never a model name (Atelier maps tiers to models). */
export interface AiRequest {
  prompt: string
  system: string | null
  tier: 'fast' | 'smart'
  maxTokens: number
}

/** One message of an atelier.ai.session: the conversation so far is the page's, the tools are its own. */
export interface AiTurn {
  system: string | null
  tier: 'fast' | 'smart'
  tools: Array<{ name: string; description: string; input: Record<string, unknown> }>
  history: unknown[]
  text: string
  sessionId: string
}

const aiOptions = z.object({ system: z.string().max(8_000).optional(), tier: z.enum(['fast', 'smart']).optional(), maxTokens: z.number().int().min(1).max(8_000).optional() }).strict()
const aiId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/)

/** The atelier.worlds ops and atelier.world.context; the runtime answers them. */
export type WorldsOp = 'world.context' | 'worlds.list' | 'worlds.get' | 'worlds.save' | 'worlds.remove' | 'worlds.apps' | 'worlds.enter' | 'worlds.speak' | 'worlds.share' | 'worlds.find'
const worldRef = z.string().max(400).refine((r) => parseWorldRef(r) !== null, { error: 'is not a world ref' })
const worldPart = z.string().regex(WORLD_ID_PATTERN)

/** The atelier.files ops; the runtime answers them. */
export type FilesOp = 'files.open' | 'files.save' | 'files.folder' | 'files.list' | 'files.read' | 'files.write' | 'files.own'
const FILES_BYTES = 50 * 1024 * 1024
const fileData = z.union([z.string().max(FILES_BYTES), z.instanceof(Uint8Array).refine((d) => d.byteLength <= FILES_BYTES, { error: 'is larger than 50 MB' })])
const relPath = z.string().max(500)
const accept = z.array(z.string().regex(/^\.?[A-Za-z0-9]{1,12}$/)).max(30).optional()

/** The atelier.server ops; the runtime answers them. */
export type ServerOp = 'server.start' | 'server.stop' | 'server.status' | 'server.respond' | 'server.send' | 'server.close'
const socketId = z.string().regex(SERVER_SOCKET_ID_PATTERN)

const key = z.string().min(1).max(200)
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const ARGS = {
  'storage.get': z.tuple([key]),
  'storage.set': z.tuple([key, z.unknown()]),
  'storage.remove': z.tuple([key]),
  'storage.keys': z.tuple([]),
  'page.info': z.tuple([]),
  'page.text': z.tuple([]),
  'page.query': z.tuple([z.string().min(1).max(500)]),
  fetch: z.tuple([
    z.string().min(1).max(4096),
    z
      .object({
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        headers: z.record(headerName, z.string().max(4096)).optional(),
        body: z.string().max(PACK_LIMITS.fetchBodyBytes).optional(),
      })
      .strict(),
  ]),
  notify: z.tuple([z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(500).optional() }).strict()]),
  'notify.schedule': z.tuple([z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), at: z.number().finite(), title: z.string().trim().min(1).max(120), body: z.string().max(500).optional() }).strict()]),
  'notify.cancel': z.tuple([z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)]),
  'notify.list': z.tuple([]),
  ask: z.tuple([z.string().trim().min(1).max(20_000), z.object({ system: z.string().max(4_000).optional() }).strict()]),
  'clipboard.write': z.tuple([z.string().max(100_000)]),
  open: z.tuple([z.string().min(1).max(4096)]),
  log: z.tuple([z.string().max(10_000)]),
  'services.call': z.tuple([z.string().regex(PACK_SERVICE_NAME_PATTERN), z.string().regex(PACK_SERVICE_METHOD_PATTERN), z.unknown()]),
  'services.provide': z.tuple([z.array(z.string().regex(PACK_SERVICE_NAME_PATTERN)).max(10)]),
  'events.emit': z.tuple([z.string().regex(PACK_EVENT_NAME_PATTERN), z.unknown()]),
  'events.on': z.tuple([z.array(z.string().max(80)).max(30)]),
  'assets.active': z.tuple([z.string().regex(PACK_ITEM_ID_PATTERN)]),
  'test.ready': z.tuple([z.unknown()]),
  'cast.members': z.tuple([]),
  'cast.pick': z.tuple([z.object({ max: z.number().int().min(1).max(8).optional(), title: z.string().max(120).optional() }).strict()]),
  'cast.speak': z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.object({ situation: z.string().trim().min(1).max(1_000), mood: z.string().max(60).optional() }).strict()]),
  'files.open': z.tuple([z.object({ accept, multiple: z.boolean().optional() }).strict()]),
  'files.save': z.tuple([z.string().trim().min(1).max(200), fileData]),
  'files.folder': z.tuple([]),
  'files.list': z.tuple([relPath]),
  'files.read': z.tuple([relPath]),
  'files.write': z.tuple([relPath, fileData]),
  'files.own': z.tuple([z.object({ accept, multiple: z.boolean().optional(), folder: z.boolean().optional(), note: z.string().max(300).optional() }).strict()]),
  'ai.ask': z.tuple([z.string().trim().min(1).max(50_000), aiOptions]),
  'ai.json': z.tuple([z.string().trim().min(1).max(50_000), aiOptions.extend({ schema: z.record(z.string(), z.unknown()) })]),
  'ai.stream': z.tuple([z.string().trim().min(1).max(50_000), aiOptions, aiId]),
  // DC-07: typed questions about a state, answered by the decision model when one is on, otherwise the person's Claude engine.
  'ai.decide': z.tuple([DECISION_REQUEST_SCHEMA.shape.state, DECISION_REQUEST_SCHEMA.shape.questions]),
  'ai.turn': z.tuple([
    z
      .object({
        system: z.string().max(8_000).optional(),
        tier: z.enum(['fast', 'smart']).optional(),
        tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), description: z.string().max(2_000), input: z.record(z.string(), z.unknown()) }).strict()).max(20),
      })
      .strict(),
    z.array(z.unknown()).max(200),
    z.string().max(50_000),
    aiId,
  ]),
  'world.context': z.tuple([]),
  'worlds.list': z.tuple([]),
  'worlds.get': z.tuple([worldRef]),
  'worlds.save': z.tuple([z.record(z.string(), z.unknown()), z.object({ copy: z.boolean().optional() }).strict()]),
  'worlds.remove': z.tuple([worldRef]),
  'worlds.apps': z.tuple([]),
  'worlds.enter': z.tuple([worldRef, worldPart]),
  'worlds.speak': z.tuple([worldRef, worldPart, z.object({ situation: z.string().trim().min(1).max(1_000), mood: z.string().max(60).optional() }).strict()]),
  'worlds.share': z.tuple([worldRef]),
  'worlds.find': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/)]),
  'secrets.status': z.tuple([]),
  'secrets.request': z.tuple([z.string().regex(PACK_ENV_NAME_PATTERN)]),
  'auth.status': z.tuple([]),
  'auth.signIn': z.tuple([z.string().regex(PACK_AUTH_ID_PATTERN)]),
  'auth.signOut': z.tuple([z.string().regex(PACK_AUTH_ID_PATTERN)]),
  'connectors.status': z.tuple([]),
  'connectors.tools': z.tuple([z.string().regex(PACK_CONNECTOR_REF_PATTERN)]),
  'connectors.call': z.tuple([z.string().regex(PACK_CONNECTOR_REF_PATTERN), z.string().min(1).max(128), z.unknown().optional()]),
  'connectors.connect': z.tuple([z.string().regex(PACK_CONNECTOR_REF_PATTERN)]),
  'permissions.request': z.tuple([
    z
      .object({
        sites: z.array(z.string().max(260)).max(20).optional(),
        network: z.array(z.string().max(260)).max(20).optional(),
        notifications: z.boolean().optional(),
        model: z.boolean().optional(),
        clipboard: z.boolean().optional(),
      })
      .strict(),
  ]),
  'server.start': z.tuple([
    z
      .object({
        lan: z.boolean().optional(),
        root: z.string().min(1).max(200).optional(),
        token: z.boolean().optional(),
        maxConnections: z.number().int().min(1).max(SERVER_LIMITS.connections).optional(),
      })
      .strict(),
  ]),
  'server.stop': z.tuple([]),
  'server.status': z.tuple([]),
  'server.respond': z.tuple([
    z.string().regex(SERVER_REQUEST_ID_PATTERN),
    z
      .object({
        status: z.number().int().min(200).max(599).optional(),
        headers: z
          .record(headerName, z.string().max(2_000))
          .refine((h) => Object.keys(h).length <= 30, { error: 'has more than 30 headers' })
          .optional(),
        body: z.string().max(SERVER_LIMITS.responseBytes).nullable().optional(),
      })
      .strict(),
  ]),
  'server.send': z.tuple([z.union([z.literal('*'), z.array(socketId).max(SERVER_LIMITS.connections)]), z.string().max(SERVER_LIMITS.outBytes)]),
  'server.close': z.tuple([socketId, z.number().int().refine((c) => c === 1000 || (c >= 4000 && c <= 4999), { error: 'is 1000 or 4000 to 4999' }).optional()]),
  'status.set': z.tuple([
    z
      .object({
        text: z.string().max(PACK_STATUS_TEXT_MAX).nullable().optional(),
        badge: z.number().int().min(0).max(999).nullable().optional(),
        progress: z.number().min(0).max(1).nullable().optional(),
      })
      .strict()
      .nullable(),
  ]),
} as const

export type BridgeOp = keyof typeof ARGS

/** Ops that use a permission or reach outside the pack: what an audit log records. */
const AUDITED = new Set<string>(['fetch', 'open', 'ask', 'ai.ask', 'ai.json', 'ai.decide', 'ai.stream', 'ai.turn', 'cast.speak', 'worlds.speak', 'notify', 'notify.schedule', 'clipboard.write', 'page.info', 'page.text', 'page.query', 'files.open', 'files.save', 'files.folder', 'files.read', 'files.write', 'files.own', 'services.call', 'secrets.request', 'auth.signIn', 'auth.signOut', 'connectors.call', 'permissions.request', 'worlds.share', 'server.start'])
const hostOf = (url: unknown): string => {
  try {
    return new URL(String(url)).host
  } catch {
    return ''
  }
}

/** Every op the bridge answers; atelier_inspect's catalog lists each (a test checks). */
export const BRIDGE_OPS: readonly string[] = Object.keys(ARGS)

/** Request headers a pack can't set: they'd claim another origin or carry your sign-ins. */
const FORBIDDEN_HEADERS = /^(cookie|cookie2|host|origin|referer|connection|content-length|keep-alive|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*|authorization-atelier.*)$/i

const MODEL_CALLS_PER_HOUR = 60
const MODEL_CALLS_PER_DAY = 500
/** atelier.ai.decide on a decision model: a tiny fraction of a model call, so ten times the budget. On Claude it counts as a model call. */
const DECISIONS_PER_HOUR = 600
const DECISIONS_PER_DAY = 5_000

export interface Bridge {
  run(sender: WebContents, ctx: PackContext, op: string, args: unknown[]): Promise<unknown>
  dispose(): void
}

export function createBridge(deps: BridgeDeps): Bridge {
  const now = deps.now ?? Date.now
  const asks = new Map<string, number[]>()
  const opens = new Map<string, number[]>()
  const doFetch = deps.fetch ?? fetch

  const rate = (map: Map<string, number[]>, id: string, max: number, windowMs: number): boolean => {
    const at = now()
    const recent = (map.get(id) ?? []).filter((t) => at - t < windowMs)
    if (recent.length >= max) return false
    recent.push(at)
    map.set(id, recent)
    return true
  }

  /** The hosts atelier.fetch may reach: the pack's own list, and in a test only what its installed version may already reach (or this computer). */
  const networkFor = (ctx: PackContext): string[] => {
    const own = ctx.manifest.permissions.network
    if (ctx.mode !== 'test') return own
    const granted = deps.installedGrants(ctx.packId)?.network ?? []
    return own.filter((h) => h === 'localhost' || h === '127.0.0.1' || granted.includes(h))
  }

  /** Every model call of a pack counts, atelier.ask and each round of a session alike: 60 an hour and 500 a day (starting values). */
  const budget = (ctx: PackContext, op: string): void => {
    if (!rate(asks, `${ctx.packId}:hour`, MODEL_CALLS_PER_HOUR, 60 * 60_000)) refuse(ctx, op, `A pack can use the model ${MODEL_CALLS_PER_HOUR} times an hour.`)
    if (!rate(asks, `${ctx.packId}:day`, MODEL_CALLS_PER_DAY, 24 * 60 * 60_000)) refuse(ctx, op, `A pack can use the model ${MODEL_CALLS_PER_DAY} times a day.`)
  }

  const refuse = (ctx: PackContext, op: string, why: string): never => {
    deps.log(ctx, { level: 'warn', source: 'bridge', message: `${op} refused: ${why}` })
    throw new BridgeRefusal(why)
  }

  /** Why this pack may not read a page at `url`, or null when it may. */
  const unreadable = (ctx: PackContext, url: string): string | null => {
    const host = pageTweakHost(url)
    if (!host || isSignInUrl(url)) return 'Packs can’t read this page.'
    if (!packCoversHost(ctx.manifest.permissions.sites, host)) return `${host} is not in this pack’s sites.`
    return null
  }

  /**
   * Runs a read in the target page if this pack may read it. The address is
   * checked before, and again from inside the script, so a page that moved on
   * (a redirect, a click) in between is never read.
   */
  const readPage = async (sender: WebContents, ctx: PackContext, op: string, body: string): Promise<unknown> => {
    const target = deps.targetFor(sender, ctx)
    if (!target || target.isDestroyed()) return refuse(ctx, op, 'There is no web page open to read.')
    const before = unreadable(ctx, target.getURL())
    if (before) return refuse(ctx, op, before)
    if (target.isLoadingMainFrame()) return refuse(ctx, op, 'The page is still loading. Try again once it has loaded.')
    const result = (await target.executeJavaScriptInIsolatedWorld(PACK_READ_WORLD, [{ code: `(() => { const href = location.href; const value = (() => { ${body} })(); return { href, value } })()` }])) as { href?: unknown; value?: unknown } | null
    const href = typeof result?.href === 'string' ? result.href : ''
    const after = unreadable(ctx, href)
    if (after) return refuse(ctx, op, after)
    return result?.value
  }

  const run = async (sender: WebContents, ctx: PackContext, op: string, raw: unknown[]): Promise<unknown> => {
    if (!Object.hasOwn(ARGS, op)) return refuse(ctx, op, `atelier has no ${op}.`)
    const parsed = ARGS[op as BridgeOp].safeParse(raw)
    if (!parsed.success) return refuse(ctx, op, `The arguments are wrong: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}`)
    const args = parsed.data as unknown[]
    const p = ctx.manifest.permissions
    switch (op as BridgeOp) {
      case 'storage.get':
        return deps.storage.read(ctx)[args[0] as string] ?? null
      case 'storage.set': {
        const data = deps.storage.read(ctx)
        let value: unknown
        try {
          value = JSON.parse(JSON.stringify(args[1] ?? null))
        } catch {
          return refuse(ctx, op, 'Only what JSON can hold can be stored.')
        }
        data[args[0] as string] = value
        try {
          deps.storage.write(ctx, data)
        } catch (err) {
          return refuse(ctx, op, err instanceof Error ? err.message : String(err))
        }
        return null
      }
      case 'storage.remove': {
        const data = deps.storage.read(ctx)
        delete data[args[0] as string]
        deps.storage.write(ctx, data)
        return null
      }
      case 'storage.keys':
        return Object.keys(deps.storage.read(ctx))
      case 'page.info': {
        const target = deps.targetFor(sender, ctx)
        if (!target || target.isDestroyed()) return null
        const url = target.getURL()
        const host = pageTweakHost(url)
        if (!host || isSignInUrl(url) || !packCoversHost(p.sites, host)) return null
        return { url, title: target.getTitle(), host }
      }
      case 'page.text': {
        const text = await readPage(sender, ctx, op, `return (document.body ? document.body.innerText : '').slice(0, ${PACK_LIMITS.pageTextChars})`)
        return typeof text === 'string' ? text : ''
      }
      case 'page.query': {
        const result = await readPage(sender, ctx, op, `try { return Array.from(document.querySelectorAll(${JSON.stringify(args[0])})).slice(0, ${PACK_LIMITS.queryMatches}).map((e) => (e.innerText || e.textContent || '').trim().slice(0, 2000)) } catch (err) { return { error: 'That selector is not valid.' } }`)
        if (result && typeof result === 'object' && !Array.isArray(result)) return refuse(ctx, op, (result as { error: string }).error)
        return Array.isArray(result) ? result.filter((r) => typeof r === 'string') : []
      }
      case 'fetch': {
        const [url, init] = args as [string, { method?: string; headers?: Record<string, string>; body?: string }]
        const network = networkFor(ctx)
        if (network.length === 0) return refuse(ctx, op, ctx.mode === 'test' ? 'In test_pack, atelier.fetch reaches only this computer and hosts an installed version of this pack may already use.' : 'This pack has no network permission.')
        return packFetch({ url, init, network, doFetch, refuse: (why) => refuse(ctx, op, why), headersFor: deps.requestHeaders ? (at, h) => deps.requestHeaders?.(ctx, at, h) ?? null : undefined })
      }
      case 'notify': {
        if (!p.notifications) return refuse(ctx, op, 'This pack has no notifications permission.')
        const n = args[0] as { title: string; body?: string }
        deps.notify(ctx, { title: n.title, body: n.body ?? '' })
        return null
      }
      case 'ask': {
        if (!p.model) return refuse(ctx, op, 'This pack has no model permission.')
        // A test never spends your model account on a pack you haven't allowed to: it gets a stand-in answer.
        if (ctx.mode === 'test' && !deps.installedGrants(ctx.packId)?.model) return '[test_pack: atelier.ask doesn’t run in a test of a pack you haven’t allowed to ask the model. This stands in for its answer.]'
        budget(ctx, op)
        const [prompt, options] = args as [string, { system?: string }]
        deps.log(ctx, { level: 'info', source: 'bridge', message: `ask (${prompt.length} characters)` })
        return deps.ask(ctx, prompt, options.system?.trim() || null)
      }
      case 'ai.decide': {
        if (!p.model) return refuse(ctx, op, 'This pack has no model permission.')
        if (ctx.mode === 'test' && !deps.installedGrants(ctx.packId)?.model) return null
        const onModel = deps.plugin.ai.decidesOnModel()
        if (onModel) {
          if (!rate(asks, `${ctx.packId}:decide-hour`, DECISIONS_PER_HOUR, 60 * 60_000)) refuse(ctx, op, `A pack can ask ${DECISIONS_PER_HOUR} quick decisions an hour.`)
          if (!rate(asks, `${ctx.packId}:decide-day`, DECISIONS_PER_DAY, 24 * 60 * 60_000)) refuse(ctx, op, `A pack can ask ${DECISIONS_PER_DAY} quick decisions a day.`)
        } else {
          budget(ctx, op)
        }
        const [state, questions] = args as [DecisionRequest['state'], DecisionRequest['questions']]
        deps.log(ctx, { level: 'info', source: 'bridge', message: `ai.decide (${Object.keys(questions).length} questions)` })
        // An unreachable or rate-limited decision model hands the call to the Claude engine, which costs a model call.
        return deps.plugin.ai.decide(ctx, { state, questions }, onModel ? () => budget(ctx, op) : null)
      }
      case 'ai.ask':
      case 'ai.json':
      case 'ai.stream':
      case 'ai.turn': {
        if (!p.model) return refuse(ctx, op, 'This pack has no model permission.')
        if (ctx.mode === 'test' && !deps.installedGrants(ctx.packId)?.model) return op === 'ai.turn' ? { text: '[test_pack: atelier.ai doesn’t run in a test of a pack you haven’t allowed to use the model.]', history: [] } : op === 'ai.json' ? null : '[test_pack: atelier.ai doesn’t run in a test of a pack you haven’t allowed to use the model. This stands in for its answer.]'
        budget(ctx, op)
        if (op === 'ai.turn') {
          const [def, history, text, sessionId] = args as [{ system?: string; tier?: 'fast' | 'smart'; tools: AiTurn['tools'] }, unknown[], string, string]
          deps.log(ctx, { level: 'info', source: 'bridge', message: `ai.turn (${text.length} characters, ${def.tools.length} tools)` })
          return deps.plugin.ai.turn(sender, ctx, { system: def.system?.trim() || null, tier: def.tier ?? 'fast', tools: def.tools, history, text, sessionId })
        }
        const [prompt, options, streamId] = args as [string, { system?: string; tier?: 'fast' | 'smart'; maxTokens?: number; schema?: Record<string, unknown> }, string | undefined]
        const r: AiRequest = { prompt, system: options.system?.trim() || null, tier: options.tier ?? 'fast', maxTokens: options.maxTokens ?? 2_000 }
        deps.log(ctx, { level: 'info', source: 'bridge', message: `${op} (${prompt.length} characters)` })
        if (op === 'ai.json') return deps.plugin.ai.json(ctx, { ...r, schema: options.schema ?? {} })
        if (op === 'ai.stream') return deps.plugin.ai.stream(sender, ctx, r, streamId as string)
        return deps.plugin.ai.text(ctx, r)
      }
      case 'notify.schedule':
      case 'notify.cancel':
      case 'notify.list':
        if (!p.notifications) return refuse(ctx, op, 'This pack has no notifications permission.')
        if (ctx.mode === 'test') return op === 'notify.list' ? [] : null
        return deps.plugin.schedule(ctx, op as 'notify.schedule' | 'notify.cancel' | 'notify.list', args)
      case 'clipboard.write': {
        if (!p.clipboard) return refuse(ctx, op, 'This pack has no clipboard permission.')
        deps.copy(args[0] as string)
        return null
      }
      case 'open': {
        const url = args[0] as string
        if (!/^https?:\/\//i.test(url)) return refuse(ctx, op, 'Only http and https addresses open.')
        try {
          new URL(url)
        } catch {
          return refuse(ctx, op, 'That address is not valid.')
        }
        // An address can carry what a pack read, so it opens only where the pack may already send requests.
        if (!packFetchAllowed(p.network, url)) return refuse(ctx, op, 'A pack opens only addresses on hosts in its network permission.')
        if (ctx.mode === 'test') return null
        if (!rate(opens, ctx.packId, PACK_LIMITS.opensPerMinute, 60_000)) return refuse(ctx, op, `A pack can open ${PACK_LIMITS.opensPerMinute} tabs a minute.`)
        deps.open(url)
        return null
      }
      case 'log':
        deps.log(ctx, { level: 'info', source: deps.isToolHost(sender) ? 'tool' : 'panel', message: args[0] as string })
        return null
      case 'services.call': {
        const [service, method, input] = args as [string, string, unknown]
        return deps.plugin.call(sender, ctx, service, method, input)
      }
      case 'services.provide':
        deps.plugin.provide(sender, ctx, args[0] as string[])
        return null
      case 'events.emit':
        deps.plugin.emit(sender, ctx, args[0] as string, args[1])
        return null
      case 'events.on':
        deps.plugin.listen(sender, ctx, args[0] as string[])
        return null
      case 'test.ready':
        if (ctx.mode === 'test') deps.plugin.testState(sender, ctx, args[0])
        return null
      case 'cast.members':
      case 'cast.pick':
        if (ctx.mode === 'test') return []
        return deps.plugin.cast(sender, ctx, op as 'cast.members' | 'cast.pick' | 'cast.speak', args)
      case 'cast.speak':
        if (!p.model || !p.speak) return refuse(ctx, op, 'This pack has no speak permission (it needs model and speak).')
        if (ctx.mode === 'test') return '[test_pack: a companion’s line stands in here.]'
        budget(ctx, op)
        return deps.plugin.cast(sender, ctx, op as 'cast.members' | 'cast.pick' | 'cast.speak', args)
      case 'files.open':
      case 'files.save':
      case 'files.folder':
      case 'files.list':
      case 'files.read':
      case 'files.write':
      case 'files.own':
        if (!p.files) return refuse(ctx, op, 'This pack has no files permission.')
        if (ctx.mode === 'test') return refuse(ctx, op, 'atelier.files isn’t used in test_pack: nobody is there to pick a file.')
        return deps.plugin.files(sender, ctx, op as FilesOp, args)
      case 'assets.active':
        return deps.plugin.assets(sender, ctx, args[0] as string)
      case 'permissions.request':
        return deps.plugin.request(sender, ctx, args[0] as PackOptionalPermissions)
      case 'world.context':
        if (ctx.mode === 'test' || !deps.plugin.worlds) return null
        return deps.plugin.worlds(sender, ctx, 'world.context', args)
      case 'worlds.list':
      case 'worlds.get':
      case 'worlds.save':
      case 'worlds.remove':
      case 'worlds.apps':
      case 'worlds.enter':
      case 'worlds.speak':
      case 'worlds.share':
      case 'worlds.find':
        if (!p.worlds || !deps.plugin.worlds) return refuse(ctx, op, 'This pack has no worlds permission.')
        // A test reads worlds but never changes, opens or shares one.
        if (ctx.mode === 'test' && op !== 'worlds.list' && op !== 'worlds.get' && op !== 'worlds.apps') return refuse(ctx, op, 'In test_pack, atelier.worlds only reads.')
        if (op === 'worlds.speak') {
          if (!p.model || !p.speak) return refuse(ctx, op, 'Residents speak through the model: this pack needs model and speak.')
          budget(ctx, op)
        }
        return deps.plugin.worlds(sender, ctx, op as WorldsOp, args)
      case 'secrets.status':
        return deps.plugin.secrets?.status(ctx) ?? {}
      case 'secrets.request':
        if (!deps.plugin.secrets) return refuse(ctx, op, 'Keys aren’t available here.')
        return deps.plugin.secrets.request(sender, ctx, args[0] as string)
      case 'connectors.status':
      case 'connectors.tools':
      case 'connectors.call':
      case 'connectors.connect': {
        const refs = ctx.manifest.permissions.connectors ?? []
        if (op === 'connectors.status') return ctx.mode === 'test' || !deps.plugin.connectors ? Object.fromEntries(refs.map((r) => [r, { connected: false, name: null }])) : deps.plugin.connectors.status(ctx)
        const ref = args[0] as string
        if (!refs.includes(ref)) return refuse(ctx, op, `${ref} is not in this pack’s permissions.connectors.`)
        if (!deps.plugin.connectors) return refuse(ctx, op, 'Connectors aren’t available here.')
        if (ctx.mode === 'test') return op === 'connectors.tools' ? [] : refuse(ctx, op, 'In test_pack, apps use no connectors: atelier.connectors.status() says none is connected.')
        if (op === 'connectors.tools') return deps.plugin.connectors.tools(ctx, ref)
        if (op === 'connectors.connect') return deps.plugin.connectors.connect(sender, ctx, ref)
        return deps.plugin.connectors.call(sender, ctx, ref, args[1] as string, args[2] ?? {})
      }
      case 'auth.status':
        return deps.plugin.auth?.status(ctx) ?? {}
      case 'auth.signIn':
      case 'auth.signOut': {
        if (!deps.plugin.auth) return refuse(ctx, op, 'Sign-ins aren’t available here.')
        if (ctx.mode === 'test') return refuse(ctx, op, 'In test_pack, nobody signs in: atelier.auth.status() says signed out.')
        const id = args[0] as string
        if (!(ctx.manifest.auth ?? []).some((a) => a.id === id)) return refuse(ctx, op, `${id} is not in this pack’s auth.`)
        return op === 'auth.signIn' ? deps.plugin.auth.signIn(sender, ctx, id) : deps.plugin.auth.signOut(ctx, id)
      }
      case 'server.start':
      case 'server.stop':
      case 'server.status':
      case 'server.respond':
      case 'server.send':
      case 'server.close': {
        const server = p.server
        if (!server) return refuse(ctx, op, 'This pack has no server permission: add "server": {} to permissions.')
        if (op === 'server.start' && (args[0] as { lan?: boolean }).lan === true && !server.lan) return refuse(ctx, op, 'This pack may only serve this computer: permissions.server has no "lan": true.')
        if (op === 'server.start' && (args[0] as { lan?: boolean }).lan === true && ctx.mode === 'test') return refuse(ctx, op, 'In test_pack, a server runs on this computer only.')
        if (!deps.plugin.server) return refuse(ctx, op, 'Web servers aren’t available here.')
        return deps.plugin.server(sender, ctx, op as ServerOp, args)
      }
      case 'status.set': {
        const s = args[0] as { text?: string | null; badge?: number | null; progress?: number | null } | null
        deps.plugin.status(sender, ctx, s ? { text: s.text?.trim() || null, badge: s.badge ?? null, progress: s.progress ?? null } : null)
        return null
      }
    }
  }

  const onInvoke = async (event: IpcMainInvokeEvent, payload: unknown): Promise<PackBridgeReply> => {
    const ctx = checkSender(event, deps)
    if (!ctx) return { ok: false, error: `${BRAND_NAME} refused this call.` }
    const message = z.object({ op: z.string().max(40), args: z.array(z.unknown()).max(5) }).safeParse(payload)
    if (!message.success) return { ok: false, error: `${BRAND_NAME} refused this call.` }
    try {
      const value = await run(event.sender, ctx, message.data.op, message.data.args)
      const op = message.data.op
      if (deps.audit && AUDITED.has(op)) deps.audit(ctx, op, op === 'fetch' || op === 'open' ? hostOf(message.data.args[0]) : op === 'services.call' ? String(message.data.args[0] ?? '') : op === 'connectors.call' ? `${String(message.data.args[0] ?? '')} ${String(message.data.args[1] ?? '')}` : '')
      return { ok: true, value }
    } catch (err) {
      if (!(err instanceof BridgeRefusal)) deps.log(ctx, { level: 'error', source: 'bridge', message: `${message.data.op} failed: ${err instanceof Error ? err.message : String(err)}` })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const onInfo = (event: IpcMainEvent): void => {
    const ctx = checkSender(event, deps)
    event.returnValue = ctx ? { id: ctx.packId, name: ctx.manifest.name, version: ctx.manifest.version, env: deps.env?.(ctx) ?? {} } : null
  }

  ipcMain.handle(PACK_IPC.bridge, onInvoke)
  ipcMain.on(PACK_IPC.info, onInfo)
  return {
    run,
    dispose() {
      ipcMain.removeHandler(PACK_IPC.bridge)
      ipcMain.off(PACK_IPC.info, onInfo)
    },
  }
}

/** The pack context of a sender that is the top frame of its own pack's page, or null. */
export function checkSender(event: { sender: WebContents; senderFrame: unknown }, deps: Pick<BridgeDeps, 'contextOf'>): PackContext | null {
  const sender = event.sender
  if (sender.isDestroyed() || event.senderFrame !== sender.mainFrame) return null
  const ctx = deps.contextOf(sender)
  if (!ctx) return null
  const at = parsePackUrl(sender.getURL())
  if (!at || at.packId !== ctx.packId) return null
  return ctx
}

/** atelier.fetch: allowlisted hosts only, redirects re-checked hop by hop (keys too), no cookies, capped size and time. */
export async function packFetch(input: {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
  network: readonly string[]
  doFetch: typeof fetch
  refuse(why: string): never
  /** The headers to send to one address: the pack's keys added for their hosts (docs/apps.md › Keys); null when unchanged. */
  headersFor?(url: string, headers: Record<string, string>): Record<string, string> | null
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string; url: string }> {
  let url = input.url
  let method = input.init.method ?? 'GET'
  let body = input.init.body
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.init.headers ?? {})) if (!FORBIDDEN_HEADERS.test(name)) headers[name] = value
  for (let hop = 0; hop < 5; hop++) {
    if (!packFetchAllowed(input.network, url)) {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        // Keep the raw text.
      }
      return input.refuse(`${host} is not in this pack’s network permission (https only, or http on localhost).`)
    }
    const res = await input.doFetch(url, {
      method,
      headers: input.headersFor?.(url, headers) ?? headers,
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(PACK_LIMITS.fetchTimeoutMs),
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    const text = await readCapped(res, PACK_LIMITS.fetchBytes, input.refuse)
    const out: Record<string, string> = {}
    res.headers.forEach((value, name) => {
      if (!/^set-cookie/i.test(name)) out[name] = value
    })
    return { status: res.status, statusText: res.statusText, headers: out, body: text, url }
  }
  return input.refuse('Too many redirects.')
}

async function readCapped(res: Response, max: number, refuse: (why: string) => never): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return refuse(`The response is larger than ${max / 1024 / 1024} MB.`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}
