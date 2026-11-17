/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { REPLY_TOOLS } from './replyTools'

// The attachments and tools part of the offline smoke client: a Files API
// stub, and scripted replies for compaction, code-execution outputs and the
// extra client tools (REPLY_TOOLS), so the smoke checks see the real request shapes and events
// without a key or a network request. Triggers are words the smoke test
// types ("smoke:artifact"); every other message keeps the canned reply.

interface Request {
  model: string
  messages: Array<{ role: string; content: unknown }>
  container?: { id?: string }
  context_management?: unknown
  compaction?: unknown
  tools?: Array<{ name?: string; type?: string }>
  betas?: string[]
}

type Block = Record<string, unknown> & { type: string }
type Event = Record<string, unknown> & { type: string }

/** What the smoke checks read back. */
export const smokeRichChat = {
  /** The newest streamed request, as sent. */
  lastRequest: null as Request | null,
  uploads: 0,
  deleted: [] as string[],
  reset(): void {
    this.lastRequest = null
    this.uploads = 0
    this.deleted = []
  },
}

/** The CSV a smoke document run "writes". */
export const SMOKE_GENERATED = { fileId: 'file_smoke_out_1', name: 'smoke-table.csv', mediaType: 'text/csv', text: 'item,count\napples,3\npears,5\n' }

/** client.files for the offline client. */
export function smokeFilesApi(): {
  upload(params: { file: unknown }): Promise<{ id: string }>
  download(fileId: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
  delete(fileId: string): Promise<{ id: string }>
  retrieveMetadata(fileId: string): Promise<{ filename: string; mime_type: string; size_bytes: number }>
} {
  return {
    upload: async () => ({ id: `file_smoke_up_${++smokeRichChat.uploads}` }),
    download: async (fileId) => {
      if (fileId !== SMOKE_GENERATED.fileId) throw new Error('No such file.')
      const bytes = Buffer.from(SMOKE_GENERATED.text)
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
    },
    delete: async (fileId) => {
      smokeRichChat.deleted.push(fileId)
      return { id: fileId }
    },
    retrieveMetadata: async (fileId) => {
      if (fileId !== SMOKE_GENERATED.fileId) throw new Error('No such file.')
      return { filename: SMOKE_GENERATED.name, mime_type: SMOKE_GENERATED.mediaType, size_bytes: SMOKE_GENERATED.text.length }
    },
  }
}

function lastUser(request: Request): Block[] {
  const last = [...request.messages].reverse().find((m) => m.role === 'user')
  if (!last) return []
  return typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : Array.isArray(last.content) ? (last.content as Block[]) : []
}

const typedText = (blocks: readonly Block[]): string =>
  blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && !(b.text as string).startsWith('<browser_context>')).map((b) => b.text as string).join('\n')

/** The scripted reply to this request, or null for the canned one. */
export function smokeRichChatReply(request: Request, n: number): { content: Block[]; events: Event[]; stopReason: string; container?: { id: string } } | null {
  smokeRichChat.lastRequest = request
  const blocks = lastUser(request)
  const text = typedText(blocks)

  // SS-03: an on-demand summary comes back alone.
  if (request.compaction) {
    const summary = 'Summary of the chat so far: the smoke test asked a few questions and got short answers.'
    return { content: [{ type: 'compaction', content: summary }], events: [], stopReason: 'compaction' }
  }
  // A tool result from a scripted call: finish with a line of text.
  if (blocks.some((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string' && (b.tool_use_id as string).startsWith('toolu_smokec_'))) {
    return textReply('Done.')
  }
  if (/smoke:compaction/.test(text) && request.context_management) {
    const summary = 'Earlier, the smoke test chatted about picnics and laptops.'
    return {
      content: [{ type: 'compaction', content: summary }, { type: 'text', text: 'Carrying on from the summary.', citations: null }],
      events: [{ type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null } }, ...textEvents('Carrying on from the summary.', 1)],
      stopReason: 'end_turn',
    }
  }
  if (/smoke:document/.test(text) && request.container) {
    const id = `srvtoolu_smokec_${n}`
    return {
      content: [
        { type: 'server_tool_use', id, name: 'bash_code_execution', input: { command: 'python make_table.py' } },
        { type: 'bash_code_execution_tool_result', tool_use_id: id, content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 0, content: [{ type: 'bash_code_execution_output', file_id: SMOKE_GENERATED.fileId }] } },
        { type: 'text', text: 'I made the table.', citations: null },
      ],
      events: textEvents('I made the table.', 2),
      stopReason: 'end_turn',
      container: { id: request.container.id ?? 'container_smoke_1' },
    }
  }
  const call = (name: string, input: unknown): ReturnType<typeof smokeRichChatReply> => {
    const id = `toolu_smokec_${n}`
    const json = JSON.stringify(input)
    return {
      content: [{ type: 'tool_use', id, name, input }],
      // save_artifact's input streams in pieces, as eager_input_streaming sends it.
      events: [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
        ...(json.match(/[\s\S]{1,24}/g) ?? []).map((partial) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })),
      ],
      stopReason: 'tool_use',
    }
  }
  if (/smoke:suggest/.test(text)) return call(REPLY_TOOLS.suggestNextSteps, { heading: 'Next steps', steps: ['Compare prices', 'Check reviews'] })
  if (/smoke:artifact/.test(text)) return call(REPLY_TOOLS.saveArtifact, { title: 'Smoke chart', format: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="currentColor"/></svg>' })
  if (/smoke:connector/.test(text)) return call(REPLY_TOOLS.suggestConnector, { service: 'Linear', reason: 'To read the issue you mentioned.' })
  return null
}

function textEvents(text: string, index: number): Event[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
    ...(text.match(/[\s\S]{1,48}/g) ?? []).map((piece) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })),
  ]
}

function textReply(text: string): NonNullable<ReturnType<typeof smokeRichChatReply>> {
  return { content: [{ type: 'text', text, citations: null }], events: textEvents(text, 0), stopReason: 'end_turn' }
}
