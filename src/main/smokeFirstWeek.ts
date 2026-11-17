/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FirstWeekView } from '@shared/firstWeek'
import type { AgentHost } from './agent/host'
import type { ChatStore } from './chats'
import { assert, captureWindow, sleep, waitFor, type Chrome } from './smokeKit'
import type { TabManager } from './tabs'

// Smoke checks for the getting-started page (apex://first-week): it opens
// once when setup finishes, shows the plan with show more and less, and a
// starter card starts a chat that the offline stand-in answers. With a
// screenshot folder it also saves first-week.png (and the expanded plan and
// a guide) in the current theme.

export interface FirstWeekSmokeDeps {
  chrome: Chrome
  tabs: TabManager
  host: AgentHost
  chats: ChatStore
  /** APEX_SMOKE_SHOTS, when set. */
  dir: string | null
}

type Check = (name: string, fn: () => Promise<string>) => Promise<void>

const firstWeekTabs = (tabs: TabManager): string[] => tabs.all().filter((t) => t.internalUrl?.startsWith('apex://first-week')).map((t) => t.id)
const cards = `document.querySelectorAll('.fw-plan__grid .fw-card').length`
const pillText = `(document.querySelector('.fw-pill')?.textContent || '').trim()`

export async function runFirstWeekChecks(deps: FirstWeekSmokeDeps, check: Check): Promise<void> {
  const { chrome, tabs, host, chats, dir } = deps
  const ui = chrome.ui
  const shoot = async (name: string, wait = 600): Promise<void> => {
    if (!dir) return
    await sleep(wait)
    writeFileSync(join(dir, `${name}.png`), (await captureWindow(ui, tabs)).toPNG())
  }

  await check('finishing setup opens the getting-started page once', async () => {
    await chrome.invoke('onboarding', 'complete')
    await waitFor(() => firstWeekTabs(tabs).length === 1 && tabs.activeId() === firstWeekTabs(tabs)[0], 5000, 'the getting-started tab').catch((err: unknown) => {
      const seen = tabs.all().map((t) => `${t.id === tabs.activeId() ? '*' : ''}${t.internalUrl ?? 'web'}`).join(', ')
      throw new Error(`${err instanceof Error ? err.message : String(err)} Tabs: ${seen}`)
    })
    await chrome.invoke('onboarding', 'complete')
    await sleep(200)
    assert(firstWeekTabs(tabs).length === 1, `${firstWeekTabs(tabs).length} getting-started tabs after finishing setup twice`)
    const view = await chrome.invoke<FirstWeekView>('firstWeek', 'view')
    assert(view.status === 'ready' && view.startersSource === 'curated', `status ${view.status}, starters ${view.startersSource}`)
    return `${view.total} items, curated starters (no API call in smoke)`
  })

  await check('the getting-started page shows the hero, six cards and the guides', async () => {
    const seen = await chrome.until<{ cards: number; guides: number; pill: string }>(
      `const n = ${cards}
       const guides = document.querySelectorAll('.fw-tut').length
       const hero = document.querySelector('.fw-hero h1') && document.querySelector('.fw-hero__figure')
       return n === 6 && guides >= 4 && hero && { cards: n, guides, pill: ${pillText} }`,
      8000,
      'the plan to draw',
    )
    assert(/^Show \d+ more$/.test(seen.pill), `pill reads "${seen.pill}"`)
    return `${seen.cards} cards, ${seen.guides} guides, "${seen.pill}"`
  })
  await shoot('first-week', 2200)

  await check('show more reveals every card and show less folds them back', async () => {
    const total = (await chrome.invoke<FirstWeekView>('firstWeek', 'view')).items.length
    await chrome.click(/^Show \d+ more$/, `document.querySelector('.fw-plan')`)
    await chrome.until(`return ${cards} === ${total} && ${pillText} === 'Show less'`, 3000, 'every card')
    await shoot('first-week-more', 700)
    await chrome.click(/^Show less$/, `document.querySelector('.fw-plan')`)
    await chrome.until(`return ${cards} === 6 && /^Show \\d+ more$/.test(${pillText})`, 3000, 'six cards again')
    return `${total} cards expanded, 6 folded`
  })

  await check('snooze, hide and show round-trip through the service', async () => {
    const snoozed = await chrome.invoke<FirstWeekView>('firstWeek', 'snooze')
    assert(snoozed.snoozedUntil && new Date(snoozed.snoozedUntil).getHours() === 9, 'snooze did not land on 9:00')
    await chrome.until(`return document.querySelector('.fw-rest') && ${cards} === 0`, 3000, 'the snoozed panel')
    await chrome.invoke('firstWeek', 'unsnooze')
    const hidden = await chrome.invoke<FirstWeekView>('firstWeek', 'hide', 'not-now')
    assert(hidden.status === 'off' && hidden.hiddenReason === 'not-now', `hide gave ${hidden.status}`)
    const shown = await chrome.invoke<FirstWeekView>('firstWeek', 'show')
    assert(shown.status === 'ready', 'show did not bring it back')
    await chrome.until(`return ${cards} === 6`, 3000, 'the plan again')
    return 'snoozed to 9:00, hidden with a reason, shown again'
  })

  await check('a starter card starts a chat that gets answered', async () => {
    const before = new Set(chats.list().map((c) => c.id))
    const prompt = (await chrome.invoke<FirstWeekView>('firstWeek', 'view')).items.find((i) => i.kind === 'starter')
    assert(prompt && prompt.action.kind === 'chat', 'no starter card')
    const text = prompt.action.prompt
    const clicked = await chrome.js<boolean>(`
      const card = [...document.querySelectorAll('.fw-card__main')].find((b) => b.textContent.includes(${JSON.stringify(prompt.title)}))
      if (!card) return false
      card.click()
      return true`)
    assert(clicked, 'the starter card was not on screen')
    let chatId = ''
    await waitFor(() => {
      chatId = chats.list().find((c) => !before.has(c.id))?.id ?? ''
      return Boolean(chatId)
    }, 8000, 'the new chat')
    await waitFor(() => tabs.active()?.internalUrl === `apex://chat/${chatId}`, 5000, 'the chat page to open')
    await waitFor(() => {
      const log = host.view(chatId).log as Array<{ type: string; text?: string }>
      return log.some((e) => e.type === 'text-delta' && (e.text ?? '').includes('offline stand-in'))
    }, 10_000, 'the offline reply')
    const log = host.view(chatId).log as Array<{ type: string; text?: string }>
    assert(log.find((e) => e.type === 'user-message')?.text === text, 'the chat did not start with the starter prompt')
    const view = await chrome.invoke<FirstWeekView>('firstWeek', 'view')
    assert(view.items.find((i) => i.id === prompt.id)?.done, 'the starter was not ticked off')
    return `“${prompt.title}” answered and ticked off`
  })

  if (dir) {
    await check('screenshot of a guide', async () => {
      const tab = tabs.create('apex://first-week/meet-your-companion')
      await chrome.until(`return document.querySelector('.fw-guide .fw-doc h1')`, 5000, 'the guide')
      await shoot('first-week-guide', 900)
      tabs.close(tab.id)
      return 'first-week.png, first-week-more.png, first-week-guide.png'
    })
  }
}
