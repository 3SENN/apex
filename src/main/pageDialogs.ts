/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { PAGE, type PageDialogMessage, type PageDialogReply } from '@shared/ipc'
import { PAGE_LEAVE_INTENT, type PageLeaveIntentMessage } from '@shared/pageDialogs'
import { dialogs } from './dialogs'
import type { AppContext, WindowContext } from './features/types'
import { record, type LeaveState } from './leaveIntent'
import { log } from './log'
import { agentNote, cancelReply, decide, documentChanged, newTabDialogState, pageDialogSpec, replyFor, PAGE_DIALOG_TIMEOUT_MS, type TabDialogState } from './pageDialogPolicy'
import type { Tab } from './tabs'

// The page dialog broker (OV-08). The page preload replaces alert,
// confirm and prompt in the page's main world with functions that ask main
// over sendSync; the page stays blocked until main sets returnValue, which
// it does when you answer the styled dialog, or with a cancel when the page
// navigates, closes, crashes, or nobody answers in time.

const messageSchema = z
  .object({
    kind: z.enum(['alert', 'confirm', 'prompt']),
    message: z.string().max(10_000),
    defaultValue: z.string().max(10_000).optional(),
  })
  .strict()

const intentSchema = z.object({ url: z.string().min(1).max(8192), form: z.boolean() }).strict()

interface TabEntry {
  tab: Tab
  win: WindowContext
  dialogs: TabDialogState
  leave: LeaveState
  /** Pending page dialogs: their handle id and how to answer the page. */
  waiting: Map<string, (reply: PageDialogReply) => void>
}

const tabsByWc = new Map<number, TabEntry>()

/** The leave-page state of a tab's webContents (leavePage.ts records Atelier's own intents here). */
export function leaveStateOf(wc: WebContents): LeaveState | null {
  return tabsByWc.get(wc.id)?.leave ?? null
}

function frameOrigin(event: IpcMainEvent): string {
  try {
    return event.senderFrame?.origin ?? 'null'
  } catch {
    return 'null'
  }
}

/** Installs the IPC handlers once (app start). */
/** Smoke diagnostics: the tabs whose page is blocked on a dialog right now, with their renderer process. */
export function pendingPageDialogs(): Array<{ url: string; pid: number; count: number }> {
  return [...tabsByWc.values()]
    .filter((e) => e.waiting.size > 0 && !e.tab.view.webContents.isDestroyed())
    .map((e) => ({ url: e.tab.view.webContents.getURL(), pid: e.tab.view.webContents.getOSProcessId(), count: e.waiting.size }))
}

export function installPageDialogs(ctx: AppContext): void {
  ipcMain.on(PAGE.dialog, (event: IpcMainEvent, raw: unknown) => {
    const entry = tabsByWc.get(event.sender.id)
    const parsed = messageSchema.safeParse(raw)
    // Something must always answer, or the page stays frozen.
    if (!entry || !parsed.success) {
      event.returnValue = parsed.success ? cancelReply(parsed.data.kind) : null
      return
    }
    ask(ctx, entry, parsed.data, frameOrigin(event), (reply) => {
      if (!event.sender.isDestroyed()) event.returnValue = reply
    })
  })
  // The page reports its own navigations before beforeunload runs, so Leave can redo them.
  ipcMain.on(PAGE_LEAVE_INTENT, (event: IpcMainEvent, raw: unknown) => {
    event.returnValue = null
    const entry = tabsByWc.get(event.sender.id)
    const parsed = intentSchema.safeParse(raw)
    if (!entry || !parsed.success || !/^https?:/i.test(parsed.data.url)) return
    const msg: PageLeaveIntentMessage = parsed.data
    record(entry.leave, { kind: 'page', url: msg.url, form: msg.form, at: Date.now() })
  })
}

function ask(ctx: AppContext, entry: TabEntry, msg: PageDialogMessage, origin: string, answer: (reply: PageDialogReply) => void): void {
  const decision = decide(entry.dialogs, origin, Date.now())
  if (decision.kind === 'block') {
    answer(cancelReply(msg.kind))
    return
  }
  if (entry.tab.agentControlled) {
    try {
      ctx.agent.noteForNextResult(entry.tab.id, agentNote(msg, origin))
    } catch (err) {
      log.debug('dialogs', 'The agent could not be told about a page dialog', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const spec = pageDialogSpec(msg, origin, decision.offerStop)
  const handle = dialogs.open(entry.win, spec, { tabId: entry.tab.id, timeoutMs: PAGE_DIALOG_TIMEOUT_MS }, { origin })
  let answered = false
  const once = (reply: PageDialogReply): void => {
    if (answered) return
    answered = true
    entry.waiting.delete(handle.id)
    answer(reply)
  }
  entry.waiting.set(handle.id, once)
  handle.result.then(
    (result) => {
      if (result.checked) entry.dialogs.blocked.add(origin)
      once(replyFor(msg.kind, result.button, result.inputs.value))
    },
    () => once(cancelReply(msg.kind)),
  )
}

/** Per tab: track it, and cancel its dialogs when the page goes away. */
export function watchTab(tab: Tab, win: WindowContext): () => void {
  const wc = tab.view.webContents
  const entry: TabEntry = { tab, win, dialogs: newTabDialogState(), leave: { intent: null, skipUntil: 0 }, waiting: new Map() }
  tabsByWc.set(wc.id, entry)
  const cancelAll = (): void => {
    // Answer first: a cancelled dialog's page must not stay blocked while main navigates it.
    for (const [, reply] of entry.waiting) reply(null)
    dialogs.cancelTab(win, tab.id)
  }
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (!details.isMainFrame || details.isSameDocument) return
    cancelAll()
    documentChanged(entry.dialogs)
  }
  const onGone = (): void => cancelAll()
  wc.on('did-start-navigation', onNavigation)
  wc.on('render-process-gone', onGone)
  wc.once('destroyed', onGone)
  return () => {
    cancelAll()
    tabsByWc.delete(wc.id)
    if (wc.isDestroyed()) return
    wc.off('did-start-navigation', onNavigation)
    wc.off('render-process-gone', onGone)
  }
}
