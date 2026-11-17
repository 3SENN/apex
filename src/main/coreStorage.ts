/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from 'electron'
import type { ChatSummary } from '@shared/chats'
import type { ChatStorageRow } from '@shared/services/settings'
import type { ChatStore } from './chats'
import { measureImages, olderThan, stripImages } from './chatImages'
import { clearCache, clearSiteData } from './clearData'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { registerResetStep } from './reset'
import { registerStorageCategory } from './storage'

// The core storage categories and reset steps (ST-53 to ST-55): what the
// browser core keeps in userData. Other features register their own.

/** Total size of a file or folder; missing paths are 0 and unreadable entries are skipped. */
export async function pathSize(path: string, depth = 0): Promise<number> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return info.size
    if (depth > 32) return 0
    const entries = await readdir(path)
    let total = 0
    for (const entry of entries) total += await pathSize(join(path, entry), depth + 1)
    return total
  } catch {
    return 0
  }
}

/** Images per chat, cached by file size and time so a second visit to Storage is quick. */
export class ChatSizes {
  readonly #dir: string
  readonly #cache = new Map<string, { size: number; mtime: number; imageBytes: number; images: number }>()

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'chats')
  }

  async measure(id: string): Promise<{ bytes: number; imageBytes: number; images: number }> {
    const file = join(this.#dir, `${id}.json`)
    let info: { size: number; mtimeMs: number }
    try {
      info = await stat(file)
    } catch {
      return { bytes: 0, imageBytes: 0, images: 0 }
    }
    const text = await pathSize(join(this.#dir, `${id}.txt`))
    const cached = this.#cache.get(id)
    if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) return { bytes: info.size + text, imageBytes: cached.imageBytes, images: cached.images }
    let imageBytes = 0
    let images = 0
    try {
      const stats = measureImages(JSON.parse(await readFile(file, 'utf8')) as unknown)
      imageBytes = stats.bytes
      images = stats.count
    } catch {
      // An unreadable chat counts as text.
    }
    this.#cache.set(id, { size: info.size, mtime: info.mtimeMs, imageBytes, images })
    return { bytes: info.size + text, imageBytes, images }
  }

  async rows(chats: readonly ChatSummary[]): Promise<ChatStorageRow[]> {
    const rows: ChatStorageRow[] = []
    for (const chat of chats) {
      if (chat.draft) continue
      const m = await this.measure(chat.id)
      rows.push({ chatId: chat.id, title: chat.title, bytes: m.bytes, imageBytes: m.imageBytes, updatedAt: chat.lastActiveAt ?? chat.updatedAt })
      // Let other work run between files on a big library.
      await new Promise((resolve) => setImmediate(resolve))
    }
    return rows.sort((a, b) => b.bytes - a.bytes)
  }

  forget(id: string): void {
    this.#cache.delete(id)
  }
}

export interface CoreStorageDeps {
  dataDir: string
  chats: ChatStore
  sizes: ChatSizes
  /** Stops a chat's live session so a rewrite on disk isn't overwritten from memory. */
  discard(ids: string[]): void
  history: { clear(): void }
  bookmarks: { list(): Array<{ id: string }>; remove(id: string): void }
  sessions(): Session[]
  /** Stops every chat and routine (reset's first step). */
  stopAll(): void
  /** Deletes the saved API key (reset's secret step). */
  removeApiKey(): void
}

/** Removes images from chats older than `days` (or these chats), skipping chats that are working. */
export async function removeChatImages(deps: Pick<CoreStorageDeps, 'chats' | 'sizes' | 'discard'>, options: { chatIds?: string[]; olderThanDays: number }, now = Date.now()): Promise<{ removed: number; bytes: number }> {
  const all = deps.chats.list().filter((c) => !c.draft && c.status !== 'running' && c.status !== 'needs-approval')
  const picked = options.chatIds ? all.filter((c) => options.chatIds?.includes(c.id)) : all
  const targets = olderThan(picked, options.olderThanDays, now)
  let removed = 0
  let bytes = 0
  for (const chat of targets) {
    const m = await deps.sizes.measure(chat.id)
    if (m.images === 0) continue
    let content
    try {
      content = deps.chats.load(chat.id)
    } catch {
      continue
    }
    const messages = stripImages(content.messages)
    const log = stripImages(content.log)
    const count = messages.removed.count + log.removed.count
    if (count === 0) continue
    deps.discard([chat.id])
    deps.chats.save({ ...content, messages: messages.value, log: log.value }, { touch: false })
    deps.sizes.forget(chat.id)
    removed += count
    bytes += messages.removed.bytes + log.removed.bytes
  }
  return { removed, bytes }
}

/** A files under userData that Reset Atelier deletes, by step. */
export const RESET_FILES = {
  browsing: ['history.json', 'bookmarks.json', 'pinned-tabs.json', 'downloads.json', 'session.json', 'sites.json', 'zoom.json', 'window-state.json'],
  chats: ['chats', 'agent', 'spend.json'],
  memory: ['memory'],
  companions: ['companions.json', 'companion.json', 'companion-files', 'skills.json', 'routines.json', 'connectors.json', 'connector-secrets.bin', 'first-week.json', 'first-week.invalid.json', 'tips.json'],
  caches: ['adblock-engine.bin', 'claude-code'],
  // Profiles, their per-profile settings and each profile's own data folder go with the settings.
  settings: ['settings.json', 'profile-settings.json', 'profiles.json', 'profiles'],
  secrets: ['anthropic-key.bin'],
} as const

async function removeFiles(dataDir: string, names: readonly string[], dryRun: boolean): Promise<string[]> {
  const removed: string[] = []
  for (const name of names) {
    const path = join(dataDir, name)
    try {
      await stat(path)
    } catch {
      continue
    }
    removed.push(name)
    if (!dryRun) await rm(path, { recursive: true, force: true })
  }
  return removed
}

/** Registers the core categories and reset steps; returns one function that undoes it all. */
export function registerCoreStorage(deps: CoreStorageDeps): () => void {
  const chatsDir = join(deps.dataDir, 'chats')
  const imageTotal = async (): Promise<number> => {
    let total = 0
    for (const chat of deps.chats.list()) if (!chat.draft) total += (await deps.sizes.measure(chat.id)).imageBytes
    return total
  }
  const cacheSize = async (): Promise<number> => {
    let total = 0
    for (const s of deps.sessions()) total += await s.getCacheSize()
    return total
  }
  const offs = [
    registerStorageCategory({ id: 'chats', label: mainT('settings.storage.chats'), order: 10, measure: async () => Math.max(0, (await pathSize(chatsDir)) - (await imageTotal())) }),
    registerStorageCategory({
      id: 'chat-images',
      label: mainT('settings.storage.chatImages'),
      order: 20,
      measure: imageTotal,
      clear: { label: mainT('settings.storagePage.images.button'), run: async () => void (await removeChatImages(deps, { olderThanDays: 0 })) },
    }),
    registerStorageCategory({ id: 'memory', label: mainT('settings.storage.memory'), order: 30, measure: () => pathSize(join(deps.dataDir, 'memory')) }),
    registerStorageCategory({
      id: 'history',
      label: mainT('settings.storage.history'),
      order: 40,
      measure: async () => (await pathSize(join(deps.dataDir, 'history.json'))) + (await pathSize(join(deps.dataDir, 'bookmarks.json'))),
      clear: { label: mainT('settings.privacy.history.confirm.button'), run: async () => deps.history.clear() },
    }),
    registerStorageCategory({
      id: 'website-data',
      label: mainT('settings.storage.websiteData'),
      order: 50,
      measure: async () => {
        let total = 0
        for (const s of deps.sessions()) {
          const path = s.getStoragePath()
          if (path) total += await pathSize(path)
        }
        return Math.max(0, total - (await cacheSize()))
      },
      clear: { label: mainT('settings.privacy.cookies.button'), run: () => clearSiteData(deps.sessions()) },
    }),
    registerStorageCategory({ id: 'cache', label: mainT('settings.storage.cache'), order: 60, measure: cacheSize, clear: { label: mainT('settings.privacy.cache.button'), run: () => clearCache(deps.sessions()) } }),

    registerResetStep({
      id: 'stop-work',
      order: 0,
      label: mainT('settings.reset.step.stop'),
      run: async ({ dryRun }) => {
        if (!dryRun) deps.stopAll()
        return { removed: [] }
      },
    }),
    registerResetStep({
      id: 'browsing-data',
      order: 10,
      label: mainT('settings.reset.step.browsing'),
      run: async ({ dryRun }) => {
        if (!dryRun) {
          deps.history.clear()
          for (const b of deps.bookmarks.list()) deps.bookmarks.remove(b.id)
        }
        return { removed: await removeFiles(deps.dataDir, RESET_FILES.browsing, dryRun) }
      },
    }),
    registerResetStep({ id: 'chats', order: 20, label: mainT('settings.reset.step.chats'), run: async ({ dryRun }) => ({ removed: await removeFiles(deps.dataDir, RESET_FILES.chats, dryRun) }) }),
    registerResetStep({ id: 'memory', order: 30, label: mainT('settings.reset.step.memory'), run: async ({ dryRun }) => ({ removed: await removeFiles(deps.dataDir, RESET_FILES.memory, dryRun) }) }),
    registerResetStep({ id: 'companions', order: 40, label: mainT('settings.reset.step.companions'), run: async ({ dryRun }) => ({ removed: await removeFiles(deps.dataDir, RESET_FILES.companions, dryRun) }) }),
    registerResetStep({
      id: 'site-data',
      order: 50,
      label: mainT('settings.reset.step.siteData'),
      run: async ({ dryRun }) => {
        if (!dryRun) {
          await clearSiteData(deps.sessions())
          await clearCache(deps.sessions())
        }
        return { removed: ['website data', ...(await removeFiles(deps.dataDir, RESET_FILES.caches, dryRun))] }
      },
    }),
    registerResetStep({ id: 'settings', order: 90, label: mainT('settings.reset.step.settings'), run: async ({ dryRun }) => ({ removed: await removeFiles(deps.dataDir, RESET_FILES.settings, dryRun) }) }),
    registerResetStep({
      id: 'api-key',
      order: 95,
      label: mainT('settings.reset.step.apiKey'),
      secrets: true,
      run: async ({ dryRun }) => {
        const removed = await removeFiles(deps.dataDir, RESET_FILES.secrets, true)
        if (!dryRun && removed.length) {
          try {
            deps.removeApiKey()
          } catch (err) {
            log.warn('settings', 'Removing the API key failed', { error: err instanceof Error ? err.message : String(err) })
            await removeFiles(deps.dataDir, RESET_FILES.secrets, false)
          }
        }
        return { removed }
      },
    }),
  ]
  return () => offs.forEach((off) => off())
}
