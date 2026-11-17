/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useSyncExternalStore } from 'react'
import { chatUrl } from '@shared/url'
import { t } from '@shared/i18n/core'
import { atelier, call } from '../api'
import { tabsNow, whenTabs } from './hooks'
import { createDraftSync } from './logic/drafts'
import { PAGE_SHARE, clampPageShare, heldChatOf, holdIn, parseHeld, planExpand, pruneHeld, releaseTab, serializeHeld, type HeldChats } from './logic/inTab' // DS-65

// Which surface drives a running chat. The side panel and a chat page can
// show the same chat; while it runs, only the one that last sent, approved
// or took over may act, and the others mirror it. When the driving surface
// goes away, any surface can act again.

const drivers = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

export function claimDriving(chatId: string, surfaceId: string): void {
  if (drivers.get(chatId) === surfaceId) return
  drivers.set(chatId, surfaceId)
  changed()
}

/** A surface unmounted or switched chats: it drives nothing any more. */
export function releaseSurface(surfaceId: string, chatId?: string): void {
  let any = false
  for (const [chat, surface] of [...drivers]) {
    if (surface === surfaceId && (!chatId || chat === chatId)) {
      drivers.delete(chat)
      any = true
    }
  }
  if (any) changed()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface Driving {
  /** This surface may send, stop and answer approvals. */
  driving: boolean
  /** The surface driving instead, while the chat runs. */
  elsewhere: string | null
  claim(): void
}

export function useDriving(chatId: string | null, surfaceId: string, running: boolean): Driving {
  useSyncExternalStore(subscribe, () => version)
  const driver = chatId ? (drivers.get(chatId) ?? null) : null
  const elsewhere = running && driver !== null && driver !== surfaceId ? driver : null
  const claim = useCallback(() => {
    if (chatId) claimDriving(chatId, surfaceId)
  }, [chatId, surfaceId])
  return { driving: elsewhere === null, elsewhere, claim }
}

/** A readable name for a surface id ('panel', 'page:<tabId>'). */
export function surfaceName(surfaceId: string): string {
  return surfaceId === 'panel' ? t('chat.surfaces.sidePanel') : t('chat.surfaces.chatPage')
}

// Unsent composer text per chat, so it survives switching chats, closing the
// panel and expanding into a page. Kept in memory and written
// to main after a short pause, so it also survives reloads and other windows.
const drafts = createDraftSync({
  save: (chatId, text) => call('chats', 'setDraft', chatId, text).then(() => undefined),
  load: (chatId) => call('chats', 'draft', chatId),
})
window.addEventListener('beforeunload', () => drafts.flush())

export function draftText(key: string): string {
  return drafts.get(key)
}

export function setDraftText(key: string, text: string): void {
  drafts.set(key, text)
}

/** The saved draft for a chat (from main the first time); resolves with what the composer should show. */
export function loadDraft(key: string): Promise<string> {
  return drafts.hydrate(key)
}

// DS-65: expanding the panel hands the chat over. The tab the panel sat beside
// becomes the chat page, with its own web page shown as the side pane (one
// tab, not split view), and the panel closes. The draft, the scroll position
// and the revealed words live in per-chat stores, so they carry over by
// themselves. Collapsing does the reverse: the tab shows only its page again,
// with the chat back in the panel.

const HELD_KEY = 'atelier.chatInTab.held'
const SHARE_KEY = 'atelier.chatInTab.pageShare'

function readStored(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function writeStored(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value)
  } catch {
    // Storage blocked: the hold and the width still work for this session.
  }
}

// Per window (each window has its own chrome), kept across a chrome reload.
let held: HeldChats = parseHeld(readStored(() => sessionStorage, HELD_KEY))
let pageShare = clampPageShare(Number(readStored(() => localStorage, SHARE_KEY) ?? PAGE_SHARE.default))
const heldListeners = new Set<() => void>()

function setHeld(next: HeldChats): void {
  if (next === held) return
  held = next
  writeStored(() => sessionStorage, HELD_KEY, serializeHeld(next))
  for (const listener of heldListeners) listener()
}

const subscribeHeld = (listener: () => void): (() => void) => {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

/** Which tab holds which chat beside its page, live. */
export function useHeldChats(): HeldChats {
  return useSyncExternalStore(subscribeHeld, () => held)
}

/** The chat a tab holds beside its page, or null. */
export function heldChat(tabId: string | null | undefined): string | null {
  return heldChatOf(held, tabId)
}

/** The tab shows the chat page with its web page beside it. */
export function holdChatInTab(tabId: string, chatId: string): void {
  setHeld(holdIn(held, tabId, chatId))
}

/** The tab shows only its page again. */
export function releaseChatInTab(tabId: string): void {
  setHeld(releaseTab(held, tabId))
}

/** Drops holds whose tab closed or left its website (pass every tab of the window). */
export function pruneHeldChats(tabs: ReadonlyArray<{ id: string; url: string }>): void {
  setHeld(pruneHeld(held, tabs))
}

/** The page pane's share of the tab beside a chat, saved for this person. */
export function usePageShare(): number {
  return useSyncExternalStore(subscribeHeld, () => pageShare)
}

export function savePageShare(value: number): void {
  const next = clampPageShare(value)
  if (next === pageShare) return
  pageShare = next
  writeStored(() => localStorage, SHARE_KEY, String(next))
  for (const listener of heldListeners) listener()
}

/** Shows the chat as the active tab's chat page, its web page beside it. Resolves to that tab's id. */
export async function expandToPage(chatId: string): Promise<string | null> {
  const before = tabsNow()
  const plan = planExpand(before.tabs.find((tab) => tab.id === before.activeId), Boolean(before.rail))
  if (plan.kind === 'hold') {
    holdChatInTab(plan.tabId, chatId)
    return plan.tabId
  }
  // The new tab has no page to keep: it becomes the chat page itself.
  if (plan.kind === 'navigate') {
    await atelier.nav.go(plan.tabId, chatUrl(chatId))
    return plan.tabId
  }
  await call('pages', 'open', chatUrl(chatId))
  return whenTabs((tabs) => tabs.tabs.find((tab) => tab.url === chatUrl(chatId))?.id ?? null)
}

/** Puts the chat back in the side panel beside its page. A chat page in its own tab closes that tab. */
export async function collapseToPanel(chatId: string, tabId: string, openPanel: (chatId: string) => void): Promise<void> {
  if (heldChat(tabId) === chatId) {
    releaseChatInTab(tabId)
    if (tabsNow().activeId !== tabId) await atelier.tabs.activate(tabId)
    openPanel(chatId)
    return
  }
  const snapshot = tabsNow()
  const split = snapshot.split
  const partner = split && (split.primaryId === tabId ? split.secondaryId : split.secondaryId === tabId ? split.primaryId : null)
  if (split && partner) await call('split', 'close').catch(() => undefined)
  if (partner && snapshot.tabs.some((t) => t.id === partner)) await atelier.tabs.activate(partner)
  openPanel(chatId)
  // CH-30: the panel shows the chat before its tab closes, so main doesn't treat a private chat as ending.
  await call('chats', 'setViewing', 'panel', chatId).catch(() => undefined)
  await atelier.tabs.close(tabId)
}
