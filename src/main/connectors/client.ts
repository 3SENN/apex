/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'

// Apex's own MCP client: streamable HTTP for localhost, private and
// custom-header servers (and for listing any server's tools), and stdio for
// local commands over a process the LocalServers manager spawned. Results are
// turned into Messages API tool-result content, capped.

export const REQUEST_TIMEOUT_MS = 30_000
const TEXT_CAP = 100_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface McpTool {
  name: string
  title: string | null
  description: string
  inputSchema: unknown
  readOnly: boolean
}

export interface McpResource {
  uri: string
  name: string
  description: string
}

/** A server that refused the credential (HTTP 401/403). */
export class McpAuthError extends Error {
  constructor(readonly status: number) {
    super(`The server refused the credential (HTTP ${status}).`)
  }
}

function asAuthError(err: unknown): McpAuthError | null {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 401 || code === 403) return new McpAuthError(code)
  const text = err instanceof Error ? err.message : String(err)
  const m = /\bHTTP (401|403)\b|\b(401|403)\b.*(Unauthorized|Forbidden)/i.exec(text)
  return m ? new McpAuthError(Number(m[1] ?? m[2])) : null
}

/**
 * The SDK's Transport over a spawned server's stdin and stdout. Lines that
 * are not JSON-RPC (servers that log to stdout) go to `onLine` instead of
 * breaking the session.
 */
export class ProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  #buffer = ''
  readonly #child: ChildProcess
  readonly #onLine: (line: string) => void

  constructor(child: ChildProcess, onLine: (line: string) => void) {
    this.#child = child
    this.#onLine = onLine
  }

  async start(): Promise<void> {
    const out = this.#child.stdout
    if (!out || !this.#child.stdin) throw new Error('The server has no stdio.')
    out.setEncoding('utf8')
    out.on('data', (chunk: string) => {
      this.#buffer += chunk
      if (this.#buffer.length > 10_000_000) this.#buffer = ''
      let newline: number
      while ((newline = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/, '')
        this.#buffer = this.#buffer.slice(newline + 1)
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          this.#onLine(line)
          continue
        }
        const message = JSONRPCMessageSchema.safeParse(parsed)
        if (message.success) this.onmessage?.(message.data)
        else this.#onLine(line)
      }
    })
    this.#child.once('exit', () => this.onclose?.())
    this.#child.stdin.on('error', (err) => this.onerror?.(err))
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child.stdin
    if (!stdin || stdin.destroyed) throw new Error('The server stopped.')
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolve())))
  }

  async close(): Promise<void> {
    this.#child.stdin?.end()
  }
}

export interface RemoteTarget {
  url: string
  headers: Record<string, string>
}

/** One connected MCP session. */
export class McpSession {
  readonly #client: Client
  #closed = false

  private constructor(client: Client) {
    this.#client = client
  }

  static async connect(transport: Transport, timeoutMs = REQUEST_TIMEOUT_MS): Promise<McpSession> {
    const client = new Client({ name: BRAND_NAME, version: '1.0.0' }, { capabilities: {} })
    try {
      await client.connect(transport, { timeout: timeoutMs })
    } catch (err) {
      await client.close().catch(() => undefined)
      throw asAuthError(err) ?? err
    }
    return new McpSession(client)
  }

  static remote(target: RemoteTarget, timeoutMs = REQUEST_TIMEOUT_MS): Promise<McpSession> {
    return McpSession.connect(new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers } }), timeoutMs)
  }

  get closed(): boolean {
    return this.#closed
  }

  capabilities(): { resources: boolean; tools: boolean } {
    const caps = this.#client.getServerCapabilities() ?? {}
    return { resources: Boolean(caps.resources), tools: Boolean(caps.tools) }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await this.#call(() => this.#client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS }))
      for (const t of result.tools) {
        tools.push({
          name: t.name,
          title: t.annotations?.title ?? t.title ?? null,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object' },
          readOnly: t.annotations?.readOnlyHint === true,
        })
      }
      cursor = result.nextCursor
      if (!cursor || tools.length >= 500) break
    }
    return tools
  }

  async listResources(limit = 200): Promise<McpResource[]> {
    const out: McpResource[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10 && out.length < limit; page++) {
      const result = await this.#call(() => this.#client.listResources(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS }))
      for (const r of result.resources) out.push({ uri: r.uri, name: r.title ?? r.name ?? r.uri, description: r.description ?? '' })
      cursor = result.nextCursor
      if (!cursor) break
    }
    return out.slice(0, limit)
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.#call(() => this.#client.readResource({ uri }, { timeout: REQUEST_TIMEOUT_MS }))
    const parts = result.contents.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : `[${c.mimeType ?? 'binary'} content]`))
    return parts.join('\n\n').slice(0, TEXT_CAP)
  }

  async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<{ content: BetaToolResultBlockParam['content']; isError: boolean; raw: unknown }> {
    const args = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    const result = await this.#call(() => this.#client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }))
    return { content: toToolContent(result.content, result.structuredContent), isError: result.isError === true, raw: result }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#client.close().catch(() => undefined)
  }

  async #call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      throw asAuthError(err) ?? err
    }
  }
}

/** MCP tool content as Messages API tool-result blocks: text, supported images, and a note for anything else. */
export function toToolContent(content: unknown, structured?: unknown): BetaToolResultBlockParam['content'] {
  const blocks: Exclude<BetaToolResultBlockParam['content'], string | undefined> = []
  let budget = TEXT_CAP
  const text = (value: string): void => {
    if (budget <= 0) return
    const clipped = value.slice(0, budget)
    budget -= clipped.length
    blocks.push({ type: 'text', text: clipped })
  }
  for (const item of Array.isArray(content) ? content : []) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    if (c.type === 'text' && typeof c.text === 'string') text(c.text)
    else if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string' && IMAGE_TYPES.has(c.mimeType) && c.data.length < 7_000_000) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType as 'image/png', data: c.data } })
    } else if (c.type === 'resource' && typeof c.resource === 'object' && c.resource !== null) {
      const r = c.resource as Record<string, unknown>
      text(typeof r.text === 'string' ? `${String(r.uri ?? '')}\n${r.text}` : `[${String(r.mimeType ?? 'binary')} resource ${String(r.uri ?? '')}]`)
    } else if (c.type === 'resource_link') text(`${String(c.name ?? 'Link')}: ${String(c.uri ?? '')}`)
    else text(`[${String(c.type ?? 'unknown')} content]`)
  }
  if (blocks.length === 0 && structured !== undefined) text(JSON.stringify(structured))
  if (blocks.length === 0) text('(no content)')
  return blocks
}
