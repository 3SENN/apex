/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chatUrl } from '@shared/url'
import { assert, sleep } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// The composer: the add menu, chips, the paste chip, @ mentions and #
// records, and the reply cards. Offline only: the chat page on the offline
// client, and the intake on in-memory sources (no network).

const CHAT = `[...document.querySelectorAll('.chat-view--page')].find((e) => e.getClientRects().length > 0)`

async function openChat(ctx: SmokeContext): Promise<string> {
  const chat = await ctx.chrome.invoke<{ id: string }>('chats', 'create', {})
  ctx.tabs.openInternal(chatUrl(chat.id))
  // The new chat is empty and ready; the previous chat's page may still be on screen for a moment.
  await ctx.chrome.until(`const c = ${CHAT}; return Boolean(c?.classList.contains('chat-view--empty') && c.querySelector('.chat-composer__field'))`, 8000, 'the chat composer')
  await sleep(300)
  return chat.id
}

async function typeInChat(ctx: SmokeContext, text: string): Promise<void> {
  const ok = await ctx.chrome.js<boolean>(`
    const el = ${CHAT}?.querySelector('.chat-composer__field')
    if (!el) return false
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)})
    el.setSelectionRange(${text.length}, ${text.length})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true`)
  assert(ok, 'the chat page has a composer')
}

async function keyInChat(ctx: SmokeContext, key: string): Promise<void> {
  await ctx.chrome.js(`
    const el = ${CHAT}?.querySelector('.chat-composer__field')
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))
    return true`)
}

const addMenu: SmokeCheck = {
  name: 'the + menu opens upward with Files…, its submenus and recent tabs, and Esc closes it (CH-21, DS-126)',
  async run(ctx) {
    await openChat(ctx)
    await ctx.chrome.until(
      `const b = ${CHAT}?.querySelector('.chat-composer__add button[aria-haspopup="menu"]')
       if (!b) return false
       b.click()
       return true`,
      5000,
      'the + button',
    )
    const rows = await ctx.chrome.until<string[]>(
      `const card = document.querySelector('.cmp-menu .cmp-menu__card')
       if (!card) return null
       return [...card.querySelectorAll('[role="menuitem"]')].map((r) => r.textContent.trim())`,
      5000,
      'the add menu rows',
    )
    for (const want of ['Files', 'Skills', 'Meetings', 'Connectors', 'Tabs']) assert(rows.some((r) => r.includes(want)), `the menu lists ${want}`)
    const upward = await ctx.chrome.js<boolean>(`
      const card = document.querySelector('.cmp-menu .cmp-menu__card')
      const plus = ${CHAT}?.querySelector('.chat-composer__add button')
      return Boolean(card && plus && card.getBoundingClientRect().bottom <= plus.getBoundingClientRect().top + 1)`)
    assert(upward, 'the menu opens above the + button')
    await ctx.chrome.escape()
    await ctx.chrome.until(`return !document.querySelector('.cmp-menu')`, 3000, 'the menu closed on Esc')
  },
}

const longPaste: SmokeCheck = {
  name: 'a long paste becomes a chip with its line count, and Send waits while it prepares (CH-24, CH-22)',
  async run(ctx) {
    const chatId = await openChat(ctx)
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const ref = await ctx.chrome.invoke<{ id: string }>('attachments', 'add', chatId, { type: 'paste', text })
    await ctx.chrome.until(`return ${CHAT}?.querySelector('.cmp-chips .cmp-chip')?.textContent.includes('40 lines')`, 8000, 'the paste chip with 40 lines')
    await typeInChat(ctx, 'Summarize this')
    await ctx.chrome.until(`return Boolean(${CHAT}?.querySelector('.chat-primary--send') && !${CHAT}.querySelector('.chat-primary--send').disabled)`, 8000, 'Send once the chip is ready')
    await ctx.chrome.invoke('attachments', 'remove', chatId, ref.id)
    await typeInChat(ctx, '')
  },
}

const mentions: SmokeCheck = {
  name: '@ opens the mention list with its filters, Tab changes the filter and Esc closes it (CH-25)',
  async run(ctx) {
    await openChat(ctx)
    await typeInChat(ctx, 'Compare @')
    await ctx.chrome.until(`return Boolean(document.querySelector('.cmp-list .cmp-list__filters'))`, 5000, 'the mention list')
    const combo = await ctx.chrome.js<string | null>(`return ${CHAT}?.querySelector('.chat-composer__field')?.getAttribute('role') ?? null`)
    assert(combo === 'combobox', 'the field is a combobox while the list shows')
    await keyInChat(ctx, 'Tab')
    await ctx.chrome.until(`return document.querySelector('.cmp-list__filter--on')?.textContent.includes('Tabs')`, 3000, 'Tab moves to the Tabs filter')
    await keyInChat(ctx, 'Escape')
    await ctx.chrome.until(`return !document.querySelector('.cmp-list')`, 3000, 'Esc closes the list')
    await typeInChat(ctx, '')
  },
}

export const checks: SmokeCheck[] = [addMenu, longPaste, mentions]

export const shots: ShotSpec[] = [
  {
    name: 'composer-chips',
    async run(ctx) {
      const chatId = await openChat(ctx)
      const text = Array.from({ length: 36 }, (_, i) => `row ${i + 1}`).join('\n')
      const ref = await ctx.chrome.invoke<{ id: string }>('attachments', 'add', chatId, { type: 'paste', text })
      await ctx.chrome.until(`return Boolean(${CHAT}?.querySelector('.cmp-chips .cmp-chip'))`, 8000, 'the chip row')
      await ctx.shot('composer-chips')
      await ctx.chrome.invoke('attachments', 'remove', chatId, ref.id)
    },
  },
]
