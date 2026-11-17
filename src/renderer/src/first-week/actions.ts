/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FirstWeekItem, FirstWeekView } from '@shared/firstWeek'
import { chatUrl, companionUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { toast } from '../ui'
import { t } from '@shared/i18n/core'

// What a card does when you open it. Starters start a chat with the active
// companion and open it beside this page; the rest open the page where the
// step happens, and their signal ticks them off.

export async function runItem(item: FirstWeekItem, companionId: string | null, update: (view: FirstWeekView) => void): Promise<void> {
  try {
    switch (item.action.kind) {
      case 'chat': {
        const chatId = await apex.agent.start(item.action.prompt, companionId ? { companionId } : undefined)
        update(await call('firstWeek', 'setDone', item.id, true))
        await call('pages', 'open', chatUrl(chatId))
        return
      }
      case 'page':
        await call('pages', 'open', item.action.url)
        return
      case 'companion':
        if (companionId) await call('pages', 'open', companionUrl(companionId, 'general'))
        return
      case 'web-search':
        // NT-01: a new tab whose composer searches the web; the first search ticks the item.
        await apex.settings.set({ newTabMode: 'web' })
        await apex.tabs.create()
        return
      case 'default-browser':
        update(await call('firstWeek', 'makeDefaultBrowser'))
        toast.show({ message: t('firstRun.weekActions.ifMacosAsksChoose'), tone: 'info' })
        return
    }
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

/** Dismisses a card with an undo. */
export async function dismissItem(item: FirstWeekItem, update: (view: FirstWeekView) => void): Promise<void> {
  try {
    update(await call('firstWeek', 'dismiss', item.id))
    toast.show({
      message: t('firstRun.weekActions.putAside', { title: item.title }),
      undo: () => void call('firstWeek', 'restore', item.id).then(update, (err: unknown) => toast.show({ message: errorText(err), tone: 'error' })),
    })
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}
