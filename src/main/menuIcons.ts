/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { nativeImage, type NativeImage, type Session } from 'electron'
import { log } from './log'

// 16 px favicons for native menu rows (tabs, recently visited, bookmarks).
// data: URLs decode at once; an http(s) favicon is fetched once through the
// window's own session (its cookies and blockers apply), capped in size and
// time, and the menus rebuild when it arrives. Failures are remembered so a
// broken icon is never asked for again in this run.

const MAX_ENTRIES = 300
const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 4000
const MAX_URL = 2048

export class MenuIconCache {
  readonly #images = new Map<string, NativeImage | null>()
  readonly #pending = new Set<string>()
  readonly #loaded: () => void

  constructor(loaded: () => void) {
    this.#loaded = loaded
  }

  /** The icon if it is ready; starts loading it otherwise. */
  get(url: string | null | undefined, session: Session | null): NativeImage | undefined {
    if (!url || url.length > MAX_URL) return undefined
    if (this.#images.has(url)) return this.#images.get(url) ?? undefined
    if (url.startsWith('data:image/')) {
      const image = small(nativeImage.createFromDataURL(url))
      this.#remember(url, image)
      return image ?? undefined
    }
    if (/^https?:\/\//i.test(url) && session) void this.#fetch(url, session)
    return undefined
  }

  async #fetch(url: string, session: Session): Promise<void> {
    if (this.#pending.has(url)) return
    this.#pending.add(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await session.fetch(url, { signal: controller.signal })
      const length = Number(response.headers.get('content-length') ?? 0)
      if (!response.ok || length > MAX_BYTES) throw new Error(`status ${response.status}`)
      const body = Buffer.from(await response.arrayBuffer())
      if (body.byteLength > MAX_BYTES) throw new Error('too large')
      this.#remember(url, small(nativeImage.createFromBuffer(body)))
      this.#loaded()
    } catch (err) {
      this.#remember(url, null)
      log.debug('menu', 'Menu icon unavailable', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      clearTimeout(timer)
      this.#pending.delete(url)
    }
  }

  #remember(url: string, image: NativeImage | null): void {
    if (this.#images.size >= MAX_ENTRIES) {
      const oldest = this.#images.keys().next().value
      if (oldest !== undefined) this.#images.delete(oldest)
    }
    this.#images.set(url, image)
  }
}

function small(image: NativeImage): NativeImage | null {
  return image.isEmpty() ? null : image.resize({ width: 16, height: 16, quality: 'best' })
}
