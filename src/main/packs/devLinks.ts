/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Developer mode (docs/apps.md › Freedom): a pack loaded from a folder runs
// straight from it and reloads when a file changes, the way an unpacked
// extension does. One watcher per linked folder of a pack that is on; a burst
// of changes (a build writing many files) reloads once, a moment after it
// settles. The pack's open tabs reload with it.
import { watch, type FSWatcher } from 'node:fs'
import { log } from '../log'
import type { PackStore } from './store'

const SETTLE_MS = 300

export class DevLinks {
  readonly #store: PackStore
  readonly #onReloaded: (id: string) => void
  readonly #watchers = new Map<string, { dir: string; watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(store: PackStore, onReloaded: (id: string) => void) {
    this.#store = store
    this.#onReloaded = onReloaded
  }

  /** Watches exactly the linked folders of packs that are on. */
  sync(): void {
    const wanted = new Map(this.#store.linkedFolders().map((l) => [l.id, l.dir]))
    for (const [id, w] of this.#watchers) {
      if (wanted.get(id) === w.dir) continue
      this.#stop(id)
    }
    for (const [id, dir] of wanted) {
      if (this.#watchers.has(id)) continue
      try {
        const watcher = watch(dir, { recursive: true }, (_event, name) => {
          // Editors and git leave these behind; they're never part of a pack.
          if (name && /(^|[\\/])(\.git|node_modules|\.DS_Store)([\\/]|$)/.test(String(name))) return
          this.#schedule(id)
        })
        watcher.on('error', () => this.#stop(id))
        this.#watchers.set(id, { dir, watcher, timer: null })
      } catch (err) {
        log.warn('packs', 'A linked pack folder could not be watched', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  #schedule(id: string): void {
    const w = this.#watchers.get(id)
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    w.timer = setTimeout(() => {
      w.timer = null
      try {
        this.#store.reloadLinked(id)
      } catch (err) {
        log.warn('packs', 'A linked pack folder could not be read again', { error: err instanceof Error ? err.message : String(err) })
        return
      }
      this.#onReloaded(id)
    }, SETTLE_MS)
  }

  #stop(id: string): void {
    const w = this.#watchers.get(id)
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    w.watcher.close()
    this.#watchers.delete(id)
  }

  dispose(): void {
    for (const id of [...this.#watchers.keys()]) this.#stop(id)
  }
}
