/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatServices, ChatsServiceAdditions } from '@shared/services/chat'
import { AgentControl } from './agentControl'
import type { AppContext, WindowContext } from './features/types'
import { registerPageMenuSection } from './pageMenu'
import { SelectionChips } from './selectionChip'
import type { Tab } from './tabs'

// The at-work wiring inside the chat feature: the agent at work (OV-21,
// OV-22) and the selection chip (OV-20). features/chat.ts calls these four
// hooks; everything else lives in agentControl.ts and selectionChip.ts.

export interface AtWork {
  agent: ChatServices['agent']
  chats: Pick<ChatsServiceAdditions, 'quote' | 'askAbout'>
  tab(tab: Tab): () => void
  dispose(): void
}

export function createAtWork(app: AppContext): AtWork {
  const windowOf = (tabId: string): WindowContext | undefined => {
    const id = app.tabsRegistry.windowOf(tabId)
    return id === undefined ? undefined : app.windows.get(id)
  }
  const control = new AgentControl({
    agent: app.agent,
    tab: (tabId) => app.tabsRegistry.get(tabId),
    tabByWebContents: (id) => app.tabsRegistry.byWebContents(id),
    windowOf,
    broadcast: app.broadcast,
  })
  control.start()

  const selection = new SelectionChips({
    tabByWebContents: (id) => app.tabsRegistry.byWebContents(id),
    windowOf,
    controlled: (tabId) => control.controls(tabId),
    companionName: () => app.agent.companionLook(null).name,
    searchEngine: () => app.settings.get().searchEngine,
    startChat: (text) => app.agent.start(text),
    platform: process.platform,
  })
  selection.start()
  const offMenu = registerPageMenuSection(selection.pageMenu())
  // ⌘J with text selected asks about it (OV-20's hint); without a selection it toggles the panel as before.
  const offIntercept = app.commands.intercept('toggle-panel', {
    when: (win) => {
      const tab = win?.tabs.active()
      return Boolean(tab && selection.held(tab.id) && !control.controls(tab.id))
    },
    run: (win) => {
      selection.quoteActive(win)
    },
  })

  return {
    agent: control.services(),
    chats: {
      quote: (input) => selection.quote(app.windows.focused(), input),
      askAbout: (url) => selection.askAbout(app.windows.focused(), url),
    },
    tab: (tab) => {
      const unwatch = control.watchTab(tab)
      return () => {
        unwatch()
        selection.forget(tab.id)
      }
    },
    dispose: () => {
      offIntercept()
      offMenu()
      selection.dispose()
      control.dispose()
    },
  }
}
