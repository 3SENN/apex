/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The plugin model between packs (docs/apps.md › Everything is a plugin):
// which packs that are on can run, which wait for a service or a pack they
// need, and who provides each service; and the router that carries service
// calls to a provider's open page and events to the pages that listen.
//
// Packs are never trusted with each other's code or storage: a call is a
// name, a method and JSON, checked in main against both manifests (the
// runtime does that before it reaches the router), and the answer is JSON
// again. A service has one provider at a time, so another pack can stand in
// for it, as in the harness's capability seams.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { APEX_SERVICES_AVAILABLE, PACK_IPC, PACK_SERVICE_LIMITS, packVersionMeets, type PackEventMessage, type PackManifest, type PackServiceCallMessage } from '@shared/packs'

/** Why a pack that is on waits instead of running. */
export type WaitReason = { kind: 'service'; name: string } | { kind: 'pack'; id: string; version: string | null } | { kind: 'version'; id: string; want: string; have: string }

export interface PluginState {
  /** Packs that run: on, without problems, with every service and pack they need. */
  running: Set<string>
  waiting: Map<string, WaitReason[]>
  /** Each service's provider among the running packs. */
  providers: Map<string, string>
  /** A service more than one running pack provides: the first is used, the others are listed. */
  conflicts: Map<string, string[]>
}

/**
 * Settles which packs run. A pack waits while a service it uses has no
 * running provider or a pack it requires isn't running (or is too old);
 * since a waiting pack provides nothing, this repeats until nothing changes.
 * `packs` are the packs that are on, in the order the first provider of a
 * service should win.
 */
export function resolvePlugins(packs: ReadonlyArray<{ id: string; manifest: Pick<PackManifest, 'version' | 'provides' | 'uses' | 'requires'> }>): PluginState {
  const candidates = new Map(packs.map((p) => [p.id, p]))
  const waiting = new Map<string, WaitReason[]>()
  for (;;) {
    const providers = new Map<string, string>()
    const conflicts = new Map<string, string[]>()
    for (const p of candidates.values()) {
      for (const svc of p.manifest.provides ?? []) {
        if (!providers.has(svc.service)) providers.set(svc.service, p.id)
        else conflicts.set(svc.service, [...(conflicts.get(svc.service) ?? []), p.id])
      }
    }
    let changed = false
    for (const p of [...candidates.values()]) {
      const reasons: WaitReason[] = []
      for (const name of p.manifest.uses ?? []) {
        if (APEX_SERVICES_AVAILABLE.includes(name)) continue
        const from = providers.get(name)
        if (!from || from === p.id) reasons.push({ kind: 'service', name })
      }
      for (const [id, want] of Object.entries(p.manifest.requires?.packs ?? {})) {
        const other = candidates.get(id)
        if (!other) reasons.push({ kind: 'pack', id, version: want.replace(/^>=/, '') })
        else if (!packVersionMeets(other.manifest.version, want)) reasons.push({ kind: 'version', id, want: want.replace(/^>=/, ''), have: other.manifest.version })
      }
      if (reasons.length > 0) {
        waiting.set(p.id, reasons)
        candidates.delete(p.id)
        changed = true
      }
    }
    if (!changed) return { running: new Set(candidates.keys()), waiting, providers, conflicts }
  }
}

export type CallOutcome = { ok: true; value: unknown } | { ok: false; error: string }

interface PageEntry {
  contents: WebContents
  packId: string
  services: Set<string>
  listens: Set<string>
}

/** JSON only, and not too much of it: what crosses between packs. */
export function jsonPayload(value: unknown, max: number = PACK_SERVICE_LIMITS.payloadBytes): { ok: true; value: unknown } | { ok: false; error: string } {
  let text: string
  try {
    text = JSON.stringify(value === undefined ? null : value)
  } catch {
    return { ok: false, error: 'Only what JSON can hold crosses between packs.' }
  }
  if (Buffer.byteLength(text) > max) return { ok: false, error: `It is larger than ${Math.round(max / 1024)} KB.` }
  return { ok: true, value: JSON.parse(text) as unknown }
}

/** Carries service calls to the pages that provide them and events to the pages that listen. */
export class ServiceRouter {
  readonly #pages = new Map<number, PageEntry>()
  readonly #pending = new Map<string, { contents: WebContents; settle(outcome: CallOutcome): void }>()
  readonly #rates = new Map<string, number[]>()
  readonly #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
    ipcMain.on(PACK_IPC.serviceResult, this.#onResult)
  }

  readonly #onResult = (event: IpcMainEvent, raw: unknown): void => {
    if (!raw || typeof raw !== 'object' || event.senderFrame !== event.sender.mainFrame) return
    const message = raw as { callId?: unknown; ok?: unknown; value?: unknown; error?: unknown }
    const pending = typeof message.callId === 'string' ? this.#pending.get(message.callId) : undefined
    // Only the page the call went to may answer it.
    if (!pending || pending.contents !== event.sender) return
    this.#pending.delete(message.callId as string)
    pending.settle(message.ok === true ? { ok: true, value: message.value } : { ok: false, error: typeof message.error === 'string' ? message.error.slice(0, 4_000) : 'The service failed.' })
  }

  #entry(contents: WebContents, packId: string): PageEntry {
    const existing = this.#pages.get(contents.id)
    if (existing && existing.packId === packId) return existing
    const entry: PageEntry = { contents, packId, services: new Set(), listens: new Set() }
    this.#pages.set(contents.id, entry)
    const id = contents.id
    const forget = (): void => {
      if (this.#pages.get(id) === entry) this.#pages.delete(id)
      for (const [callId, p] of this.#pending) {
        if (p.contents !== contents) continue
        this.#pending.delete(callId)
        p.settle({ ok: false, error: 'The page that provides this service closed.' })
      }
    }
    contents.once('destroyed', forget)
    // A page that navigates (a reload, say) registers again when it is ready.
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        entry.services.clear()
        entry.listens.clear()
      }
    })
    return entry
  }

  /** A page of `packId` serves these of its services (already checked against its manifest). */
  provide(contents: WebContents, packId: string, services: readonly string[]): void {
    const entry = this.#entry(contents, packId)
    entry.services = new Set(services)
  }

  /** A page of `packId` hears these events (already checked against its manifest). */
  listen(contents: WebContents, packId: string, names: readonly string[]): void {
    const entry = this.#entry(contents, packId)
    entry.listens = new Set(names)
  }

  /** The newest open page of a pack that serves a service, or null. */
  pageFor(packId: string, service: string): WebContents | null {
    let found: WebContents | null = null
    for (const entry of this.#pages.values()) {
      if (entry.packId === packId && entry.services.has(service) && !entry.contents.isDestroyed()) found = entry.contents
    }
    return found
  }

  /** Sends one call to a providing page and waits for its answer. */
  callPage(contents: WebContents, call: Omit<PackServiceCallMessage, 'callId'>, timeoutMs: number = PACK_SERVICE_LIMITS.callTimeoutMs): Promise<CallOutcome> {
    return new Promise((resolve) => {
      const callId = randomUUID()
      const timer = setTimeout(() => settle({ ok: false, error: `The service took longer than ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs)
      const settle = (outcome: CallOutcome): void => {
        clearTimeout(timer)
        this.#pending.delete(callId)
        resolve(outcome)
      }
      this.#pending.set(callId, { contents, settle })
      const message: PackServiceCallMessage = { callId, ...call }
      contents.send(PACK_IPC.serviceCall, message)
    })
  }

  /** Whether a pack may send another event now (a rolling second). */
  allowEvent(packId: string): boolean {
    const at = this.#now()
    const recent = (this.#rates.get(packId) ?? []).filter((t) => at - t < 1000)
    if (recent.length >= PACK_SERVICE_LIMITS.eventsPerSecond) return false
    recent.push(at)
    this.#rates.set(packId, recent)
    return true
  }

  /** Delivers an event to every open page that listens to its name; the number it reached. */
  emit(name: string, data: unknown, except?: WebContents): number {
    const message: PackEventMessage = { name, data }
    let reached = 0
    for (const entry of this.#pages.values()) {
      if (!entry.listens.has(name) || entry.contents === except || entry.contents.isDestroyed()) continue
      entry.contents.send(PACK_IPC.event, message)
      reached++
    }
    return reached
  }

  /** Forgets everything one pack's pages registered (it went off or changed). */
  forgetPack(packId: string): void {
    for (const [id, entry] of this.#pages) if (entry.packId === packId) this.#pages.delete(id)
  }

  dispose(): void {
    ipcMain.off(PACK_IPC.serviceResult, this.#onResult)
    for (const p of this.#pending.values()) p.settle({ ok: false, error: `${BRAND_NAME} is closing.` })
    this.#pending.clear()
    this.#pages.clear()
  }
}
