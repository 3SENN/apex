/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Menu } from 'electron'
import type { MainMenuModel } from '@shared/menuBase'
import { flattenMenu } from '@shared/menuBase'
import { appMenu, menuSources } from '../menu'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The menus' smoke checks and shots: the native menu bar carries every top
// menu with live accelerators, the main-menu popover opens from the sidebar
// footer with its SH-54 sections, Escape closes the innermost level first,
// and light and dark shots of the root card and each side card.

const MAIN_SUBMENUS = ['tabs-menu', 'bookmarks-menu', 'history-menu', 'appearance', 'save-share-menu', 'more-tools-menu', 'help-menu'] as const

/** Where the open main menu draws: the interactive overlay tier, or the chrome before the host is up. */
function menuDoc(ctx: SmokeContext): Chrome {
  const wc = menuSources.windows?.focused()?.overlay.tierWebContents('interactive')
  return wc && !wc.isDestroyed() ? new Chrome(wc) : ctx.chrome
}

async function openMainMenu(ctx: SmokeContext): Promise<Chrome> {
  const opened = await ctx.chrome.js<boolean>(`const b = document.querySelector('.profile-row'); if (b) b.click(); return Boolean(b)`)
  assert(opened, 'no sidebar footer profile row')
  let doc: Chrome = ctx.chrome
  await waitFor(
    async () => {
      for (const candidate of [menuDoc(ctx), ctx.chrome]) {
        if (await candidate.js<boolean>(`return Boolean(document.querySelector('.mm [data-item="tabs-menu"]'))`).catch(() => false)) {
          doc = candidate
          return true
        }
      }
      return false
    },
    8000,
    'the main menu',
  )
  return doc
}

/** Escape on the innermost open level, the way the keyboard reaches it. */
async function escape(doc: Chrome): Promise<void> {
  await doc.js(`
    const cards = [...document.querySelectorAll('[data-kit-card]')]
    const deepest = cards.sort((a, b) => Number(b.dataset.level || 0) - Number(a.dataset.level || 0))[0]
    const el = (deepest && deepest.querySelector('[role="menu"], [role="group"], button')) || document.activeElement || document.body
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true`)
}

async function closeMainMenu(ctx: SmokeContext, doc: Chrome): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const open = await doc.js<boolean>(`return Boolean(document.querySelector('.mm'))`).catch(() => false)
    if (!open) break
    await escape(doc)
    await sleep(150)
  }
  // Let its exit finish: a click on the profile row while it is still leaving would only close it again.
  await doc.until(`return !document.querySelector('.mm')`, 2000, 'the main menu to leave').catch(() => undefined)
  await sleep(250)
}

const nativeBar: SmokeCheck = {
  name: 'menus-native-bar',
  async run() {
    const menu = Menu.getApplicationMenu()
    assert(menu, 'no application menu')
    const labels = menu.items.map((i) => i.label)
    for (const want of ['File', 'Edit', 'View', 'Tabs', 'Bookmarks', 'History', 'Window', 'Help']) assert(labels.includes(want), `the menu bar has no ${want} menu (${labels.join(', ')})`)
    const newTab = menu.getMenuItemById('new-tab')
    assert(newTab?.accelerator, 'New Tab has no accelerator')
    for (const id of ['copy-url', 'find-next', 'reload', 'open-history']) assert(menu.getMenuItemById(id), `the menu bar has no ${id} item`)
    // No account, sign-out or plan items anywhere.
    const all = JSON.stringify(menu.items.map((i) => i.label)) + JSON.stringify(flattenMenu(appMenu()?.mainMenu(null).items ?? []).map((i) => i.label))
    assert(!/sign out|log out|upgrade|subscription|credits/i.test(all), 'a menu shows account or plan items')
  },
}

const mainModel: SmokeCheck = {
  name: 'menus-main-model',
  async run(ctx) {
    const model = await ctx.chrome.invoke<MainMenuModel>('menus', 'mainMenu')
    const ids = new Set(flattenMenu(model.items).map((i) => i.id))
    for (const id of [...MAIN_SUBMENUS, 'adblock', 'zoom-row', 'copy-markdown', 'open-settings']) assert(ids.has(id), `the main menu has no ${id} row`)
    assert(typeof model.adblock === 'boolean', 'the main menu has no ad-blocking state')
  },
}

const mainOpens: SmokeCheck = {
  name: 'menus-main-escape',
  async run(ctx) {
    const doc = await openMainMenu(ctx)
    try {
      await doc.js(`document.querySelector('.mm [data-item="more-tools-menu"]').click(); return true`)
      await doc.until(`return document.querySelectorAll('[data-kit-card][data-level="1"]').length > 0`, 3000, 'the More tools side card')
      // Escape closes the innermost level first, then the menu.
      await escape(doc)
      await doc.until(`return document.querySelector('.mm') && document.querySelectorAll('[data-kit-card][data-level="1"]').length === 0`, 3000, 'the side card to close first')
    } finally {
      await closeMainMenu(ctx, doc)
    }
  },
}

export const mainMenuChecks: SmokeCheck[] = [nativeBar, mainModel, mainOpens]

export const mainMenuShots: ShotSpec[] = [
  {
    name: 'menus-main-menu',
    async run(ctx) {
      const doc = await openMainMenu(ctx)
      await sleep(200)
      await ctx.shot('menus-main-menu')
      await closeMainMenu(ctx, doc)
    },
  },
  ...MAIN_SUBMENUS.map(
    (id): ShotSpec => ({
      name: `menus-main-${id}`,
      async run(ctx) {
        const doc = await openMainMenu(ctx)
        try {
          await doc.js(`const row = document.querySelector('.mm [data-item=${JSON.stringify(id)}]'); if (row) row.click(); return Boolean(row)`)
          await doc.until(`return document.querySelector('[data-kit-card][data-level="1"][data-placed]')`, 3000, `the ${id} side card`)
          await sleep(150)
          await ctx.shot(`menus-main-${id}`)
        } finally {
          await closeMainMenu(ctx, doc)
        }
      },
    }),
  ),
]
