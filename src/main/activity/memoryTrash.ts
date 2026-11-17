/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Memory notes in Recently Deleted (a TrashAdapter, kind 'memory'):
// deleting a note, or every note of an owner, moves the files into the
// trash folder; restoring moves them back (with "(restored)" on a name
// clash) and keeps who wrote each one.
import { existsSync, readdirSync } from 'node:fs'
import { SHARED_OWNER } from '@shared/chats'
import type { MemoryFile, Owner } from '@shared/services'
import type { TrashAdapter } from '../workspace/adapters'

type Author = NonNullable<MemoryFile['author']>

export interface MemoryTrashTarget {
  list(owner: Owner): MemoryFile[]
  rootFor(owner: Owner): string
  pathOnDisk(path: string, owner: Owner): string
  adopt(owner: Owner, path: string, source: string, authors: Record<string, Author>): string
}

interface Payload {
  owner: Owner
  paths: string[]
  authors: Record<string, Author>
}

/** The trash id for one note, or for every note of an owner (`path` '*'). */
export function memoryTrashId(owner: Owner, path: string): string {
  return JSON.stringify({ o: owner, p: path })
}

function parseId(id: string): { owner: Owner; path: string } {
  const raw = JSON.parse(id) as { o?: unknown; p?: unknown }
  if (typeof raw.o !== 'string' || typeof raw.p !== 'string') throw new Error('Not a memory note.')
  return { owner: raw.o, path: raw.p }
}

function noteName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function memoryTrashAdapter(memory: MemoryTrashTarget, companionName: (id: string) => string): TrashAdapter {
  const whose = (owner: Owner): string => (owner === SHARED_OWNER ? 'shared notes' : `${companionName(owner)}’s notes`)
  return {
    kind: 'memory',
    title(id) {
      const { owner, path } = parseId(id)
      return path === '*' ? `All ${whose(owner)}` : `${noteName(path)} (${whose(owner)})`
    },
    snapshot(id) {
      const { owner, path } = parseId(id)
      const authors: Record<string, Author> = {}
      for (const file of memory.list(owner)) if (file.author) authors[file.path] = file.author
      if (path !== '*') return { payload: { owner, paths: [path], authors } satisfies Payload, files: [memory.pathOnDisk(path, owner)] }
      // Everything at the top of the owner's folder; a companion's /memories/shared is the shared folder, never its own.
      const root = memory.rootFor(owner)
      const names = existsSync(root) ? readdirSync(root).filter((n) => !n.startsWith('.') && !(owner !== SHARED_OWNER && n === 'shared')) : []
      const paths = names.map((n) => `/memories/${n}`)
      return { payload: { owner, paths, authors } satisfies Payload, files: paths.map((p) => memory.pathOnDisk(p, owner)) }
    },
    restore(payload, files) {
      const p = payload as Payload
      const landed = p.paths.map((path, i) => (files[i] ? memory.adopt(p.owner, path, files[i] as string, p.authors ?? {}) : path))
      return landed.length === 1 ? `${noteName(landed[0] as string)} (${whose(p.owner)})` : `All ${whose(p.owner)}`
    },
  }
}
