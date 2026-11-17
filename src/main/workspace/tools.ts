/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace client tools: search_everything, and the folder tools
// list_folder, read_file, search_files and write_file. A chat reaches the
// folders granted to all chats or to it (for its companion or any), plus
// its companion's own files, read-only (CO-08). write_file needs a read and
// edit grant, refuses binaries and large writes, records a version first,
// and logs a file-written event. Results are text or JSON text, capped.
import { BRAND_NAME } from '@shared/branding'
import { z } from 'zod'
import { plainSnippet, type FileRef, type SearchHit, type SearchSource, SEARCH_SOURCES, TEXT_FILE_MAX_BYTES, isTextFileName } from '@shared/workspace'
import { CLIENT_TOOL_RESULT_MAX, registerClientTool, type ClientTool, type ClientToolContext, type ToolSetup } from '../agent/tools/registry'
import type { FolderStore } from './folders'
import { looksBinary } from './fsutil'

/** The pseudo-folder id for the chat's companion's own files. */
export const COMPANION_ROOT = 'companion'

export interface CompanionFilesReader {
  /** Every file in a companion's folder (relative paths), or [] when it has none. */
  files(companionId: string): Array<{ path: string; size: number; modifiedAt: number }>
  entries(companionId: string, folder: string): Array<{ path: string; name: string; kind: 'file' | 'folder'; size: number; modifiedAt: number }>
  /** A confined absolute path, or a throw. */
  resolve(companionId: string, path: string): string
  read(companionId: string, path: string): Buffer
}

export interface WorkspaceToolDeps {
  folders: FolderStore
  companionFiles: CompanionFilesReader
  companionName(companionId: string): string
  search(q: string, options: { sources?: SearchSource[]; limit?: number }): { hits: SearchHit[]; total: number }
}

interface Root {
  id: string
  name: string
  mode: 'read' | 'read-write'
  kind: 'folder' | 'companion'
}

const cap = (text: string): string => (text.length <= CLIENT_TOOL_RESULT_MAX ? text : `${text.slice(0, CLIENT_TOOL_RESULT_MAX - 80)}\n… (cut at ${CLIENT_TOOL_RESULT_MAX} characters)`)
const json = (value: unknown): string => cap(JSON.stringify(value, null, 1))
const error = (message: string): { content: string; isError: true } => ({ content: message, isError: true })

function rootsFor(deps: WorkspaceToolDeps, ctx: Pick<ClientToolContext, 'chatId' | 'companionId'>): Root[] {
  const roots: Root[] = deps.folders.accessible(ctx.chatId, ctx.companionId).map((f) => ({ id: f.id, name: f.name, mode: f.mode, kind: 'folder' }))
  if (deps.companionFiles.files(ctx.companionId).length > 0) roots.push({ id: COMPANION_ROOT, name: `${deps.companionName(ctx.companionId)}’s files`, mode: 'read', kind: 'companion' })
  return roots
}

/** A root by id or (unambiguous) name; throws a message the model can act on. */
function pickRoot(roots: Root[], folder: string): Root {
  const byId = roots.find((r) => r.id === folder)
  if (byId) return byId
  const byName = roots.filter((r) => r.name.toLowerCase() === folder.trim().toLowerCase())
  if (byName.length === 1 && byName[0]) return byName[0]
  if (roots.length === 0) throw new Error('No folders are shared with this chat. Ask the user to give access to a folder.')
  throw new Error(`Unknown folder "${folder}". Call list_folder without a folder to see the ones you can use.`)
}

/** True when this companion has folders for all chats, or files of its own. Chat-only grants are checked by the setup. */
export function foldersAvailable(deps: WorkspaceToolDeps, companionId: string): boolean {
  return deps.folders.accessible(null, companionId).length > 0 || deps.companionFiles.files(companionId).length > 0
}

const folderArg = z.string().trim().min(1).max(200)
const pathArg = z.string().max(1024)

export function workspaceTools(deps: WorkspaceToolDeps): ClientTool<any>[] {
  const folderEnabled = (setup: ToolSetup): boolean => setup.workspace.folders || foldersAvailable(deps, setup.companionId)

  const searchEverything: ClientTool<{ query: string; sources?: SearchSource[]; limit?: number }> = {
    name: 'search_everything',
    group: 'workspace',
    description:
      `Search everything the user keeps in ${BRAND_NAME}: past chats, memory notes, browsing history, bookmarks and files in shared folders. Returns the best matches with a short snippet, newest and most relevant first. Use it to find something the user did, read or saved before.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
        sources: { type: 'array', items: { type: 'string', enum: [...SEARCH_SOURCES] }, description: 'Only these kinds of items (default: all).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    parse: z.object({ query: z.string().trim().min(1).max(500), sources: z.array(z.enum(SEARCH_SOURCES)).max(SEARCH_SOURCES.length).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
    enabled: () => true,
    async run(input) {
      const { hits, total } = deps.search(input.query, { sources: input.sources, limit: input.limit ?? 10 })
      if (hits.length === 0) return { content: `Nothing matches "${input.query}".` }
      return {
        content: json({
          total,
          results: hits.map((h) => ({ source: h.source, title: h.title, snippet: plainSnippet(h.snippet), url: h.url ?? undefined, file: h.ref ?? undefined, at: new Date(h.at).toISOString() })),
        }),
      }
    },
  }

  const listFolder: ClientTool<{ folder?: string; path?: string }> = {
    name: 'list_folder',
    group: 'files',
    description:
      'List the local folders the user shared with you, or the files and subfolders inside one. Call it without arguments first to see the folders, their ids and whether you may edit them.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'A folder id or name from the folder list.' },
        path: { type: 'string', description: 'A subfolder inside it, relative, with / between parts.' },
      },
      additionalProperties: false,
    },
    parse: z.object({ folder: folderArg.optional(), path: pathArg.optional() }).strict(),
    enabled: folderEnabled,
    async run(input, ctx) {
      const roots = rootsFor(deps, ctx)
      if (!input.folder) {
        if (roots.length === 0) return { content: 'No folders are shared with this chat. Ask the user to give access to a folder.' }
        return { content: json({ folders: roots.map((r) => ({ id: r.id, name: r.name, access: r.mode === 'read-write' ? 'read and edit' : 'read only' })) }) }
      }
      try {
        const root = pickRoot(roots, input.folder)
        const sub = input.path ?? ''
        const entries = root.kind === 'companion' ? deps.companionFiles.entries(ctx.companionId, sub) : deps.folders.entries(root.id, sub)
        return { content: json({ folder: root.name, path: sub || '/', entries: entries.map((e) => ({ path: e.path, type: e.kind, size: e.kind === 'file' ? e.size : undefined, modified: new Date(e.modifiedAt).toISOString() })) }) }
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const readFile: ClientTool<{ folder: string; path: string; offset?: number }> = {
    name: 'read_file',
    group: 'files',
    description: 'Read a text file in a shared folder (Markdown, code, CSV, JSON and other text, up to 2 MB). Long files come in parts: pass offset to read on.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'A folder id or name from list_folder.' },
        path: { type: 'string', description: 'The file, relative to the folder.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start at (default 0).' },
      },
      required: ['folder', 'path'],
      additionalProperties: false,
    },
    parse: z.object({ folder: folderArg, path: pathArg.min(1), offset: z.number().int().min(0).max(TEXT_FILE_MAX_BYTES).optional() }).strict(),
    enabled: folderEnabled,
    async run(input, ctx) {
      try {
        const root = pickRoot(rootsFor(deps, ctx), input.folder)
        let text: string
        if (root.kind === 'companion') {
          if (!isTextFileName(input.path)) throw new Error(`${BRAND_NAME} can only read text files here.`)
          const data = deps.companionFiles.read(ctx.companionId, input.path)
          if (data.byteLength > TEXT_FILE_MAX_BYTES) throw new Error('That file is too large to read (over 2 MB).')
          if (looksBinary(data)) throw new Error('That file isn’t text.')
          text = data.toString('utf8')
        } else {
          text = deps.folders.readText(root.id, input.path)
        }
        const start = input.offset ?? 0
        const room = CLIENT_TOOL_RESULT_MAX - 200
        const part = text.slice(start, start + room)
        const more = start + part.length < text.length
        return { content: more ? `${part}\n\n[Showing characters ${start}–${start + part.length} of ${text.length}. Call read_file with offset ${start + part.length} to read on.]` : part || '(empty file)' }
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const searchFiles: ClientTool<{ query: string; folder?: string }> = {
    name: 'search_files',
    group: 'files',
    description: 'Search the text and names of files in the shared folders (or one of them). Returns matching files with a snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
        folder: { type: 'string', description: 'Only this folder (id or name).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    parse: z.object({ query: z.string().trim().min(1).max(500), folder: folderArg.optional() }).strict(),
    enabled: folderEnabled,
    async run(input, ctx) {
      try {
        const roots = rootsFor(deps, ctx)
        const allowed = input.folder ? [pickRoot(roots, input.folder)] : roots
        const inRoots = (ref: FileRef | null): Root | undefined => {
          if (ref?.kind === 'folder') return allowed.find((r) => r.kind === 'folder' && r.id === ref.folderId)
          if (ref?.kind === 'companion' && ref.companionId === ctx.companionId) return allowed.find((r) => r.kind === 'companion')
          return undefined
        }
        const { hits } = deps.search(input.query, { sources: ['files'], limit: 200 })
        const results = hits
          .map((h) => ({ h, root: inRoots(h.ref) }))
          .filter((x): x is { h: SearchHit; root: Root } => x.root !== undefined)
          .slice(0, 30)
          .map(({ h, root }) => ({ folder: root.id, folderName: root.name, path: h.ref && 'path' in h.ref ? h.ref.path : h.title, snippet: plainSnippet(h.snippet) }))
        if (results.length === 0) return { content: allowed.length === 0 ? 'No folders are shared with this chat.' : `No files match "${input.query}".` }
        return { content: json({ results }) }
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const writeFile: ClientTool<{ folder: string; path: string; content: string }> = {
    name: 'write_file',
    group: 'files',
    description:
      'Create or replace a text file in a folder the user shared with read and edit access. The earlier text is kept in version history, so the user can restore it. Write whole files; text only, up to 1 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'A folder id or name with read and edit access.' },
        path: { type: 'string', description: 'The file, relative to the folder; missing subfolders are created.' },
        content: { type: 'string', description: 'The complete new text of the file.' },
      },
      required: ['folder', 'path', 'content'],
      additionalProperties: false,
    },
    parse: z.object({ folder: folderArg, path: pathArg.min(1), content: z.string().max(1_100_000) }).strict(),
    enabled: folderEnabled,
    async run(input, ctx) {
      try {
        const root = pickRoot(rootsFor(deps, ctx), input.folder)
        if (root.kind === 'companion' || root.mode !== 'read-write') return error(`You can only read “${root.name}”. Ask the user for read and edit access to change files there.`)
        const { created, path } = deps.folders.writeText(root.id, input.path, input.content)
        const ref: FileRef = { kind: 'folder', folderId: root.id, path }
        const name = path.split('/').pop() ?? path
        // The turn id is filled by the agent loop when it logs the event; the tool doesn't know it.
        ctx.emit({ type: 'file-written', turnId: '', ref, name })
        return { content: `${created ? 'Created' : 'Saved'} ${path} in “${root.name}”.` }
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err))
      }
    },
  }

  return [searchEverything, listFolder, readFile, searchFiles, writeFile]
}

/** Registers the five tools once (the feature module calls it at start-up). */
export function registerWorkspaceClientTools(deps: WorkspaceToolDeps): void {
  for (const tool of workspaceTools(deps)) registerClientTool(tool)
}
