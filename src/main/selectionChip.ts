/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clipboard, ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { PAGE, PAGE_LINK_HREF_MAX, PAGE_SELECTION_LINKS_MAX, PAGE_SELECTION_TEXT_MAX } from '@shared/ipc'
import type { SelectionChipAction } from '@shared/overlay/chat'
import { normalizeQuote, quoteBlock, quotePreview } from '@shared/quote'
import type { QuoteInput } from '@shared/services/chat'
import { formatKeys, shortcutById } from '@shared/shortcuts'
import { searchUrl } from '@shared/url'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'
import type { PageMenuSection } from './pageMenu'
import type { Tab } from './tabs'

// The selection chip (OV-20). The page preload reports the
// selection; main shows the chip beside it on the tab (never on a tab the
// agent holds) and runs its actions: Ask quotes the selection into the
// panel's composer, Explain sends a ready request, Copy and Search do what
// they say. ⌘J with a selection and the page menu's Ask quote it too.

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()
const selectionMessage = z.union([
  z.object({ cleared: z.literal(true) }).strict(),
  z
    .object({
      text: z.string().min(1).max(PAGE_SELECTION_TEXT_MAX),
      rect,
      links: z.array(z.string().max(PAGE_LINK_HREF_MAX)).max(PAGE_SELECTION_LINKS_MAX),
      url: z.string().max(PAGE_LINK_HREF_MAX),
    })
    .strict(),
])

/** A selection the person made, kept while it lasts, for ⌘J. */
interface Held {
  quote: QuoteInput
  at: number
}

export interface SelectionDeps {
  tabByWebContents(webContentsId: number): Tab | undefined
  windowOf(tabId: string): WindowContext | undefined
  /** The agent holds this tab: no chip there. */
  controlled(tabId: string): boolean
  companionName(): string
  searchEngine(): string
  /** Starts a chat with a ready request; returns its id. */
  startChat(text: string): string
  platform: string
}

export class SelectionChips {
  readonly #deps: SelectionDeps
  readonly #held = new Map<string, Held>()
  readonly #listener = (event: IpcMainEvent, raw: unknown): void => this.#onMessage(event, raw)

  constructor(deps: SelectionDeps) {
    this.#deps = deps
  }

  start(): void {
    ipcMain.on(PAGE.selection, this.#listener)
  }

  dispose(): void {
    ipcMain.off(PAGE.selection, this.#listener)
    this.#held.clear()
  }

  /** The live selection on a tab, if any (⌘J quotes it). */
  held(tabId: string): QuoteInput | null {
    return this.#held.get(tabId)?.quote ?? null
  }

  forget(tabId: string): void {
    this.#held.delete(tabId)
  }

  /** Opens the panel with the quote in its composer (chats.quote). */
  quote(win: WindowContext | null, input: QuoteInput): void {
    win?.send({ type: 'chat-open', chatId: null, where: 'beside', quote: normalizeQuote(input) })
  }

  /** A new chat about a page, starting from its link (the link menu's Ask, chats.askAbout). */
  askAbout(win: WindowContext | null, url: string): void {
    win?.send({ type: 'chat-open', chatId: null, where: 'beside', quote: { text: '', url, links: [] } })
  }

  explain(win: WindowContext | null, input: QuoteInput): void {
    const quote = normalizeQuote(input)
    try {
      const chatId = this.#deps.startChat(mainT('atWork.selection.explainRequest', { url: quote.url, quote: quoteBlock({ ...quote, url: '' }) }))
      win?.send({ type: 'chat-open', chatId, where: 'beside' })
    } catch (err) {
      // No key, or the engine is unavailable: the quote waits in the composer, where the panel says what to do.
      log.info('selection', 'Explain could not start a chat', { error: err instanceof Error ? err.message : String(err) })
      this.quote(win, quote)
    }
  }

  run(win: WindowContext | null, tabId: string, action: SelectionChipAction, input: QuoteInput): void {
    switch (action) {
      case 'ask':
        this.quote(win, input)
        break
      case 'explain':
        this.explain(win, input)
        break
      case 'copy':
        clipboard.writeText(input.text)
        break
      case 'search': {
        const query = quotePreview(input.text, 400)
        win?.tabs.create(searchUrl(query, this.#deps.searchEngine()), { activate: true, afterId: tabId })
        break
      }
    }
    this.#close(win)
    this.forget(tabId)
  }

  /** The page menu's section (order 30): ask the companion about the selection, the link or the page. */
  pageMenu(): PageMenuSection {
    return {
      id: 'ask-companion',
      order: 30,
      build: (params, tab, win) => {
        if (this.#deps.controlled(tab.id) || tab.internalUrl) return []
        const name = this.#deps.companionName()
        const pageUrl = tab.view.webContents.getURL()
        if (!/^https?:/i.test(pageUrl)) return []
        const text = params.selectionText.trim()
        if (text && !params.isEditable) {
          const links = params.linkURL ? [params.linkURL] : []
          return [{ label: mainT('atWork.menu.askSelection', { name, text: quotePreview(text, 32) }), click: () => this.quote(win, { text, url: pageUrl, links }) }]
        }
        if (params.linkURL && /^https?:/i.test(params.linkURL)) {
          return [{ label: mainT('atWork.menu.askLink', { name }), click: () => this.askAbout(win, params.linkURL) }]
        }
        return []
      },
    }
  }

  /** ⌘J with a live selection on the active tab quotes it instead of only toggling the panel. */
  quoteActive(win: WindowContext | null): boolean {
    const tab = win?.tabs.active()
    const held = tab ? this.held(tab.id) : null
    if (!win || !tab || !held || this.#deps.controlled(tab.id)) return false
    this.quote(win, held)
    this.#close(win)
    this.forget(tab.id)
    return true
  }

  #onMessage(event: IpcMainEvent, raw: unknown): void {
    // Only a tab's main frame speaks for its selection.
    const tab = this.#deps.tabByWebContents(event.sender.id)
    if (!tab || event.senderFrame !== event.sender.mainFrame) return
    const parsed = selectionMessage.safeParse(raw)
    if (!parsed.success) return
    const win = this.#deps.windowOf(tab.id) ?? null
    const message = parsed.data
    if ('cleared' in message || this.#deps.controlled(tab.id) || tab.internalUrl) {
      this.forget(tab.id)
      this.#close(win)
      return
    }
    const quote = normalizeQuote({ text: message.text, url: message.url, links: message.links })
    if (!quote.text) return
    this.#held.set(tab.id, { quote, at: Date.now() })
    if (!win || win.tabs.activeId() !== tab.id) return
    // Page CSS px to pane px: the tab's zoom scales them.
    const zoom = tab.view.webContents.getZoomFactor() || 1
    const anchorRect = { x: message.rect.x * zoom, y: message.rect.y * zoom, width: message.rect.width * zoom, height: message.rect.height * zoom }
    const toggle = shortcutById('toggle-panel')
    const props = {
      tabId: tab.id,
      text: quote.text,
      url: quote.url,
      links: quote.links,
      companionName: this.#deps.companionName(),
      shortcut: toggle ? formatKeys(toggle, this.#deps.platform).join('') : '',
    }
    this.#close(win)
    win.overlay
      .open('selection-chip', { kind: 'tab', tabId: tab.id, rect: anchorRect }, props, { tabId: tab.id })
      .then((result) => {
        if (!('value' in result)) return
        const action = z.enum(['ask', 'explain', 'copy', 'search']).safeParse(result.value)
        if (action.success) this.run(win, tab.id, action.data, quote)
      })
      .catch(() => {
        // The overlay host is not there yet (early in start-up); ⌘J and the page menu still work.
      })
  }

  #close(win: WindowContext | null): void {
    win?.overlay.closeAll((surface) => surface === 'selection-chip')
  }
}
