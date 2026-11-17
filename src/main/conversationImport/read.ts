/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reading picked export files (ON-10): a conversations.json, an Atelier .md
// export, or a .zip holding either (ChatGPT and Claude both ship zips), read
// with fflate. Oversized files and zip entries are refused.
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import type { ConversationSource } from '@shared/onboarding'
import { parseAtelierExport, parseConversationsJson, type ParsedConversation } from './parsers'

/** A picked file larger than this is refused. */
export const IMPORT_FILE_MAX = 512 * 1024 * 1024
/** One unzipped entry larger than this is skipped. */
export const IMPORT_ENTRY_MAX = 256 * 1024 * 1024

export interface ReadResult {
  conversations: ParsedConversation[]
  /** Files or entries that held nothing Atelier can import. */
  unreadable: string[]
}

function fromText(name: string, text: string, into: ReadResult): void {
  if (/\.md$/i.test(name)) {
    const parsed = parseAtelierExport(text)
    if (parsed) into.conversations.push(parsed)
    else into.unreadable.push(name)
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    into.unreadable.push(name)
    return
  }
  const { conversations } = parseConversationsJson(raw)
  if (conversations.length === 0) into.unreadable.push(name)
  into.conversations.push(...conversations)
}

/** The conversations in a zip's bytes: every conversations.json and Atelier .md inside it. */
export function readZip(name: string, bytes: Uint8Array, into: ReadResult = { conversations: [], unreadable: [] }): ReadResult {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter: (file) => file.originalSize <= IMPORT_ENTRY_MAX && (/(^|\/)conversations\.json$/i.test(file.name) || /\.md$/i.test(file.name)) && !file.name.startsWith('__MACOSX/'),
    })
  } catch {
    into.unreadable.push(name)
    return into
  }
  const names = Object.keys(entries).sort()
  if (names.length === 0) into.unreadable.push(name)
  for (const entry of names) {
    const data = entries[entry]
    if (data) fromText(entry, strFromU8(data), into)
  }
  return into
}

/** Reads one file's bytes by its extension. */
export function readExportBytes(name: string, bytes: Uint8Array, into: ReadResult = { conversations: [], unreadable: [] }): ReadResult {
  const ext = extname(name).toLowerCase()
  if (ext === '.zip') return readZip(name, bytes, into)
  if (ext === '.json' || ext === '.md') {
    fromText(name, strFromU8(bytes), into)
    return into
  }
  into.unreadable.push(name)
  return into
}

/** Reads every picked path. */
export function readExportFiles(paths: readonly string[]): ReadResult {
  const into: ReadResult = { conversations: [], unreadable: [] }
  for (const path of paths) {
    const name = basename(path)
    try {
      if (statSync(path).size > IMPORT_FILE_MAX) {
        into.unreadable.push(name)
        continue
      }
      readExportBytes(name, new Uint8Array(readFileSync(path)), into)
    } catch {
      into.unreadable.push(name)
    }
  }
  return into
}

export function sourcesOf(conversations: readonly ParsedConversation[]): ConversationSource[] {
  const order: ConversationSource[] = ['chatgpt', 'claude', 'atelier']
  return order.filter((s) => conversations.some((c) => c.source === s))
}
