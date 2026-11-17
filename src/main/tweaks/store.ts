/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  TWEAK_LIMITS,
  DEFAULT_TWEAK_STYLE,
  tweakHostAllowed,
  cleanLabel,
  isSafeSelector,
  normalizeTweakHost,
  ownTweak,
  sanitizeCss,
  sanitizeJs,
  type Tweak,
  type TweakImportResult,
  type TweakPatch,
  type HiddenElement,
  type TweaksState,
} from '@shared/tweaks'
import { mainT } from '../i18n/mainT'
import { tweakFileSchema, type ImportedTweak } from './schemas'

// The tweaks file (TWK-01): <userData>/tweaks.json, written atomically after
// every change. A file that fails to parse loads as empty and is left alone
// until the next change replaces it. No Electron here, so tests drive it with
// a temporary folder.

export const TWEAKS_FILE = 'tweaks.json'
/**
 * Compatibility: the file's name before the rename. A profile without
 * tweaks.json yet reads this one once and writes tweaks.json from it at
 * once; the old file stays as it was, so an older Apex still finds it.
 */
export const LEGACY_TWEAKS_FILE = 'boosts.json' // compatibility: read once, never written

export interface TweakFileIo {
  read(): unknown
  write(text: string): void
  /** The file from before the rename, read only when there is no tweaks file yet (undefined when there is none either). */
  readLegacy?(): unknown
}

/** 2 since the rename (the list is "tweaks", each one's hidden elements "hidden"); 1 before it. */
const FILE_VERSION = 2

export class TweakError extends Error {}

export class TweakStore extends EventEmitter<{ changed: [TweaksState] }> {
  readonly #io: TweakFileIo | null
  readonly #now: () => number
  #tweaks: Tweak[] = []
  #scriptsAllowed = false

  constructor(io: TweakFileIo | null, now: () => number = Date.now) {
    super()
    this.#io = io
    this.#now = now
    let raw = io?.read()
    const legacy = raw === undefined ? io?.readLegacy?.() : undefined
    if (legacy !== undefined) raw = legacy
    const parsed = tweakFileSchema.safeParse(raw)
    if (parsed.success) {
      this.#scriptsAllowed = parsed.data.scriptsAllowed
      for (const b of parsed.data.tweaks) {
        const clean = this.#clean(b, b.id ?? randomUUID(), b.jsEnabled ?? false)
        if (clean && !this.#tweaks.some((x) => x.host === clean.host)) this.#tweaks.push(clean)
      }
      // Compatibility: what the old file held moves to tweaks.json now, under today's names.
      if (legacy !== undefined) this.#save()
    }
  }

  state(): TweaksState {
    return structuredClone({ tweaks: this.#tweaks, scriptsAllowed: this.#scriptsAllowed })
  }

  get(id: string): Tweak | null {
    const b = this.#tweaks.find((x) => x.id === id)
    return b ? structuredClone(b) : null
  }

  /** The tweak that owns this host (exact, else one covering its subdomains). */
  owning(host: string): Tweak | null {
    const b = ownTweak(this.#tweaks, host)
    return b ? structuredClone(b) : null
  }

  create(hostOrUrl: string): Tweak {
    const host = this.#host(hostOrUrl)
    const existing = this.#tweaks.find((b) => b.host === host)
    if (existing) return structuredClone(existing)
    if (this.#tweaks.length >= TWEAK_LIMITS.tweaks) throw new TweakError(mainT('tweaks.error.tooMany'))
    const now = this.#now()
    const tweak: Tweak = { id: randomUUID(), host, subdomains: false, enabled: true, hidden: [], style: { ...DEFAULT_TWEAK_STYLE }, css: '', js: '', jsEnabled: false, createdAt: now, updatedAt: now }
    this.#tweaks.push(tweak)
    this.#changed()
    return structuredClone(tweak)
  }

  update(id: string, patch: TweakPatch): Tweak {
    const b = this.#find(id)
    if (patch.enabled !== undefined) b.enabled = patch.enabled
    if (patch.subdomains !== undefined) b.subdomains = patch.subdomains
    if (patch.css !== undefined) b.css = sanitizeCss(patch.css).css
    if (patch.js !== undefined) b.js = sanitizeJs(patch.js)
    if (patch.jsEnabled !== undefined) b.jsEnabled = patch.jsEnabled
    if (patch.style) b.style = { ...b.style, ...patch.style }
    b.updatedAt = this.#now()
    this.#changed()
    return structuredClone(b)
  }

  remove(id: string): void {
    const before = this.#tweaks.length
    this.#tweaks = this.#tweaks.filter((b) => b.id !== id)
    if (this.#tweaks.length !== before) this.#changed()
  }

  /** Puts a removed tweak back as it was (its script switch included: it was the person's own). */
  restore(tweak: ImportedTweak & { id: string }): Tweak {
    const clean = this.#clean(tweak, tweak.id, tweak.jsEnabled ?? false)
    if (!clean) throw new TweakError(mainT('tweaks.error.restore'))
    this.#tweaks = this.#tweaks.filter((b) => b.id !== clean.id && b.host !== clean.host)
    this.#tweaks.push(clean)
    this.#changed()
    return structuredClone(clean)
  }

  /** Adds a hidden element to the tweak that owns the host, making (and turning on) one as needed. */
  addHidden(host: string, selector: string, label: string): { tweak: Tweak; element: HiddenElement } {
    if (!isSafeSelector(selector)) throw new TweakError(mainT('tweaks.error.selector'))
    let b = ownTweak(this.#tweaks, host)
    if (!b) {
      this.create(host)
      b = this.#tweaks.find((x) => x.host === normalizeTweakHost(host))
    }
    if (!b) throw new TweakError(mainT('tweaks.error.host'))
    const existing = b.hidden.find((el) => el.selector === selector.trim())
    if (existing) return { tweak: structuredClone(b), element: { ...existing } }
    if (b.hidden.length >= TWEAK_LIMITS.hidden) throw new TweakError(mainT('tweaks.error.tooManyHidden'))
    const element: HiddenElement = { id: randomUUID(), selector: selector.trim(), label: cleanLabel(label), createdAt: this.#now() }
    b.hidden.push(element)
    b.enabled = true
    b.updatedAt = this.#now()
    this.#changed()
    return { tweak: structuredClone(b), element: { ...element } }
  }

  removeHidden(id: string, hiddenId: string): Tweak {
    const b = this.#find(id)
    const before = b.hidden.length
    b.hidden = b.hidden.filter((el) => el.id !== hiddenId)
    if (b.hidden.length !== before) {
      b.updatedAt = this.#now()
      this.#changed()
    }
    return structuredClone(b)
  }

  clearHidden(id: string): Tweak {
    const b = this.#find(id)
    if (b.hidden.length > 0) {
      b.hidden = []
      b.updatedAt = this.#now()
      this.#changed()
    }
    return structuredClone(b)
  }

  setScriptsAllowed(on: boolean): TweaksState {
    if (this.#scriptsAllowed !== on) {
      this.#scriptsAllowed = on
      this.#changed()
    }
    return this.state()
  }

  /**
   * Adds tweaks someone exported. One for a host that already has a tweak
   * replaces it (keeping its id); scripts come in switched off, so nothing
   * imported runs before its owner has read it here.
   */
  importTweaks(list: readonly ImportedTweak[]): TweakImportResult {
    const result: TweakImportResult = { added: 0, replaced: 0, skipped: 0, scripts: 0 }
    for (const input of list) {
      const host = normalizeTweakHost(input.host)
      const existing = host ? this.#tweaks.find((b) => b.host === host) : undefined
      if (!existing && this.#tweaks.length >= TWEAK_LIMITS.tweaks) {
        result.skipped++
        continue
      }
      const clean = this.#clean(input, existing?.id ?? randomUUID(), false)
      if (!clean) {
        result.skipped++
        continue
      }
      if (clean.js.trim()) result.scripts++
      if (existing) {
        this.#tweaks[this.#tweaks.indexOf(existing)] = { ...clean, createdAt: existing.createdAt }
        result.replaced++
      } else {
        this.#tweaks.push(clean)
        result.added++
      }
    }
    if (result.added + result.replaced > 0) this.#changed()
    return result
  }

  #host(hostOrUrl: string): string {
    const host = normalizeTweakHost(hostOrUrl)
    if (!host) throw new TweakError(mainT('tweaks.error.host'))
    if (!tweakHostAllowed(host)) throw new TweakError(mainT('tweaks.error.signIn'))
    return host
  }

  #find(id: string): Tweak {
    const b = this.#tweaks.find((x) => x.id === id)
    if (!b) throw new TweakError(mainT('tweaks.error.missing'))
    return b
  }

  /** A stored or imported tweak as Apex keeps it, or null when its host can't have one. */
  #clean(input: ImportedTweak, id: string, jsEnabled: boolean): Tweak | null {
    const host = normalizeTweakHost(input.host)
    if (!host || !tweakHostAllowed(host)) return null
    const now = this.#now()
    const seen = new Set<string>()
    const hidden: HiddenElement[] = []
    for (const el of input.hidden) {
      const selector = el.selector.trim()
      if (!isSafeSelector(selector) || seen.has(selector) || hidden.length >= TWEAK_LIMITS.hidden) continue
      seen.add(selector)
      hidden.push({ id: el.id ?? randomUUID(), selector, label: cleanLabel(el.label ?? ''), createdAt: el.createdAt ?? now })
    }
    const js = sanitizeJs(input.js)
    return {
      id,
      host,
      subdomains: input.subdomains,
      enabled: input.enabled,
      hidden,
      style: { ...DEFAULT_TWEAK_STYLE, ...input.style },
      css: sanitizeCss(input.css).css,
      js,
      jsEnabled: jsEnabled && js.trim().length > 0,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
  }

  #save(): void {
    this.#io?.write(JSON.stringify({ version: FILE_VERSION, scriptsAllowed: this.#scriptsAllowed, tweaks: this.#tweaks }, null, 2))
  }

  #changed(): void {
    this.#save()
    this.emit('changed', this.state())
  }
}
