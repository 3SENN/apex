/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assert, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The chat's smoke checks and light and dark shots: the queue
// with Send now (an interrupt), the stop mark, the plain-word status, the
// details panel with the tabs used, and the composer's mode toggle. Every reply
// comes from the offline stand-in; nothing reaches the network.

const chatPage = (id: string): string => `apex://chat/${id}`

/** Opens a chat as a page and waits for its view. Returns the tab id. */
async function openChat(ctx: SmokeContext, id: string): Promise<string> {
  const tab = ctx.tabs.create(chatPage(id), { activate: true })
  await ctx.chrome.until(`return document.querySelector('.chat-view--page .chat-composer') ? true : null`, 8000, 'the chat page')
  return tab.id
}

function close(ctx: SmokeContext, tabId: string): void {
  if (ctx.tabs.find(tabId)) ctx.tabs.close(tabId)
}

async function idle(ctx: SmokeContext, id: string): Promise<void> {
  await waitFor(() => !ctx.host.isRunning(id), 10_000, 'the chat to finish')
}

const queue: SmokeCheck = {
  name: 'a message sent while working waits in the visible queue, and Send now interrupts the run',
  async run(ctx) {
    const before = ctx.client.requests
    ctx.client.hold()
    const id = ctx.host.start('Plan a picnic for Sunday')
    const tab = await openChat(ctx, id)
    try {
      await waitFor(() => ctx.client.requests > before && ctx.host.isRunning(id), 8000, 'the held run')
      assert(ctx.host.send(id, 'Compare two laptops for travel').queued, 'the second message queues')
      await ctx.chrome.until(`return document.querySelector('.chat-queue__item') ? true : null`, 5000, 'the queue above the composer')
      await ctx.chrome.until(`const s = document.querySelector('.chat-chip-header__status'); return s && s.textContent.trim() ? true : null`, 5000, 'the plain-word status in the header')
      await ctx.shot('chat-queue')
      const queued = ctx.host.view(id).queued
      assert(queued.length === 1, `one queued message, got ${queued.length}`)
      ctx.host.sendNow(id, queued[0]!.id)
      ctx.client.release()
      await idle(ctx, id)
      const log = ctx.host.view(id).log
      assert(log.some((e) => e.type === 'stopped' && e.reason === 'interrupt'), 'the run was interrupted')
      assert(log.some((e) => e.type === 'user-message' && e.text === 'Compare two laptops for travel'), 'the queued message went out')
      assert(ctx.host.view(id).queued.length === 0, 'the queue is empty')
      await ctx.chrome.until(`return document.querySelector('.chat-stopped') ? true : null`, 5000, 'the inline stop mark')
      await ctx.shot('chat-interrupted')
    } finally {
      ctx.client.release()
      close(ctx, tab)
    }
  },
}

const stop: SmokeCheck = {
  name: 'Stop marks the run stopped inline and the chat goes idle',
  async run(ctx) {
    const before = ctx.client.requests
    ctx.client.hold()
    const id = ctx.host.start('Summarize the open tabs')
    const tab = await openChat(ctx, id)
    try {
      await waitFor(() => ctx.client.requests > before && ctx.host.isRunning(id), 8000, 'the held run')
      await ctx.chrome.until(`return document.querySelector('.chat-primary--stop') ? true : null`, 5000, 'Send turned into Stop')
      ctx.host.stop(id)
      await idle(ctx, id)
      await ctx.chrome.until(`return document.querySelector('.chat-stopped--user') ? true : null`, 5000, 'the stopped mark')
      await ctx.shot('chat-stopped')
    } finally {
      ctx.client.release()
      close(ctx, tab)
    }
  },
}

const details: ShotSpec = {
  name: 'chat-details',
  async run(ctx) {
    const id = ctx.host.start('Plan a picnic for the lake')
    await idle(ctx, id)
    const tab = await openChat(ctx, id)
    try {
      await ctx.chrome.js(`document.querySelector('.chat-header [aria-label="Show details"]')?.click(); return true`)
      await ctx.chrome.until(`return document.querySelector('.chat-details') ? true : null`, 5000, 'the details panel')
      await ctx.shot('chat-details')
      await ctx.chrome.js(`document.querySelector('.chat-details [aria-label="Hide details"]')?.click(); return true`)
    } finally {
      close(ctx, tab)
    }
  },
}

const mode: ShotSpec = {
  name: 'chat-mode',
  async run(ctx) {
    const id = ctx.host.start('Plan a picnic in the park')
    await idle(ctx, id)
    const tab = await openChat(ctx, id)
    try {
      // DS-125: at rest there is no control to click; the mode is turned on from the composer chip's switch row (the service here).
      await ctx.chrome.invoke('chats', 'setActWithoutAsking', id, true)
      await ctx.chrome.until(`return document.querySelector('.chat-mode--on') ? true : null`, 5000, 'the act-without-asking badge')
      await ctx.shot('chat-mode')
      // The badge turns it off again.
      await ctx.chrome.js(`document.querySelector('.chat-mode--on')?.click(); return true`)
      await ctx.chrome.until(`return document.querySelector('.chat-mode--on') ? null : true`, 5000, 'the badge to go')
    } finally {
      close(ctx, tab)
    }
  },
}

const select: SmokeCheck = {
  name: 'chat text can be selected with the mouse: the answer and your own message',
  async run(ctx) {
    const id = ctx.host.start('Plan a picnic for the weekend')
    await idle(ctx, id)
    const tab = await openChat(ctx, id)
    try {
      await ctx.chrome.until(`return document.querySelector('.chat-msg__text') && document.querySelector('.chat-msg__bubble') ? true : null`, 8000, 'the message and the answer')
      for (const selector of ['.chat-msg__text', '.chat-msg__bubble']) {
        const box = await ctx.chrome.js<{ x: number; y: number; w: number; h: number }>(
          `const el = document.querySelector('${selector}'); el.scrollIntoView({ block: 'center' }); getSelection().removeAllRanges()
           const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`,
        )
        // A real drag across the first line: press, move with the button held, release.
        const y = Math.round(box.y + Math.min(20, box.h / 2))
        const from = Math.round(box.x + 28)
        const to = Math.round(box.x + Math.min(box.w - 12, 240))
        ctx.chrome.ui.sendInputEvent({ type: 'mouseDown', x: from, y, button: 'left', clickCount: 1 })
        for (let x = from; x <= to; x += 20) ctx.chrome.ui.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftbuttondown'] })
        ctx.chrome.ui.sendInputEvent({ type: 'mouseUp', x: to, y, button: 'left', clickCount: 1 })
        await new Promise((r) => setTimeout(r, 150))
        const picked = await ctx.chrome.js<string>(`return getSelection().toString()`)
        assert(picked.trim().length >= 3, `dragging over ${selector} selected nothing`)
      }
      await ctx.chrome.js(`getSelection().removeAllRanges(); return true`)
    } finally {
      close(ctx, tab)
    }
  },
}

export const checks: SmokeCheck[] = [queue, stop, select]
export const shots: ShotSpec[] = [details, mode]
