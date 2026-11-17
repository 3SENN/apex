/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// window.atelier in a pack's pages and tool host (docs/packs.md › The sandbox and
// the bridge). A session frame preload on each pack's partition; sandboxed,
// so it requires nothing but electron. It holds no power of its own: every
// call goes to main as one op, and main checks the sender, the pack and the
// permission before doing anything.
import { BRAND_NAME } from '@shared/branding'
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { PACK_IPC, type PackBridgeReply, type PackEventMessage, type PackServiceCallMessage, type PackToolCallMessage } from '@shared/packs'
import { SERVER_EVENT_BATCH, type ServerEvent, type ServerRequestInfo, type ServerStopReason } from '@shared/localServer'

type ToolHandler = (name: string, input: unknown, ctx: PackToolCallMessage['ctx']) => unknown

const info = location.protocol === 'atelier-pack:' && window.top === window ? (ipcRenderer.sendSync(PACK_IPC.info) as { id: string; name: string; version: string; env?: Record<string, string> } | null) : null

async function call(op: string, ...args: unknown[]): Promise<unknown> {
  const reply = (await ipcRenderer.invoke(PACK_IPC.bridge, { op, args })) as PackBridgeReply | undefined
  if (reply && reply.ok) return reply.value
  throw new Error(reply && !reply.ok ? reply.error : `${BRAND_NAME} refused this call.`)
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

let toolHandler: ToolHandler | null = null

type ServiceHandlers = Record<string, (input: unknown, ctx: { from: string }) => unknown>
const services = new Map<string, ServiceHandlers>()
const listeners = new Map<string, Set<(data: unknown, name: string) => void>>()

/** Only what JSON can hold goes back to main. */
const jsonOnly = (value: unknown): unknown => {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value))
  } catch {
    return text(value)
  }
}

ipcRenderer.on(PACK_IPC.serviceCall, (_event, message: PackServiceCallMessage) => {
  const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }): void => ipcRenderer.send(PACK_IPC.serviceResult, { callId: message.callId, ...result })
  const fn = services.get(message.service)?.[message.method]
  if (typeof fn !== 'function') return reply({ ok: false, error: `This page doesn’t serve ${message.service}.${message.method}.` })
  Promise.resolve()
    .then(() => fn(message.input, { from: message.from }))
    .then((value) => reply({ ok: true, value: jsonOnly(value) }))
    .catch((err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : text(err) }))
})

let lastTestState = ''
let lastTestSent = 0
let testTimer: ReturnType<typeof setTimeout> | null = null

const streams = new Map<string, { onText: ((text: string) => void) | null; done(): void }>()
const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

ipcRenderer.on(PACK_IPC.aiChunk, (_event, message: { streamId: string; text?: string; done?: boolean }) => {
  const stream = streams.get(message.streamId)
  if (!stream) return
  if (message.done) return stream.done()
  try {
    if (typeof message.text === 'string') stream.onText?.(message.text)
  } catch (err) {
    void call('log', `An atelier.ai.stream onText threw: ${text(err)}`).catch(() => undefined)
  }
})

// ---- atelier.server: the app page's own web server (docs/packs.md › A web server of its own) ----

type ServerMessageFn = (value: unknown, text: string) => void
interface ServerSocketEntry {
  socket: Record<string, unknown>
  message: Set<ServerMessageFn>
  close: Set<(code: number) => void>
}
const serverSockets = new Map<string, ServerSocketEntry>()
const connectionHandlers = new Set<(socket: Record<string, unknown>) => void>()
const stopHandlers = new Set<(reason: ServerStopReason) => void>()
let requestHandler: ((req: Omit<ServerRequestInfo, 'id'>) => unknown) | null = null

/** Text goes as it is; anything else as JSON. */
const wire = (data: unknown): string => (typeof data === 'string' ? data : JSON.stringify(data ?? null))
/** A message as the page gets it: parsed when it is JSON, else the text (and the text, always). */
const unwire = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const safely = (what: string, fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    void call('log', `An atelier.server ${what} handler threw: ${text(err)}`).catch(() => undefined)
  }
}

/** A request's answer from what the handler returned: text, { status, headers, body } (a non-text body as JSON), or any other value as JSON. */
function answerOf(out: unknown): { status: number; headers: Record<string, string>; body: string } {
  if (out === undefined || out === null) return { status: 404, headers: {}, body: 'Not found.' }
  if (typeof out === 'string') return { status: 200, headers: {}, body: out }
  const shaped = typeof out === 'object' && !Array.isArray(out) && ['status', 'headers', 'body'].some((k) => Object.hasOwn(out, k))
  const o = (shaped ? out : { body: out }) as { status?: unknown; headers?: unknown; body?: unknown }
  const headers: Record<string, string> = {}
  if (o.headers && typeof o.headers === 'object') for (const [k, v] of Object.entries(o.headers)) if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v)
  let body = ''
  if (typeof o.body === 'string') body = o.body
  else if (o.body !== undefined && o.body !== null) {
    body = JSON.stringify(o.body)
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json; charset=utf-8'
  }
  const status = o.status === undefined ? 200 : typeof o.status === 'number' && Number.isInteger(o.status) && o.status >= 200 && o.status <= 599 ? o.status : 500
  return { status, headers, body }
}

function answerRequest(req: ServerRequestInfo): void {
  const reply = (answer: { status: number; headers: Record<string, string>; body: string }): void =>
    void call('server.respond', req.id, answer).catch((err: unknown) => {
      // An answer Atelier refused (a header it doesn't take, too large) still ends the request.
      void call('log', `atelier.server.onRequest's answer for ${req.method} ${req.path} was refused: ${text(err)}`).catch(() => undefined)
      void call('server.respond', req.id, { status: 500, headers: {}, body: 'The app’s answer could not be sent.' }).catch(() => undefined)
    })
  const handler = requestHandler
  if (!handler) return reply({ status: 404, headers: {}, body: 'Not found.' })
  const { id: _id, type: _type, ...shown } = req as ServerRequestInfo & { type?: string }
  Promise.resolve()
    .then(() => handler(shown))
    .then((out) => reply(answerOf(out)))
    .catch((err: unknown) => {
      void call('log', `atelier.server.onRequest threw for ${req.method} ${req.path}: ${text(err)}`).catch(() => undefined)
      reply({ status: 500, headers: {}, body: 'The app could not answer.' })
    })
}

function serverEvent(e: ServerEvent): void {
  if (e.type === 'connection') {
    const entry: ServerSocketEntry = { socket: {}, message: new Set(), close: new Set() }
    entry.socket = {
      id: e.id,
      query: { ...e.query },
      remote: e.remote,
      send: (data: unknown) => call('server.send', [e.id], wire(data)),
      close: (code?: number) => call('server.close', e.id, ...(code === undefined ? [] : [code])),
      onMessage: (fn: ServerMessageFn) => {
        if (typeof fn !== 'function') throw new Error('socket.onMessage takes a function.')
        entry.message.add(fn)
        return () => entry.message.delete(fn)
      },
      onClose: (fn: (code: number) => void) => {
        if (typeof fn !== 'function') throw new Error('socket.onClose takes a function.')
        entry.close.add(fn)
        return () => entry.close.delete(fn)
      },
    }
    serverSockets.set(e.id, entry)
    for (const fn of connectionHandlers) safely('onConnection', () => fn(entry.socket))
  } else if (e.type === 'message') {
    const entry = serverSockets.get(e.id)
    if (!entry) return
    const value = unwire(e.data)
    for (const fn of entry.message) safely('onMessage', () => fn(value, e.data))
  } else if (e.type === 'close') {
    const entry = serverSockets.get(e.id)
    serverSockets.delete(e.id)
    for (const fn of entry?.close ?? []) safely('onClose', () => fn(e.code))
  } else if (e.type === 'request') {
    answerRequest(e)
  } else if (e.type === 'stopped') {
    const open = [...serverSockets.values()]
    serverSockets.clear()
    for (const entry of open) for (const fn of entry.close) safely('onClose', () => fn(1001))
    for (const fn of stopHandlers) safely('onStop', () => fn(e.reason))
  }
}

ipcRenderer.on(PACK_IPC.event, (_event, message: PackEventMessage) => {
  // The server's events come from main in batches, in order; nothing a pack sends has this name.
  if (message.name === SERVER_EVENT_BATCH) {
    if (Array.isArray(message.data)) for (const e of message.data as ServerEvent[]) serverEvent(e)
    return
  }
  for (const fn of listeners.get(message.name) ?? []) {
    try {
      fn(message.data, message.name)
    } catch (err) {
      void call('log', `An events.on listener for ${message.name} threw: ${text(err)}`).catch(() => undefined)
    }
  }
})

ipcRenderer.on(PACK_IPC.toolCall, (_event, message: PackToolCallMessage) => {
  const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }): void => ipcRenderer.send(PACK_IPC.toolResult, { callId: message.callId, ...result })
  if (!toolHandler) return reply({ ok: false, error: 'The pack’s tool host is not ready.' })
  Promise.resolve()
    .then(() => (toolHandler as ToolHandler)(message.name, message.input, message.ctx))
    .then((value) => {
      // Only what JSON can hold goes back.
      let safe: unknown
      try {
        safe = value === undefined ? null : JSON.parse(JSON.stringify(value))
      } catch {
        safe = text(value)
      }
      reply({ ok: true, value: safe })
    })
    .catch((err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : text(err) }))
})

if (info) {
  // WebRTC can reach STUN and TURN servers outside every request check; a pack has no use for it.
  void webFrame.executeJavaScript(
    "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription']) { try { delete window[name] } catch {} ; try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }) } catch {} }",
  )
  contextBridge.exposeInMainWorld('atelier', {
    pack: Object.freeze({ id: info.id, name: info.name, version: info.version }),
    /** Public values from the manifest's env (a linked folder's .env overrides them while you develop). Never keys: those are secrets. */
    env: Object.freeze({ ...(info.env ?? {}) }),
    secrets: {
      /** Whether each of the manifest's secrets has a value: { NAME: true | false }. Never the values: Atelier adds them to requests to their hosts. */
      status: () => call('secrets.status'),
      /** Opens the pack's page so the person can enter a key; resolves to { set } once they save it (or { set: false } after a while). */
      request: (id: string) => call('secrets.request', id),
    },
    /**
     * The person's connectors named in permissions.connectors (atlassian,
     * github, or a server's name). Each tool runs as they set it in
     * Connectors: off refuses, "ask" asks them each time.
     */
    connectors: {
      /** { ref: { connected, name } } for each connector the pack names. */
      status: () => call('connectors.status'),
      /** The tools the person has on: [{ name, title, description, readOnly, inputSchema }]. */
      tools: (ref: string) => call('connectors.tools', ref),
      /** Runs a tool: { text, data (its structured result, or null), isError }. */
      call: (ref: string, tool: string, input?: unknown) => call('connectors.call', ref, tool, input ?? {}),
      /** Opens Atelier's Connectors at this one, so the person can connect it. */
      connect: (ref: string) => call('connectors.connect', ref),
    },
    /**
     * The manifest's sign-ins: Atelier runs them in a tab, keeps the tokens and
     * sends the access token on requests to each sign-in's hosts. Your code
     * never sees a token; status says who is signed in.
     */
    auth: {
      /** { id: { signedIn, user } } for each of the manifest's auth entries; refreshes a token that is due first. */
      status: () => call('auth.status'),
      /** Opens the identity provider in a tab; resolves { signedIn, user } once the person is signed in (rejects when they cancel). */
      signIn: (id: string) => call('auth.signIn', id),
      /** Forgets the sign-in on this computer: requests go without a token from then on. */
      signOut: (id: string) => call('auth.signOut', id),
    },
    storage: {
      get: (key: string) => call('storage.get', key),
      set: (key: string, value: unknown) => call('storage.set', key, value),
      remove: (key: string) => call('storage.remove', key),
      keys: () => call('storage.keys'),
    },
    page: {
      info: () => call('page.info'),
      text: () => call('page.text'),
      query: (selector: string) => call('page.query', selector),
    },
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const res = (await call('fetch', url, init ?? {})) as { status: number; statusText: string; headers: Record<string, string>; body: string; url: string }
      return {
        ...res,
        ok: res.status >= 200 && res.status < 300,
        text: async () => res.body,
        json: async () => JSON.parse(res.body) as unknown,
      }
    },
    notify: (n: { title: string; body?: string }) => call('notify', n),
    notifications: {
      /** Sets a notification for later (`at`: ms since the epoch); the same id replaces it. Fires while Atelier runs, even with the app closed. */
      schedule: (n: { id: string; at: number; title: string; body?: string }) => call('notify.schedule', n),
      cancel: (id: string) => call('notify.cancel', id),
      list: () => call('notify.list'),
    },
    ask: (prompt: string, options?: { system?: string }) => call('ask', prompt, options ?? {}),
    clipboard: { write: (value: string) => call('clipboard.write', value) },
    open: (url: string) => call('open', url),
    log: (...values: unknown[]) => call('log', values.map(text).join(' ')),
    services: {
      call: (service: string, method: string, input?: unknown) => call('services.call', service, method, input ?? {}),
      /** Serves one of the pack's services from this page while it is open: an object of async methods. */
      provide: (service: string, handlers: ServiceHandlers) => {
        if (!handlers || typeof handlers !== 'object') throw new Error('atelier.services.provide takes a service name and an object of methods.')
        services.set(service, { ...handlers })
        return call('services.provide', [...services.keys()])
      },
    },
    events: {
      /** Hears an event listed in the manifest's events.on; returns a function that stops listening. */
      on: (name: string, fn: (data: unknown, name: string) => void) => {
        if (typeof fn !== 'function') throw new Error('atelier.events.on takes an event name and a function.')
        const set = listeners.get(name) ?? new Set()
        set.add(fn)
        listeners.set(name, set)
        void call('events.on', [...listeners.keys()]).catch((err: unknown) => console.error(err))
        return () => {
          set.delete(fn)
          if (set.size === 0) listeners.delete(name)
          void call('events.on', [...listeners.keys()]).catch(() => undefined)
        }
      },
      emit: (name: string, data?: unknown) => call('events.emit', name, data ?? null),
    },
    ai: {
      ask: (prompt: string, options?: { system?: string; tier?: 'fast' | 'smart'; maxTokens?: number }) => call('ai.ask', prompt, options ?? {}),
      json: (prompt: string, options: { schema: Record<string, unknown>; system?: string; tier?: 'fast' | 'smart'; maxTokens?: number }) => call('ai.json', prompt, options ?? {}),
      /** Typed questions (noul: yes or no, choice, score) about a state: probabilities back, no text (docs/decisions.md). */
      decide: (state: string | Record<string, unknown>, questions: Record<string, unknown>) => call('ai.decide', state, questions),
      /** The reply as it arrives: onText gets each piece; resolves to all of it. */
      stream: async (prompt: string, options?: { onText?: (text: string) => void; system?: string; tier?: 'fast' | 'smart'; maxTokens?: number }) => {
        const { onText, ...rest } = options ?? {}
        const id = newId()
        // The last piece and the end marker share a channel, so waiting for the marker means every piece arrived.
        let markDone: () => void = () => undefined
        const ended = new Promise<void>((resolve) => (markDone = resolve))
        streams.set(id, { onText: typeof onText === 'function' ? onText : null, done: () => markDone() })
        try {
          const all = await call('ai.stream', prompt, rest, id)
          await Promise.race([ended, new Promise((r) => setTimeout(r, 2_000))])
          return all
        } finally {
          streams.delete(id)
        }
      },
      /** A conversation that may use the page's own tools: each tool's run(input) answers when the model calls it. */
      session: (def: { system?: string; tier?: 'fast' | 'smart'; tools?: Array<{ name: string; description: string; input?: Record<string, unknown>; run: (input: unknown) => unknown }> }) => {
        const id = newId()
        const tools = def?.tools ?? []
        const handlers: ServiceHandlers = {}
        for (const t of tools) if (typeof t.run === 'function') handlers[t.name] = (input) => t.run(input)
        services.set(`__session:${id}`, handlers)
        let history: unknown[] = []
        return {
          send: async (message: string) => {
            const reply = (await call('ai.turn', { ...(def?.system ? { system: def.system } : {}), ...(def?.tier ? { tier: def.tier } : {}), tools: tools.map((t) => ({ name: t.name, description: t.description, input: t.input ?? { type: 'object' } })) }, history, message, id)) as { text: string; history: unknown[] }
            history = reply.history
            return reply.text
          },
          history: () => JSON.parse(JSON.stringify(history)) as unknown,
          close: () => void services.delete(`__session:${id}`),
        }
      },
    },
    test: {
      /** The app's state for test_pack's playtest; cheap to call every frame (sent only when it changes, four times a second at most). */
      ready: (state: unknown) => {
        let json: string
        try {
          json = JSON.stringify(state ?? null)
        } catch {
          return
        }
        if (json === lastTestState || json.length > 64_000) return
        lastTestState = json
        const now = Date.now()
        if (now - lastTestSent < 250) {
          if (!testTimer) testTimer = setTimeout(() => {
            testTimer = null
            lastTestSent = Date.now()
            void call('test.ready', JSON.parse(lastTestState)).catch(() => undefined)
          }, 250)
          return
        }
        lastTestSent = now
        void call('test.ready', JSON.parse(json)).catch(() => undefined)
      },
    },
    cast: {
      /** The companions playing in this app: [{ ref, name, rig, look }]; the active one until the person picks. */
      members: () => call('cast.members'),
      /** Asks the person who plays (up to the app's cast.max); resolves to the new members. */
      pick: (options?: { max?: number; title?: string }) => call('cast.pick', options ?? {}),
      /** One line a member says about what just happened, in character, written by Atelier from its personality. */
      speak: (ref: string, options: { situation: string; mood?: string }) => call('cast.speak', ref, options),
    },
    files: {
      /** Files the person picks: [{ name, size, data }] (data a Uint8Array). */
      open: (options?: { accept?: string[]; multiple?: boolean }) => call('files.open', options ?? {}),
      /** Saves text or bytes where the person says: { saved, name }. */
      save: (name: string, data: string | Uint8Array) => call('files.save', name, data),
      /** Asks once for a folder the app may read and write; { name }, or null when the person doesn't pick one. */
      folder: () => call('files.folder'),
      list: (path = '') => call('files.list', path),
      read: (path: string) => call('files.read', path),
      write: (path: string, data: string | Uint8Array) => call('files.write', path, data),
      /** Copies files of the person's own into the app's private space: { files } (paths for ownUrl). */
      own: (options?: { accept?: string[]; multiple?: boolean; folder?: boolean; note?: string }) => call('files.own', options ?? {}),
      ownUrl: (path: string) => `${location.origin}/__atelier/own/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    },
    assets: {
      /** What fills one of this app's asset slots now: { pack, packName, set, setName }, or null for the app's own files. */
      active: (slot: string) => call('assets.active', slot),
      /** Where to read one of a slot's files: the chosen asset pack's, else the app's own (its slot's layout). */
      url: (slot: string, path: string) => `${location.origin}/__atelier/assets/${encodeURIComponent(slot)}/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    },
    world: {
      /** Where this app was opened from: { world, place, cast } when a world's place opened it, else null. */
      context: () => call('world.context'),
    },
    worlds: {
      /** Every world: yours, then those packs bring (permissions.worlds). */
      list: () => call('worlds.list'),
      /** A world and who fills its open spots: { world, residents, editable }. */
      get: (ref: string) => call('worlds.get', ref),
      /** Saves a world as yours; { copy: true } saves it under a new id (a new world, or a pack's). */
      save: (world: Record<string, unknown>, options?: { copy?: boolean }) => call('worlds.save', world, options ?? {}),
      remove: (ref: string) => call('worlds.remove', ref),
      /** The apps a place can open. */
      apps: () => call('worlds.apps'),
      /** Opens a place's app with the residents there as its cast: { opened } or { opened: false, missing }. */
      enter: (ref: string, placeId: string) => call('worlds.enter', ref, placeId),
      /** One line from a resident, in character (model and speak). */
      speak: (ref: string, residentId: string, options: { situation: string; mood?: string }) => call('worlds.speak', ref, residentId, options),
      /** Opens Browse at a pack: what a place opens, when the person doesn't have it. */
      find: (packId: string) => call('worlds.find', packId),
      /** Saves one of your worlds as an .atelierworld to share; the path, or null when cancelled. */
      share: (ref: string) => call('worlds.share', ref),
    },
    permissions: {
      /** Asks for some of the manifest's optionalPermissions; resolves to { granted }. */
      request: (asked: { sites?: string[]; network?: string[]; notifications?: boolean; model?: boolean; clipboard?: boolean }) => call('permissions.request', asked ?? {}),
    },
    /**
     * A small web server of the app's own, run by Atelier (permissions.server):
     * files from one of the pack's folders, requests the page answers, and
     * sockets from the pages it serves (phones as controllers, a second
     * screen, local multiplayer). It lives as long as this page.
     */
    server: {
      /** Starts it (or answers the running one): { url, lanUrl, port, qr, token, … }. lan: true shares it on the Wi-Fi over https. */
      start: (options?: { lan?: boolean; root?: string; token?: boolean; maxConnections?: number }) => call('server.start', options ?? {}),
      stop: () => call('server.stop'),
      status: () => call('server.status'),
      /** Answers requests no file in root answers: return text, { status, headers, body } or a value sent as JSON. */
      onRequest: (handler: (req: Omit<ServerRequestInfo, 'id'>) => unknown) => {
        if (typeof handler !== 'function') throw new Error('atelier.server.onRequest takes a function.')
        requestHandler = handler
        return () => {
          if (requestHandler === handler) requestHandler = null
        }
      },
      /** A served page opened a socket: { id, query, remote, send(data), close(code), onMessage(fn), onClose(fn) }. */
      onConnection: (fn: (socket: Record<string, unknown>) => void) => {
        if (typeof fn !== 'function') throw new Error('atelier.server.onConnection takes a function.')
        connectionHandlers.add(fn)
        return () => connectionHandlers.delete(fn)
      },
      /** The server stopped: 'stopped' (your stop()), 'person' (Stop on Atelier's bar), 'idle', or 'closed'. */
      onStop: (fn: (reason: ServerStopReason) => void) => {
        if (typeof fn !== 'function') throw new Error('atelier.server.onStop takes a function.')
        stopHandlers.add(fn)
        return () => stopHandlers.delete(fn)
      },
      /** The sockets open now. */
      sockets: () => [...serverSockets.values()].map((e) => e.socket),
      /** Sends to every open socket; resolves to how many it reached. */
      broadcast: (data: unknown) => call('server.send', '*', wire(data)),
    },
    status: {
      set: (status: { text?: string | null; badge?: number | null; progress?: number | null }) => call('status.set', status ?? null),
      clear: () => call('status.set', null),
    },
    tools: {
      serve: (handler: ToolHandler) => {
        if (typeof handler !== 'function') throw new Error('atelier.tools.serve takes a function.')
        toolHandler = handler
        ipcRenderer.send(PACK_IPC.toolReady)
      },
    },
  })
}
