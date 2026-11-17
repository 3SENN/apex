/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clipboard, type MenuItemConstructorOptions } from 'electron'
import { canPeek } from '@shared/links'
import { middleTruncate } from '@shared/domains'
import { resolveEngine, engineSearchUrl } from '@shared/searchEngines'
import type { AppContext, WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { registerPageMenuSection } from './pageMenu'
import type { Tab } from './tabs'

// The address feature's page menu sections: editing at order 5, links, images
// and search at 10, and back, forward and reload at 15 when the menu isn't
// about anything in particular. Other features add theirs at their own orders.

function openInWindow(app: AppContext, win: WindowContext, tab: Tab, url: string, kind: 'normal' | 'private'): void {
  try {
    app.windows.open(kind, { url })
  } catch (err) {
    // Without a window manager the link still opens, as a tab.
    log.info('links', 'Opening in a new window is not available yet', { error: err instanceof Error ? err.message : String(err) })
    win.tabs.create(url, { activate: false, afterId: tab.id })
  }
}

export function registerLinkMenu(app: AppContext): () => void {
  const offs = [
    registerPageMenuSection({
      id: 'address.edit',
      order: 5,
      build(params) {
        if (params.isEditable) {
          const f = params.editFlags
          return [
            { role: 'undo', enabled: f.canUndo },
            { role: 'redo', enabled: f.canRedo },
            { type: 'separator' },
            { role: 'cut', enabled: f.canCut },
            { role: 'copy', enabled: f.canCopy },
            { role: 'paste', enabled: f.canPaste },
            { role: 'pasteAndMatchStyle', enabled: f.canPaste },
            { role: 'selectAll', enabled: f.canSelectAll },
          ]
        }
        return params.selectionText ? [{ role: 'copy' }] : []
      },
    }),
    registerPageMenuSection({
      id: 'address.links',
      order: 10,
      build(params, tab, win) {
        const items: MenuItemConstructorOptions[] = []
        const link = params.linkURL
        if (link && /^(https?|file):/i.test(link)) {
          items.push(
            { label: mainT('address.menu.openLinkNewTab'), click: () => win.tabs.create(link, { activate: false, afterId: tab.id }) },
            { label: mainT('address.menu.openLinkNewWindow'), click: () => openInWindow(app, win, tab, link, 'normal') },
            { label: mainT('address.menu.openLinkPrivate'), click: () => openInWindow(app, win, tab, link, 'private') },
            { type: 'separator' },
            {
              label: mainT('address.menu.openLinkSplit'),
              click: () => {
                const partner = win.tabs.create(link, { activate: false, afterId: tab.id })
                win.tabs.openSplitWith(tab.id, partner.id)
              },
            },
            { label: mainT('address.menu.openLinkPeek'), enabled: canPeek(link) && !win.tabs.pageFullScreen(), click: () => win.peek.open(link) },
            { label: mainT('address.menu.copyLink'), click: () => clipboard.writeText(link) },
            // "Ask <companion> about this link" comes from the at-work section (chats.askAbout), so it shows once.
          )
        }
        if (params.mediaType === 'image' && /^(https?|data):/i.test(params.srcURL)) {
          if (items.length) items.push({ type: 'separator' })
          items.push(
            ...(/^https?:/i.test(params.srcURL) ? [{ label: mainT('address.menu.openImage'), click: () => win.tabs.create(params.srcURL, { activate: false, afterId: tab.id }) }] : []),
            { label: mainT('address.menu.copyImage'), click: () => tab.view.webContents.copyImageAt(params.x, params.y) },
            ...(/^https?:/i.test(params.srcURL) ? [{ label: mainT('address.menu.copyImageAddress'), click: () => clipboard.writeText(params.srcURL) }] : []),
          )
        }
        const selection = params.selectionText.replace(/\s+/g, ' ').trim()
        if (selection && !params.isEditable) {
          const settings = app.settings.get()
          const engine = resolveEngine(settings.searchEngine, settings.customSearchEngines)
          if (items.length) items.push({ type: 'separator' })
          items.push({
            label: mainT('address.menu.searchFor', { engine: engine.name, text: middleTruncate(selection, 40) }),
            click: () => win.tabs.create(engineSearchUrl(engine, selection.slice(0, 2000)), { activate: true, afterId: tab.id }),
          })
        }
        return items
      },
    }),
    registerPageMenuSection({
      id: 'address.navigation',
      order: 15,
      build(params, tab) {
        if (params.linkURL || params.selectionText || params.isEditable || params.mediaType !== 'none') return []
        const nav = tab.view.webContents.navigationHistory
        return [
          { label: mainT('address.menu.back'), enabled: nav.canGoBack(), click: () => nav.goBack() },
          { label: mainT('address.menu.forward'), enabled: nav.canGoForward(), click: () => nav.goForward() },
          { label: mainT('address.menu.reload'), click: () => tab.view.webContents.reload() },
        ]
      },
    }),
  ]
  return () => offs.forEach((off) => off())
}
