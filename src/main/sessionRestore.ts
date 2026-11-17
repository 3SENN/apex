/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { GROUP_COLORS } from '@shared/tabs'
import { SESSION_VERSION, type SavedWindow, type SessionFile } from '@shared/windows'
import { log } from './log'

// Session restore. session.json holds every normal
// window with its bounds, display mode, sidebar, name, tabs with back
// history, groups and split. Writes are debounced and flush forces one (the updater
// calls it before restarting to update). A corrupt or newer file starts
// fresh, with a notice. Private windows are never written.

export const SESSION_FILE = 'session.json'
export const SESSION_DEBOUNCE_MS = 1000
/** Caps that keep a hostile or runaway file from costing much to read. */
const MAX_WINDOWS = 40
const MAX_TABS = 500
const MAX_ENTRIES = 50

type Writer = () => Promise<void>

let writer: Writer | null = null

export const sessionRestore = {
  /** app.ts installs the real writer. */
  setWriter(fn: Writer | null): void {
    writer = fn
  },
  async flush(): Promise<void> {
    await writer?.()
  },
}

/** A corrupt or newer file is ignored (the window starts fresh, with a notice). */
export function isReadableSession(raw: unknown): raw is SessionFile {
  return Boolean(raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 1 && Array.isArray((raw as { windows?: unknown }).windows))
}

const entry = z.object({ url: z.string().min(1).max(8192), title: z.string().max(1024) })
const tab = z.object({
  url: z.string().min(1).max(8192),
  title: z.string().max(1024),
  pinned: z.boolean(),
  groupId: z.string().max(128).nullable(),
  entries: z.array(entry).max(MAX_ENTRIES),
  index: z.number().int().min(0),
})
const group = z.object({ id: z.string().min(1).max(128), name: z.string().max(200), color: z.enum(GROUP_COLORS), collapsed: z.boolean() })
const bounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(200).max(20_000), height: z.number().finite().min(150).max(20_000) })
const savedWindow = z.object({
  bounds,
  displayMode: z.enum(['normal', 'maximized', 'fullscreen']),
  sidebarOpen: z.boolean(),
  name: z.string().max(80).nullable(),
  tabs: z.array(z.unknown()).max(MAX_TABS),
  activeIndex: z.number().int().min(0),
  split: z.object({ primary: z.number().int().min(0), secondary: z.number().int().min(0), ratio: z.number().finite().min(0).max(1) }).nullable(),
  groups: z.array(group).max(100),
 spaces: z.array(z.object({ projectId: z.string().min(1).max(128).nullable(), tabIndexes: z.array(z.number().int().min(0)).max(MAX_TABS), activeIndex: z.number().int().min(-1) })).max(200).optional(),
 profileId: z.string().min(1).max(128).optional(),
})

export type SessionRead = { ok: true; session: SessionFile } | { ok: false; reason: 'missing' | 'corrupt' | 'newer' }

/**
 * Reads session.json text. A newer version or broken JSON is refused as a
 * whole; inside a good file a bad tab or window is dropped, not the session.
 */
export function parseSession(text: string | null): SessionRead {
  if (text === null) return { ok: false, reason: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'corrupt' }
  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > SESSION_VERSION) return { ok: false, reason: 'newer' }
  if (!isReadableSession(raw)) return { ok: false, reason: 'corrupt' }
  const windows: SavedWindow[] = []
  for (const w of raw.windows.slice(0, MAX_WINDOWS)) {
    const parsed = savedWindow.safeParse(w)
    if (!parsed.success) continue
    const tabs = parsed.data.tabs.flatMap((t) => {
      const ok = tab.safeParse(t)
      if (!ok.success) return []
      return [{ ...ok.data, index: Math.min(ok.data.index, Math.max(0, ok.data.entries.length - 1)) }]
    })
    if (tabs.length === 0) continue
    const fix = (i: number): number => Math.min(i, tabs.length - 1)
    const split = parsed.data.split && parsed.data.split.primary < tabs.length && parsed.data.split.secondary < tabs.length && parsed.data.split.primary !== parsed.data.split.secondary ? parsed.data.split : null
    windows.push({ ...parsed.data, tabs, activeIndex: fix(parsed.data.activeIndex), split })
  }
  return { ok: true, session: { version: SESSION_VERSION, windows } }
}

export function readSessionFile(path: string): SessionRead {
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('session', 'session.json could not be read', { error: err instanceof Error ? err.message : String(err) })
  }
  return parseSession(text)
}

/** Writes atomically, so a crash mid-write never leaves half a file. */
export function writeSessionFile(path: string, session: SessionFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(session), 'utf8')
  renameSync(tmp, path)
}

/**
 * Windows and Linux quit once the last window has closed (the X button), so
 * by the time quitting saves, that window is gone from what the windows
 * serialize. With `keep`, a session that has windows stays over one that has
 * none: the last window's tabs come back on the next start, as quitting
 * leaves them. (macOS doesn't keep: closing its last window leaves Atelier in the
 * Dock, and a quit after that starts afresh.)
 */
export function keepingLastWindows(collect: () => SessionFile, keep: boolean): () => SessionFile {
  let last: SessionFile | null = null
  return () => {
    const now = collect()
    if (!keep || now.windows.length > 0) {
      last = now
      return now
    }
    return last ?? now
  }
}

/**
 * Debounced writes of what `collect` returns. `schedule` after any change;
 * `flush` writes now (quit, the update restart). A write that fails is logged and
 * retried on the next change.
 */
export class SessionWriter {
  readonly #path: string
  readonly #collect: () => SessionFile
  readonly #write: (path: string, session: SessionFile) => void
  readonly #delay: number
  #timer: NodeJS.Timeout | null = null
  #frozen = false

  constructor(path: string, collect: () => SessionFile, opts: { write?: (path: string, session: SessionFile) => void; delayMs?: number } = {}) {
    this.#path = path
    this.#collect = collect
    this.#write = opts.write ?? writeSessionFile
    this.#delay = opts.delayMs ?? SESSION_DEBOUNCE_MS
  }

  schedule(): void {
    if (this.#frozen || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#writeNow()
    }, this.#delay)
  }

  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#writeNow()
  }

  /** After the final write on quit: windows closing one by one must not shrink the saved session. */
  freeze(): void {
    this.#frozen = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #writeNow(): void {
    try {
      this.#write(this.#path, this.#collect())
    } catch (err) {
      log.warn('session', 'session.json could not be written', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// SavedWindow.spaces: the session writer asks each part for its fields when it saves a window, and hands them back after restoring its tabs
export interface SavedWindowPart {
  /** Extra SavedWindow fields; `tabIds` are the window's tab ids in the order they are saved. */
  save(windowId: number, tabIds: readonly string[]): Partial<SavedWindow>
  /** After a window's tabs are restored: `tabIds` hold the new ids at the saved indexes. */
  restore(windowId: number, saved: SavedWindow, tabIds: readonly string[]): void
}

const savedWindowParts: SavedWindowPart[] = []

export function registerSavedWindowPart(part: SavedWindowPart): () => void {
  savedWindowParts.push(part)
  return () => {
    const i = savedWindowParts.indexOf(part)
    if (i >= 0) savedWindowParts.splice(i, 1)
  }
}

/** Every part's fields for one window, merged (the writer spreads them into SavedWindow). */
export function savedWindowExtras(windowId: number, tabIds: readonly string[]): Partial<SavedWindow> {
  return Object.assign({}, ...savedWindowParts.map((p) => p.save(windowId, tabIds))) as Partial<SavedWindow>
}

/** Hands a restored window's saved fields back to every part. */
export function restoreSavedWindowExtras(windowId: number, saved: SavedWindow, tabIds: readonly string[]): void {
  for (const part of savedWindowParts) part.restore(windowId, saved, tabIds)
}
