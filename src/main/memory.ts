/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node'
import { z } from 'zod'
import { SHARED_OWNER } from '@shared/chats'
import type { MemoryFile, Owner } from '@shared/services'
import { log } from './log'
import { writeAtomic } from './settings'
import { readJson } from './stores'

// The agent's long-term memory: Anthropic's memory tool (memory_20250818)
// backed by the SDK's local filesystem implementation, which confines every
// path to /memories (including symlink escapes).
//
// Each companion has its own folder, and one folder is shared by all. In a
// chat the agent sees its companion's folder at /memories/ and the shared one
// at /memories/shared/; calls under /memories/shared go to a second backend
// with the prefix translated, and its replies are translated back. The shared
// folder is the one memory used before companions had their own, so existing
// notes stay where they are and become shared.

const MAX_FILE_BYTES = 256 * 1024
type Author = NonNullable<MemoryFile['author']>
const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/
const SHARED_PREFIX = '/memories/shared'

const memoryCommand = z.discriminatedUnion('command', [
  z.object({ command: z.literal('view'), path: z.string(), view_range: z.array(z.number().int()).length(2).optional() }),
  z.object({ command: z.literal('create'), path: z.string(), file_text: z.string().max(MAX_FILE_BYTES) }),
  z.object({ command: z.literal('str_replace'), path: z.string(), old_str: z.string(), new_str: z.string().optional() }),
  z.object({ command: z.literal('insert'), path: z.string(), insert_line: z.number().int(), insert_text: z.string() }),
  z.object({ command: z.literal('delete'), path: z.string() }),
  z.object({ command: z.literal('rename'), old_path: z.string(), new_path: z.string() }),
])
type MemoryCommand = z.infer<typeof memoryCommand>

/**
 * Maps a /memories/... path to a file under root. Rejects anything that
 * would leave root, including through symlinks in existing parents.
 */
export function resolveMemoryPath(root: string, memoryPath: string): string {
  if (memoryPath !== '/memories' && !memoryPath.startsWith('/memories/')) throw new Error('Memory paths start with /memories/.')
  if (memoryPath.includes('\0') || memoryPath.split('/').includes('..')) throw new Error('Invalid memory path.')
  const base = resolve(root)
  const target = resolve(base, memoryPath.slice('/memories'.length).replace(/^\/+/, ''))
  if (target !== base && !target.startsWith(base + sep)) throw new Error('Invalid memory path.')
  let existing = target
  while (!existsSync(existing) && existing !== base) existing = dirname(existing)
  if (existsSync(base)) {
    const real = realpathSync(existing)
    const realBase = realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) throw new Error('Invalid memory path.')
  }
  return target
}

/** Which folder an agent path is in, and the path inside that folder. Trailing slashes are dropped. */
export function routeMemoryPath(agentPath: string): { shared: boolean; path: string } {
  const path = agentPath.length > '/memories'.length ? agentPath.replace(/\/+$/, '') : agentPath
  if (path === SHARED_PREFIX || path.startsWith(`${SHARED_PREFIX}/`)) return { shared: true, path: `/memories${path.slice(SHARED_PREFIX.length)}` }
  return { shared: false, path }
}

const PATH_TOKEN = /\/memories(?![\w-])/g

/**
 * Translates a shared-folder reply back to the agent's view. Directory
 * listings get every path column rewritten; other replies name paths only in
 * their first line, so file contents in views and edit snippets are left alone.
 */
export function sharedToAgent(output: string): string {
  const [first = '', ...rest] = output.split('\n')
  const head = first.replace(PATH_TOKEN, SHARED_PREFIX)
  if (!first.startsWith("Here're the files and directories")) return [head, ...rest].join('\n')
  return [head, ...rest.map((line) => line.replace(/\t\/memories(?![\w-])/, `\t${SHARED_PREFIX}`))].join('\n')
}

/** The paths a memory call changes, as the agent named them; empty for views and invalid input. */
export function memoryCommandPaths(input: unknown): string[] {
  const parsed = memoryCommand.safeParse(input)
  if (!parsed.success) return []
  const command = parsed.data
  if (command.command === 'view') return []
  if (command.command === 'rename') return [command.old_path, command.new_path]
  return [command.path]
}

function trimSlash(path: string): string {
  return path.length > '/memories'.length ? path.replace(/\/+$/, '') : path
}

async function translated<T>(shared: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (shared && err instanceof Error) throw new Error(sharedToAgent(err.message))
    throw err
  }
}

export interface MemoryGuards {
  /** Before a note is overwritten from an editor or by Atelier, with its current text. */
  beforeWrite?(owner: Owner, path: string, previous: string): void
  /** Before a note or folder is deleted from an editor. */
  beforeRemove?(owner: Owner, path: string): void
}

// 'changed' (owner, /memories/... path) feeds the workspace search index, versions and tidy.
export class MemoryService extends EventEmitter<{ changed: [owner: Owner, path: string] }> {
  /** The shared folder; it is /memories for the shared owner and /memories/shared in a chat. */
  readonly root: string
  readonly #base: string
  readonly #backends = new Map<Owner, Promise<BetaLocalFilesystemMemoryTool>>()
  /** Who last wrote each file, per owner. Kept beside the owner's folder, out of the agent's sight. */
  readonly #authors = new Map<Owner, Record<string, Author>>()
  #guards: MemoryGuards = {}

  constructor(dataDir: string) {
    super()
    this.#base = join(dataDir, 'memory')
    this.root = join(this.#base, 'memories')
    mkdirSync(this.root, { recursive: true })
  }

  /** The folder that holds an owner's /memories. */
  rootFor(owner: Owner): string {
    if (owner === SHARED_OWNER) return this.root
    if (!OWNER_ID.test(owner)) throw new Error('Unknown memory owner.')
    return join(this.#base, 'companions', owner, 'memories')
  }

  /**
   * Runs one memory tool call from the agent. With a companion, /memories is
   * that companion's folder and /memories/shared the shared one; without,
   * /memories is the shared folder. Errors are thrown as-is.
   */
  async execute(input: unknown, companionId: string | null = null): Promise<string> {
    const parsed = memoryCommand.safeParse(input)
    if (!parsed.success) throw new Error(`Invalid memory command: ${z.prettifyError(parsed.error)}`)
    const command = parsed.data
    const output = await this.#execute(command, companionId)
    this.#recordAgent(command, companionId)
    for (const agentPath of memoryCommandPaths(command)) {
      const route = routeMemoryPath(agentPath)
      this.emit('changed', companionId === null || route.shared ? SHARED_OWNER : companionId, companionId === null ? trimSlash(agentPath) : route.path)
    }
    return output
  }

  async #execute(command: MemoryCommand, companionId: string | null): Promise<string> {
    if (companionId === null) return this.#run(await this.#backend(SHARED_OWNER), command)
    if (command.command === 'rename') return this.#rename(command, companionId)

    const route = routeMemoryPath(command.path)
    const backend = await this.#backend(route.shared ? SHARED_OWNER : companionId)
    const local = { ...command, path: route.path }
    const output = await translated(route.shared, () => this.#run(backend, local))
    if (route.shared) return sharedToAgent(output)
    if (command.command === 'view' && route.path === '/memories') return `${output}\n${await this.#sharedListing()}`
    return output
  }

  list(owner: Owner = SHARED_OWNER): MemoryFile[] {
    const root = this.rootFor(owner)
    const authors = this.#authorsOf(owner)
    const out: MemoryFile[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        // In a companion's folder, /memories/shared means the shared folder.
        if (owner !== SHARED_OWNER && dir === root && entry.name === 'shared') continue
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) {
          const stat = statSync(full)
          const path = `/memories/${relative(root, full).split(sep).join('/')}`
          out.push({ path, size: stat.size, modifiedAt: stat.mtimeMs, owner, author: authors[path] ?? null })
        }
      }
    }
    if (existsSync(root)) walk(root)
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  read(path: string, owner: Owner = SHARED_OWNER): string {
    return readFileSync(this.#resolve(path, owner), 'utf8')
  }

  /** Versions before an overwrite and Recently Deleted before a delete, for every caller. */
  setGuards(guards: MemoryGuards): void {
    this.#guards = guards
  }

  /** Writes a note. `author` is 'agent' for notes Atelier writes for a companion (hourly activity notes). */
  write(path: string, text: string, owner: Owner = SHARED_OWNER, author: Author = 'you'): void {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Memory files are limited to 256 KB.')
    const target = this.#resolve(path, owner)
    if (target === resolve(this.rootFor(owner))) throw new Error('Choose a file name under /memories/.')
    if (this.#guards.beforeWrite && existsSync(target) && statSync(target).isFile()) {
      this.#guard(() => this.#guards.beforeWrite?.(owner, path, readFileSync(target, 'utf8')))
    }
    mkdirSync(dirname(target), { recursive: true })
    writeAtomic(target, text)
    this.#credit(owner, path, author)
    this.emit('changed', owner, path)
  }

  remove(path: string, owner: Owner = SHARED_OWNER): void {
    const target = this.#resolve(path, owner)
    if (target === resolve(this.rootFor(owner))) throw new Error('The memory root cannot be deleted.')
    if (this.#guards.beforeRemove && existsSync(target)) this.#guard(() => this.#guards.beforeRemove?.(owner, path))
    rmSync(target, { recursive: true, force: true })
    this.#forget(owner, path)
    this.emit('changed', owner, path)
  }

  /** Copies one companion's folder to another (duplicating a companion). */
  copyOwner(from: string, to: string): void {
    const source = this.rootFor(from)
    if (from === SHARED_OWNER || to === SHARED_OWNER || !existsSync(source)) return
    cpSync(source, this.rootFor(to), { recursive: true, errorOnExist: false, verbatimSymlinks: true })
    const authors = this.#authorsOf(from)
    if (Object.keys(authors).length > 0) writeAtomic(this.#authorsFile(to), JSON.stringify(authors))
    this.#authors.delete(to)
  }

  /** The folder holding a companion's memory, for moving it to the Trash when the companion is deleted. */
  ownerFolder(companionId: string): string | null {
    if (companionId === SHARED_OWNER) return null
    const folder = dirname(this.rootFor(companionId))
    return existsSync(folder) ? folder : null
  }

  /**
   * Puts a note or folder back from Recently Deleted: moves `source`
   * to `path`, or to "name (restored).md" when that is taken, and restores who
   * wrote each file. Returns the path it landed at.
   */
  adopt(owner: Owner, path: string, source: string, authors: Record<string, Author> = {}): string {
    let target = path
    for (let n = 1; existsSync(this.#resolve(target, owner)); n++) {
      const dot = path.lastIndexOf('.')
      const slash = path.lastIndexOf('/')
      const suffix = n === 1 ? ' (restored)' : ` (restored ${n})`
      target = dot > slash ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`
    }
    const to = this.#resolve(target, owner)
    if (to === resolve(this.rootFor(owner))) throw new Error('Choose a file name under /memories/.')
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameSync(source, to)
    } catch {
      cpSync(source, to, { recursive: true })
      rmSync(source, { recursive: true, force: true })
    }
    for (const [p, author] of Object.entries(authors)) {
      if (p === path || p.startsWith(`${path}/`)) this.#credit(owner, target + p.slice(path.length), author)
    }
    this.emit('changed', owner, target)
    return target
  }

  /** The file or folder behind a /memories path, for moving it to Recently Deleted. */
  pathOnDisk(path: string, owner: Owner = SHARED_OWNER): string {
    return this.#resolve(path, owner)
  }

  removeOwner(companionId: string): void {
    const folder = this.ownerFolder(companionId)
    this.#backends.delete(companionId)
    this.#authors.delete(companionId)
    if (folder) rmSync(folder, { recursive: true, force: true })
  }

  /** A guard that fails (version history or the trash not ready) never blocks your edit; it is logged. */
  #guard(run: () => void): void {
    try {
      run()
    } catch (err) {
      log.warn('memory', 'Could not keep a copy before changing a note', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Credits the agent with the files a successful call wrote, and keeps the record in step with deletes and renames. */
  #recordAgent(command: MemoryCommand, companionId: string | null): void {
    const place = (agentPath: string): { owner: Owner; path: string } => {
      if (companionId === null) return { owner: SHARED_OWNER, path: trimSlash(agentPath) }
      const route = routeMemoryPath(agentPath)
      return { owner: route.shared ? SHARED_OWNER : companionId, path: route.path }
    }
    try {
      if (command.command === 'view') return
      if (command.command === 'delete') {
        const at = place(command.path)
        this.#forget(at.owner, at.path)
      } else if (command.command === 'rename') {
        const from = place(command.old_path)
        const to = place(command.new_path)
        const moved = Object.entries(this.#authorsOf(from.owner)).filter(([p]) => p === from.path || p.startsWith(`${from.path}/`))
        this.#forget(from.owner, from.path)
        for (const [p, author] of moved) this.#credit(to.owner, to.path + p.slice(from.path.length), author)
      } else {
        const at = place(command.path)
        this.#credit(at.owner, at.path, 'agent')
      }
    } catch (err) {
      log.warn('memory', 'Could not record who wrote a memory file', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  #authorsFile(owner: Owner): string {
    return join(dirname(this.rootFor(owner)), 'authors.json')
  }

  #authorsOf(owner: Owner): Record<string, Author> {
    let authors = this.#authors.get(owner)
    if (!authors) {
      const raw = readJson(this.#authorsFile(owner))
      authors = {}
      if (raw && typeof raw === 'object') {
        for (const [path, author] of Object.entries(raw)) if (author === 'agent' || author === 'you') authors[path] = author
      }
      this.#authors.set(owner, authors)
    }
    return authors
  }

  #credit(owner: Owner, path: string, author: Author): void {
    const authors = this.#authorsOf(owner)
    if (authors[path] === author) return
    authors[path] = author
    writeAtomic(this.#authorsFile(owner), JSON.stringify(authors))
  }

  /** Drops a path and everything under it. */
  #forget(owner: Owner, path: string): void {
    const authors = this.#authorsOf(owner)
    const gone = Object.keys(authors).filter((p) => p === path || p.startsWith(`${path}/`))
    if (gone.length === 0) return
    for (const p of gone) delete authors[p]
    writeAtomic(this.#authorsFile(owner), JSON.stringify(authors))
  }

  #resolve(path: string, owner: Owner): string {
    if (owner !== SHARED_OWNER && routeMemoryPath(path).shared) {
      throw new Error('/memories/shared is the shared folder. Save shared notes with the shared owner.')
    }
    return resolveMemoryPath(this.rootFor(owner), path)
  }

  #backend(owner: Owner): Promise<BetaLocalFilesystemMemoryTool> {
    let backend = this.#backends.get(owner)
    if (!backend) {
      // The SDK keeps memories in <base>/memories.
      backend = BetaLocalFilesystemMemoryTool.init(dirname(this.rootFor(owner)))
      this.#backends.set(owner, backend)
    }
    return backend
  }

  #run(backend: BetaLocalFilesystemMemoryTool, command: MemoryCommand): Promise<string> {
    switch (command.command) {
      case 'view': return backend.view(command)
      case 'create': return backend.create(command)
      case 'str_replace': return backend.str_replace({ ...command, new_str: command.new_str ?? '' })
      case 'insert': return backend.insert(command)
      case 'delete': return backend.delete(command)
      case 'rename': return backend.rename(command)
    }
  }

  /** The shared folder's first level, appended to a view of the companion's root. */
  async #sharedListing(): Promise<string> {
    const backend = await this.#backend(SHARED_OWNER)
    const lines = (await backend.view({ command: 'view', path: '/memories' })).split('\n').slice(1)
    const out: string[] = []
    for (const line of lines) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const size = line.slice(0, tab)
      const rest = line.slice(tab + 1).slice('/memories'.length)
      if (rest === '') out.push(`${size}\t${SHARED_PREFIX}/`)
      else if (!rest.replace(/\/$/, '').slice(1).includes('/')) out.push(`${size}\t${SHARED_PREFIX}${rest}`)
    }
    return out.join('\n')
  }

  /** A rename within one folder goes to its backend; across folders the file is moved here with the same checks. */
  async #rename(command: Extract<MemoryCommand, { command: 'rename' }>, companionId: string): Promise<string> {
    const from = routeMemoryPath(command.old_path)
    const to = routeMemoryPath(command.new_path)
    if (from.shared === to.shared) {
      const backend = await this.#backend(from.shared ? SHARED_OWNER : companionId)
      const output = await translated(from.shared, () => backend.rename({ command: 'rename', old_path: from.path, new_path: to.path }))
      return from.shared ? sharedToAgent(output) : output
    }
    const fromRoot = this.rootFor(from.shared ? SHARED_OWNER : companionId)
    const toRoot = this.rootFor(to.shared ? SHARED_OWNER : companionId)
    await this.#backend(from.shared ? SHARED_OWNER : companionId)
    await this.#backend(to.shared ? SHARED_OWNER : companionId)
    const source = resolveMemoryPath(fromRoot, from.path)
    const target = resolveMemoryPath(toRoot, to.path)
    if (source === resolve(fromRoot) || target === resolve(toRoot)) throw new Error('Cannot move a memory folder itself.')
    if (!existsSync(source)) throw new Error(`The path ${command.old_path} does not exist`)
    if (existsSync(target)) throw new Error(`The destination ${command.new_path} already exists`)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try {
      renameSync(source, target)
    } catch {
      cpSync(source, target, { recursive: true })
      rmSync(source, { recursive: true, force: true })
    }
    return `Successfully renamed ${command.old_path} to ${command.new_path}`
  }
}
