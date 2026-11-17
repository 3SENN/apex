/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bearerOf } from './secrets'

// Atelier's local MCP server: Streamable HTTP on 127.0.0.1, answering every
// POST with a single JSON response (no server-sent streams). Electron's
// runAsNode fuse is off, so the server lives inside main instead of a
// separate node script.
//
// It fails closed: a request without the right bearer token for its path,
// from a browser (any Origin header), or for a host other than loopback is
// refused before any tool is looked at.

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
}

/** What one authenticated path serves. */
export interface McpRoute {
  /** Shown in initialize as the server's name. */
  name: string
  tools(): McpTool[]
  call(name: string, args: unknown, signal: AbortSignal): Promise<McpToolResult>
}

/** Finds the route for a path, or null when the token doesn't open it. */
export type RouteResolver = (path: string, token: string | null) => McpRoute | null

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
const BODY_MAX = 4 * 1024 * 1024

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: unknown; result: unknown } | { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class McpServer {
  readonly #resolve: RouteResolver
  readonly #version: string
  #server: Server | null = null
  #port: number | null = null
  /** Two chats starting at once share one server. */
  #listening: Promise<number> | null = null
  /** In-flight tool calls, so notifications/cancelled can abort one. */
  readonly #inflight = new Map<string, AbortController>()

  constructor(resolve: RouteResolver, version = '1.0.0') {
    this.#resolve = resolve
    this.#version = version
  }

  get port(): number | null {
    return this.#port
  }

  /** Listens on 127.0.0.1, on `preferred` when it is free, otherwise on any free port. */
  listen(preferred: number | null = null): Promise<number> {
    this.#listening ??= this.#listen(preferred).catch((err: unknown) => {
      this.#listening = null
      throw err
    })
    return this.#listening
  }

  async #listen(preferred: number | null): Promise<number> {
    const server = createServer((req, res) => void this.#handle(req, res))
    server.keepAliveTimeout = 5_000
    // Approvals can keep a tool call open for minutes.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    const bind = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolve((server.address() as AddressInfo).port)
        })
      })
    let port: number
    try {
      port = await bind(preferred ?? 0)
    } catch (err) {
      if (preferred === null) throw err
      port = await bind(0)
    }
    this.#server = server
    this.#port = port
    return port
  }

  async close(): Promise<void> {
    for (const controller of this.#inflight.values()) controller.abort(new Error(`${BRAND_NAME} is closing.`))
    this.#inflight.clear()
    const server = this.#server
    this.#server = null
    this.#port = null
    this.#listening = null
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Browsers always send Origin; MCP clients such as Claude Code don't. Pages never get in, even with a token.
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'Forbidden' })
      if (!loopbackHost(req.headers.host)) return send(res, 403, { error: 'Forbidden' })
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const route = this.#resolve(path, bearerOf(req.headers.authorization))
      if (!route) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        return send(res, 401, { error: 'Unauthorized' })
      }
      // No server-initiated stream and no sessions to end.
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        return send(res, 405, { error: 'Method not allowed' })
      }
      const raw = await readBody(req)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return send(res, 400, rpcError(null, -32700, 'Parse error'))
      }
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) abort.abort(new Error('The client went away.'))
      })
      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map((m) => this.#message(route, m, abort.signal)))).filter((r): r is JsonRpcResponse => r !== null)
        return replies.length > 0 ? send(res, 200, replies) : accepted(res)
      }
      const reply = await this.#message(route, parsed, abort.signal)
      return reply ? send(res, 200, reply) : accepted(res)
    } catch (err) {
      if (!res.headersSent) send(res, err instanceof BodyTooLarge ? 413 : 500, rpcError(null, -32603, err instanceof Error ? err.message : 'Internal error'))
    }
  }

  /** Answers one JSON-RPC message; null for notifications, which get no reply. */
  async #message(route: McpRoute, message: unknown, signal: AbortSignal): Promise<JsonRpcResponse | null> {
    if (!isObject(message) || typeof (message as JsonRpcRequest).method !== 'string') {
      return isObject(message) && 'id' in message ? rpcError(message.id ?? null, -32600, 'Invalid request') : null
    }
    const { id, method } = message as unknown as JsonRpcRequest & { method: string }
    const params = isObject(message.params) ? message.params : {}
    const notification = id === undefined
    if (method === 'notifications/cancelled') {
      const key = String(params.requestId ?? '')
      this.#inflight.get(key)?.abort(new Error('Cancelled by the MCP client.'))
      return null
    }
    if (notification) return null
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
        const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0]
        return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: route.name, version: this.#version } })
      }
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: route.tools() })
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!route.tools().some((t) => t.name === name)) return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true })
        const controller = new AbortController()
        const key = String(id)
        const onAbort = (): void => controller.abort(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        this.#inflight.set(key, controller)
        try {
          return rpcResult(id, await route.call(name, params.arguments ?? {}, controller.signal))
        } catch (err) {
          return rpcResult(id, { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true })
        } finally {
          signal.removeEventListener('abort', onAbort)
          this.#inflight.delete(key)
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}

/** Only 127.0.0.1 and localhost, so a DNS-rebound name can't reach the server. */
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX) {
        reject(new BodyTooLarge('Request too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
  res.end(text)
}

function accepted(res: ServerResponse): void {
  res.writeHead(202)
  res.end()
}
