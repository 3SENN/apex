/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UI, type MenuCommand } from '@shared/ipc'
import type { ChatSummary } from '@shared/chats'
import { assert, sleep, type Chrome } from './smokeKit'
import type { TabManager } from './tabs'

// Companion presence checks on the live chrome: small faces show only the
// face (CO-18), composers drive the shared presence store (DS-69), and an
// empty chat has its companion standing in it, waiting (CO-20, DS-72).

export interface PresenceDeps {
  chrome: Chrome
  tabs: TabManager
}

type Check = (name: string, fn: () => Promise<string>) => Promise<void>

/** The opaque part of a face avatar's image, as fractions of its frame. */
interface FaceCoverage {
  size: number
  natural: number
  /** Opaque bounding box width and height, 0–1. */
  width: number
  height: number
  /** Share of all pixels that are opaque. */
  fill: number
  /** Share of the bottom row that is opaque: a body below the head would fill it edge to edge. */
  bottom: number
}

/** Draws each chat row's face image into a canvas and measures what it covers. */
const MEASURE_FACES = `
  const rows = [...document.querySelectorAll('.sidebar .chat-row .face-avatar')]
  const out = []
  for (const avatar of rows) {
    // A frameless floating head (CO-18): the state mark sits beside it, outside the head box.
    const head = avatar.querySelector('.face-avatar__head')
    const img = head && head.querySelector('img')
    if (!img || !img.complete || img.naturalWidth === 0) return null
    const n = img.naturalWidth
    const canvas = document.createElement('canvas')
    canvas.width = n
    canvas.height = n
    const g = canvas.getContext('2d')
    g.drawImage(img, 0, 0, n, n)
    const data = g.getImageData(0, 0, n, n).data
    let minX = n, minY = n, maxX = -1, maxY = -1, opaque = 0, bottom = 0
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (data[(y * n + x) * 4 + 3] < 32) continue
      opaque++
      if (y === n - 1) bottom++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    out.push({ size: Math.round(head.getBoundingClientRect().width), natural: n, width: (maxX - minX + 1) / n, height: (maxY - minY + 1) / n, fill: opaque / (n * n), bottom: bottom / n })
  }
  return out.length > 0 && out
`

export async function runPresenceChecks({ chrome, tabs }: PresenceDeps, check: Check): Promise<void> {
  const command = (c: MenuCommand): void => chrome.ui.send(UI.command, c)

  await check('small chat faces show only the face, 20 px (CO-18)', async () => {
    const faces = await chrome.until<FaceCoverage[]>(MEASURE_FACES, 15_000, 'the chat rows’ face images')
    for (const f of faces) {
      assert(f.size === 20, `a chat row avatar is ${f.size} px, not 20`)
      // The head, hair, ears and hat fill the frame. A full figure would be a narrow column
      // (the card's is 130 × 233 px, nearly twice as tall as wide); a head is about as wide as tall.
      // A narrow head with tall hair sits near 60–70% wide; the aspect check below catches a body.
      assert(f.width >= 0.6 && f.height >= 0.75, `the face covers only ${Math.round(f.width * 100)}% × ${Math.round(f.height * 100)}% of its frame`)
      assert(f.height / f.width <= 1.4, `the opaque shape is ${(f.height / f.width).toFixed(2)}× as tall as wide: a body, not a face`)
      assert(f.fill >= 0.38, `the face fills only ${Math.round(f.fill * 100)}% of its frame`)
      // No body or ground shadow along the bottom edge.
      assert(f.bottom < 0.9, `the bottom edge is ${Math.round(f.bottom * 100)}% opaque (a body?)`)
    }
    const f = faces[0]!
    return `${faces.length} faces at 20 px; the first covers ${Math.round(f.width * 100)}% × ${Math.round(f.height * 100)}% (${Math.round(f.fill * 100)}% filled)`
  })

  // One empty chat, opened as a page in its own tab, for the next two checks.
  const draft = await chrome.invoke<ChatSummary>('chats', 'create', {})
  const tab = tabs.create(`apex://chat/${draft.id}`)
  const standing = `document.querySelector('.chat-view--page.chat-view--empty .chat-empty__companion')`

  await check('an empty chat page has its companion standing, waiting (CO-20)', async () => {
    // It greets once, in a speech bubble beside the figure, as the chat opens.
    const greeting = await chrome.until<string>(`return ${standing}?.querySelector('.chat-empty__greeting')?.textContent?.trim() || null`, 8000, 'the greeting bubble')
    const seen = await chrome.until<{ size: number; live: boolean; floor: boolean; composer: boolean; top: number }>(
      `const box = ${standing}
       if (!box) return null
       const live = Boolean(box.querySelector('.companion__live[data-ready]'))
       if (!live) return null
       return {
         size: Math.round(box.getBoundingClientRect().height),
         live,
         floor: Boolean(box.querySelector('.companion__floor')),
         composer: Boolean(document.querySelector('.chat-view--page .chat-composer__field')),
         // Where the composer's top sits, as a share of the chat view's height (DS-107: 40%).
         top: (() => {
           const view = box.closest('.chat-view').getBoundingClientRect()
           const field = document.querySelector('.chat-view--page.chat-view--empty .chat-composer__box').getBoundingClientRect()
           return (field.top - view.top) / view.height
         })(),
       }`,
      20_000,
      'the waiting companion to go live on the empty chat page',
    )
    // DS-72: up to about 200 px on the page, sized to the room.
    assert(seen.size >= 150 && seen.size <= 200, `the page figure is ${seen.size} px`)
    assert(seen.floor, 'no floor under the figure')
    assert(seen.composer, 'no composer')
    assert(seen.top >= 0.36 && seen.top <= 0.48, `the composer's top is at ${Math.round(seen.top * 100)}% of the height, not about 40%`)
    return `${seen.size} px live figure on its floor, “${greeting}”, composer top at ${Math.round(seen.top * 100)}%`
  })

  await check('typing makes the waiting companion listen while text exists (DS-69)', async () => {
    const mood = (): Promise<string | null> =>
      chrome.js<string | null>(`const el = ${standing}?.querySelector('.companion'); return el ? ([...el.classList].find((c) => /^companion--(idle|listening|thinking|working|talking|approval|happy|sad|sleeping)$/.test(c)) ?? null) : null`)
    const before = await mood()
    assert(before && before !== 'companion--listening', `before typing it is ${before}`)
    await chrome.type('.chat-view--page.chat-view--empty .chat-composer__field', 'What should I pack')
    await chrome.until(`return ${standing}?.querySelector('.companion--listening')`, 3000, 'the companion to listen')
    // Listening holds while the draft is there, not just while keys are pressed.
    await sleep(2200)
    const held = await mood()
    assert(held === 'companion--listening', `two seconds after the last key it is ${held}`)
    await chrome.type('.chat-view--page.chat-view--empty .chat-composer__field', '')
    await chrome.until(`return ${standing}?.querySelector('.companion:not(.companion--listening)')`, 3000, 'the companion to stop listening once the draft is cleared')
    return `${before} → listening (held 2.2 s) → ${await mood()}`
  })

  tabs.close(tab.id)

  await check('an empty chat in the panel has its companion standing, smaller (CO-20)', async () => {
    command('new-chat')
    const seen = await chrome.until<{ size: number; live: boolean }>(
      `const box = document.querySelector('.chat-view--panel.chat-view--empty .chat-empty__companion')
       if (!box || !box.querySelector('.companion__live[data-ready]')) return null
       return { size: Math.round(box.getBoundingClientRect().height), live: true }`,
      20_000,
      'the waiting companion in the panel',
    )
    // DS-72: about 140 px in the panel.
    assert(seen.size >= 104 && seen.size <= 140, `the panel figure is ${seen.size} px`)
    command('toggle-agent')
    await chrome.until(`return !document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel')`, 3000, 'the panel to close')
    return `${seen.size} px live figure in the panel`
  })
}
