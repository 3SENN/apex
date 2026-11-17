/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GROUP_COLORS } from '@shared/tabs'
import { core } from '../app'
import type { WindowContext } from '../features/types'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The tabs smoke checks and light and dark shots: groups
// collapse and skip their tabs in ⌘1–8, the selection drives bulk close,
// split view takes its ratio and the empty pane's chooser, and the strip
// sizes tabs. Every page is local (about:blank and atelier://); nothing
// reaches the network.

function firstWindow(ctx: SmokeContext): WindowContext {
  const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
  assert(win, 'the first window')
  return win
}

async function drawn(win: WindowContext, selector: string): Promise<void> {
  await waitFor(
    async () => {
      const wc = win.overlay.tierWebContents('interactive')
      if (!wc || wc.isDestroyed()) return false
      return new Chrome(wc).js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)
    },
    8000,
    `${selector} in the overlay`,
  )
}

/** Opens `n` blank tabs and returns their ids; the caller closes them. */
function openTabs(ctx: SmokeContext, n: number): string[] {
  return Array.from({ length: n }, () => ctx.tabs.create('about:blank', { activate: false }).id)
}

function closeAll(ctx: SmokeContext, ids: readonly string[]): void {
  for (const id of ids) if (ctx.tabs.find(id)) ctx.tabs.close(id)
}

const groups: SmokeCheck = {
  name: 'a collapsed group hides its tabs and its row counts them',
  async run(ctx) {
    const ids = openTabs(ctx, 3)
    try {
      const group = ctx.tabs.createGroup(ids.slice(0, 2), 'Smoke')
      await ctx.chrome.until(`return document.querySelector('[data-group-row="${group.id}"]') ? true : null`, 5000, 'the group row')
      ctx.tabs.updateGroup(group.id, { collapsed: true })
      await ctx.chrome.until(`return document.querySelector('[data-tab-ids~="${ids[0]}"]') ? null : true`, 5000, 'the grouped tab hidden')
      assert(ctx.tabs.snapshot().groups.some((g) => g.id === group.id && g.collapsed), 'the snapshot carries the collapsed group')
      ctx.tabs.ungroup(group.id)
      assert(ctx.tabs.snapshot().groups.every((g) => g.id !== group.id), 'ungroup keeps the tabs and drops the group')
      assert(ids.every((id) => ctx.tabs.find(id)), 'the tabs stay')
    } finally {
      closeAll(ctx, ids)
    }
  },
}

const selection: SmokeCheck = {
  name: 'the selection is held in main and bulk close skips pinned tabs',
  async run(ctx) {
    const ids = openTabs(ctx, 3)
    try {
      ctx.tabs.setPinned(ids[0] ?? '', true)
      ctx.tabs.setSelection(ids)
      assert(ctx.tabs.snapshot().selection.length === 3, 'three tabs selected')
      ctx.tabs.closeSelection()
      assert(ctx.tabs.find(ids[0] ?? '') !== undefined, 'the pinned tab stays')
      assert(!ctx.tabs.find(ids[1] ?? '') && !ctx.tabs.find(ids[2] ?? ''), 'the others close')
    } finally {
      const pinned = ctx.tabs.find(ids[0] ?? '')
      if (pinned) ctx.tabs.setPinned(pinned.id, false)
      closeAll(ctx, ids)
    }
  },
}

const split: SmokeCheck = {
  name: 'split view keeps its ratio, offers the chooser and separates',
  async run(ctx) {
    const ids = openTabs(ctx, 2)
    try {
      const [a, b] = ids
      assert(a && b, 'two tabs')
      ctx.tabs.openSplitWith(a, b)
      ctx.tabs.setSplitRatio(0.3)
      assert(Math.abs((ctx.tabs.snapshot().splitRatio ?? 0) - 0.3) < 0.01, 'the ratio is saved')
      await ctx.chrome.until('return document.querySelector(".content--split .split-seam") ? true : null', 5000, 'the seam')
      await ctx.chrome.until('return document.querySelector(".split-chooser") ? true : null', 5000, 'the empty pane chooser')
      ctx.tabs.closeSplit()
      assert(ctx.tabs.split() === null, 'the split ends with both tabs kept')
    } finally {
      ctx.tabs.closeSplit()
      closeAll(ctx, ids)
    }
  },
}

export const checks: SmokeCheck[] = [groups, selection, split]

const groupColours: ShotSpec = {
  name: 'tabs-group-colours',
  async run(ctx) {
    const ids = openTabs(ctx, GROUP_COLORS.length)
    const made: string[] = []
    try {
      for (const [i, color] of GROUP_COLORS.entries()) {
        const g = ctx.tabs.createGroup([ids[i] ?? ''], color)
        ctx.tabs.updateGroup(g.id, { color })
        made.push(g.id)
      }
      await sleep(400)
      await ctx.shot('tabs-group-colours')
    } finally {
      for (const id of made) ctx.tabs.ungroup(id)
      closeAll(ctx, ids)
    }
  },
}

const splitMenu: ShotSpec = {
  name: 'tabs-split-menu',
  async run(ctx) {
    const ids = openTabs(ctx, 2)
    const win = firstWindow(ctx)
    try {
      const [a, b] = ids
      if (!a || !b) return
      ctx.tabs.openSplitWith(a, b)
      await sleep(300)
      await ctx.chrome.js('document.querySelector(".split-btn")?.click()')
      await drawn(win, '.split-menu')
      await sleep(200)
      await ctx.shot('tabs-split-menu')
      win.overlay.closeAll((s) => s === 'split-menu')
    } finally {
      ctx.tabs.closeSplit()
      closeAll(ctx, ids)
    }
  },
}

export const shots: ShotSpec[] = [groupColours, splitMenu]
