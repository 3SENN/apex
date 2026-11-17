/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { ATTACHMENT_LIMITS, type AttachmentRef, type AttachmentSource, type RefAttachment } from '@shared/attachments'
import { t } from '@shared/i18n/core'
import { apex, call, errorText } from '../../api'
import { toast } from '../../ui'
import { preflightFiles, type FileRejection } from '../logic/drop'
import { withReplyRef } from '../logic/intake'

// Each draft's attachments (CH-22), keyed by the chat id like the draft
// text. Main's intake owns the refs and reports every change as an
// 'attachments' event; this mirrors them, adds the files the renderer turned
// away before reading (with their reason), and keeps the mention tokens that
// tie a tab or chat chip to its "@name" in the text.

export interface Rejected {
  id: string
  name: string
  reason: string
}

export interface DraftIntake {
  items: readonly AttachmentRef[]
  rejected: readonly Rejected[]
  loaded: boolean
}

interface Entry {
  items: AttachmentRef[]
  rejected: Rejected[]
  loaded: boolean
  loading: boolean
  /** Sent with a message: hidden until main's next event drops them. */
  sent: Set<string>
  /** Taken by the inline editor of a sent message (CH-09), so the composer doesn't show them too. */
  claimed: Set<string>
  /** attachment id → its "@name" token in the draft. */
  tokens: Map<string, string>
  view: DraftIntake
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const EMPTY: DraftIntake = { items: [], rejected: [], loaded: false }
let listening = false
let localIds = 0

function entry(key: string): Entry {
  let e = entries.get(key)
  if (!e) {
    e = { items: [], rejected: [], loaded: false, loading: false, sent: new Set(), claimed: new Set(), tokens: new Map(), view: EMPTY }
    entries.set(key, e)
  }
  return e
}

function publish(e: Entry): void {
  const shown = e.items.filter((a) => !e.sent.has(a.id) && !e.claimed.has(a.id))
  e.view = { items: shown, rejected: [...e.rejected], loaded: e.loaded }
  for (const fn of [...listeners]) fn()
}

function setItems(key: string, items: AttachmentRef[]): void {
  const e = entry(key)
  e.items = items
  e.loaded = true
  // Sent refs that main has let go of need no hiding any more.
  for (const id of [...e.sent]) if (!items.some((a) => a.id === id)) e.sent.delete(id)
  for (const id of [...e.tokens.keys()]) if (!items.some((a) => a.id === id)) e.tokens.delete(id)
  publish(e)
}

/** A ref from main's reply to add, pick or retry; one an event already brought is newer (withReplyRef). */
function upsert(key: string, ref: AttachmentRef): void {
  const next = withReplyRef(entry(key).items, ref)
  if (next) setItems(key, next)
}

function listen(): void {
  if (listening) return
  listening = true
  apex.onAppEvent((event) => {
    if (event.type === 'attachments') setItems(event.draftKey, event.items)
  })
}

function load(key: string): void {
  listen()
  const e = entry(key)
  if (e.loaded || e.loading) return
  e.loading = true
  call('attachments', 'list', key).then(
    (items) => {
      e.loading = false
      setItems(key, items)
    },
    () => {
      // The intake isn't there (or refused): the draft simply starts empty.
      e.loading = false
      e.loaded = true
      publish(e)
    },
  )
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The draft's chips, kept live. A null key (no chat yet) is always empty. */
export function useDraftIntake(key: string | null): DraftIntake {
  return useSyncExternalStore(subscribe, () => {
    if (!key) return EMPTY
    load(key)
    return entry(key).view
  })
}

export function draftIntake(key: string): DraftIntake {
  load(key)
  return entry(key).view
}

function failed(err: unknown): void {
  toast.show({ message: t('composer.reject.failed', { reason: errorText(err) }), tone: 'error' })
}

/** Hands a source to the intake; the 'preparing' ref shows at once. Resolves to it, or null when the intake refused. */
export async function addSource(key: string, source: AttachmentSource): Promise<AttachmentRef | null> {
  listen()
  try {
    const ref = await call('attachments', 'add', key, source)
    upsert(key, ref)
    return ref
  } catch (err) {
    failed(err)
    return null
  }
}

/** The system file picker; resolves to the refs it added (none when cancelled). */
export async function pickFiles(key: string): Promise<AttachmentRef[]> {
  listen()
  try {
    const refs = await call('attachments', 'pick', key)
    for (const ref of refs) upsert(key, ref)
    return refs
  } catch (err) {
    failed(err)
    return []
  }
}

/** Drops a ref main already let go of (the preview removed it), without asking main again. */
export function forget(key: string, id: string): void {
  const e = entry(key)
  setItems(key, e.items.filter((a) => a.id !== id))
}

export function removeAttachment(key: string, id: string): void {
  const e = entry(key)
  setItems(key, e.items.filter((a) => a.id !== id))
  void call('attachments', 'remove', key, id).catch(() => undefined)
}

export async function retryAttachment(key: string, id: string): Promise<void> {
  try {
    upsert(key, await call('attachments', 'retry', key, id))
  } catch (err) {
    failed(err)
  }
}

const REJECTION_KEYS: Record<FileRejection, () => string> = {
  'too-large': () => t('composer.reject.tooLarge'),
  'too-many': () => t('composer.reject.tooMany', { count: ATTACHMENT_LIMITS.perMessage }),
  folder: () => t('composer.reject.folder'),
}

export function addRejected(key: string, name: string, reason: string): void {
  const e = entry(key)
  e.rejected = [...e.rejected, { id: `local-${++localIds}`, name, reason }].slice(-6)
  publish(e)
}

export function dismissRejected(key: string, id: string): void {
  const e = entry(key)
  e.rejected = e.rejected.filter((r) => r.id !== id)
  publish(e)
}

/** Reads a file as base64 for the intake's `file` source. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? '')
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(file)
  })
}

export interface DroppedFile {
  file: File
  /** A folder dragged in from Finder (from the drop's entry). */
  directory?: boolean
  /** A name for files without one (a pasted image). */
  name?: string
}

/** Dropped, pasted or dragged files: too big, too many or folders are turned away here, with their reason. */
export async function addFiles(key: string, files: readonly DroppedFile[], extra = 0): Promise<void> {
  const e = entry(key)
  const facts = files.map((f) => ({ name: f.name ?? f.file.name, size: f.file.size, directory: f.directory }))
  const plan = preflightFiles(facts, e.items.length + extra)
  for (const r of plan.reject) addRejected(key, facts[r.index]?.name ?? '', REJECTION_KEYS[r.reason]())
  for (const index of plan.accept) {
    const f = files[index]
    if (!f) continue
    const name = (f.name ?? f.file.name) || t('composer.paste.imageName')
    try {
      const base64 = await readBase64(f.file)
      await addSource(key, { type: 'file', name: name.slice(0, 255), base64 })
    } catch {
      addRejected(key, name, t('composer.reject.unreadable'))
    }
  }
}

/** What a send carries: every shown ref, which hides until main moves it onto the message. */
export function takeForSend(key: string): { attachments: RefAttachment[]; ids: string[] } {
  const e = entry(key)
  const shown = e.view.items
  for (const a of shown) {
    e.sent.add(a.id)
    // Clearing the field after a send must not read as typing the tokens away.
    e.tokens.delete(a.id)
  }
  e.rejected = []
  publish(e)
  return { attachments: shown.map((a) => ({ kind: 'ref', id: a.id })), ids: shown.map((a) => a.id) }
}

/** A send failed: its chips come back. */
export function restoreAfterSend(key: string, ids: readonly string[]): void {
  const e = entry(key)
  for (const id of ids) e.sent.delete(id)
  publish(e)
}

export function setToken(key: string, id: string, token: string): void {
  entry(key).tokens.set(id, token)
}

export function tokensOf(key: string): ReadonlyMap<string, string> {
  return entry(key).tokens
}

/** The inline editor of a sent message takes (or gives back) refs it added through the draft. */
export function claim(key: string, ids: readonly string[], on: boolean): void {
  const e = entry(key)
  for (const id of ids) {
    if (on) e.claimed.add(id)
    else e.claimed.delete(id)
  }
  publish(e)
}

/** Refs in the draft, claimed or not (the editor reads its own through this). */
export function allRefs(key: string): readonly AttachmentRef[] {
  load(key)
  return entry(key).items
}
