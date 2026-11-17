/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ActivitySettings, ActivityStatus, MemoryBuildEstimate, MemoryJob, TidySchedule, TidySettings } from '@shared/activity'
import type { SiteInsight, TimelineDay } from '@shared/timeline'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Activity memory: memory builds, Tidy memory, activity memory on and off, exclusions, retention, the glyph and popover, and the timeline.
// Offline only: nothing here calls a model (estimates and settings only;
// no job or tidy pass is started), and pages come from the fixture server
// on 127.0.0.1. Every check puts activity memory back the way it found it.
// Shots cover Settings › Memory, Settings › Activity memory, the status
// popover and the timeline, in light and dark.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const DAY = 86_400_000

/** Runs `fn` with activity memory on and set hours off (so it captures now), then restores the settings. */
async function withActivityOn(ctx: SmokeContext, fn: () => Promise<void>, patch: Partial<ActivitySettings> = {}): Promise<void> {
  const before = await ctx.chrome.invoke<ActivitySettings>('activity', 'settings')
  try {
    await ctx.chrome.invoke('activity', 'update', { enabled: true, schedule: { ...before.schedule, on: false }, override: { kind: 'none' }, pausedUntil: null, ...patch })
    await fn()
  } finally {
    await ctx.chrome.invoke('activity', 'update', before)
  }
}

function page(ctx: SmokeContext): string {
  ctx.server.page('/d4-reading', '<!doctype html><title>Kyoto ryokan notes</title><h1>Ryokan near the station</h1><p>Quiet rooms, breakfast at seven.</p>')
  return `${ctx.server.http}/d4-reading`
}

export const checks: SmokeCheck[] = [
  {
    name: 'activity memory and Tidy memory are off by default',
    async run(ctx) {
      const settings = await ctx.chrome.invoke<ActivitySettings>('activity', 'settings')
      assert(settings.enabled === false, 'activity memory is on by default')
      assert(settings.proactive.insights === false && settings.proactive.routines === false, 'suggestions are on by default')
      const status = await ctx.chrome.invoke<ActivityStatus>('activity', 'status')
      assert(status.state === 'off', `expected off, got ${status.state}`)
      const tidy = await ctx.chrome.invoke<TidySettings>('memoryUpkeep', 'settings')
      assert(tidy.enabled === false, 'Tidy memory is on by default')
      const schedule = await ctx.chrome.invoke<TidySchedule>('memoryUpkeep', 'schedule')
      assert(schedule.nextAt === null, 'Tidy memory has a next pass while off')
    },
  },
  {
    name: 'pause, resume and overrides change the status',
    async run(ctx) {
      await withActivityOn(ctx, async () => {
        assert((await ctx.chrome.invoke<ActivityStatus>('activity', 'status')).state === 'capturing', 'not capturing with set hours off')
        const paused = await ctx.chrome.invoke<ActivityStatus>('activity', 'pause', Date.now() + 15 * 60_000)
        assert(paused.state === 'paused' && paused.pausedUntil !== null, 'pause did not take')
        const resumed = await ctx.chrome.invoke<ActivityStatus>('activity', 'resume')
        assert(resumed.state === 'capturing', 'resume did not take')
        const off = await ctx.chrome.invoke<ActivityStatus>('activity', 'override', { kind: 'off-until-tomorrow' })
        assert(off.state === 'paused' && off.overrideUntil !== null, '"off until tomorrow" did not take')
        const back = await ctx.chrome.invoke<ActivityStatus>('activity', 'override', { kind: 'none' })
        assert(back.state === 'capturing', 'clearing the override did not take')
      })
    },
  },
  {
    name: 'a visit is recorded while on, excluded sites never show, and clearing reports a count',
    async run(ctx) {
      const url = page(ctx)
      const host = new URL(url).hostname
      await withActivityOn(ctx, async () => {
        const tab = ctx.tabs.create(url, { activate: true })
        await waitFor(async () => (await ctx.chrome.invoke<{ total: number }>('activity', 'items', { kind: 'visit', query: 'ryokan' })).total > 0, 'the visit to be recorded')
        const now = Date.now()
        const sites = await ctx.chrome.invoke<SiteInsight[]>('timeline', 'sites', { from: now - DAY, to: now + 60_000 })
        assert(sites.some((s) => s.origin.includes(host)), 'the visit is missing from site insights')
        const settings = await ctx.chrome.invoke<ActivitySettings>('activity', 'settings')
        await ctx.chrome.invoke('activity', 'update', { excluded: { ...settings.excluded, sites: [...settings.excluded.sites, host] } })
        const hidden = await ctx.chrome.invoke<SiteInsight[]>('timeline', 'sites', { from: now - DAY, to: now + 60_000 })
        assert(!hidden.some((s) => s.origin.includes(host)), 'an excluded site still shows on the timeline')
        const cleared = await ctx.chrome.invoke<{ deleted: number; from: number | null; to: number }>('activity', 'clear', 'today')
        assert(cleared.deleted >= 1 && cleared.from !== null, `clear today reported ${cleared.deleted}`)
        assert((await ctx.chrome.invoke<{ total: number }>('activity', 'items', { query: 'ryokan' })).total === 0, 'items remain after clear')
        ctx.tabs.close(tab.id)
      })
    },
  },
  {
    name: 'nothing is recorded while activity memory is off',
    async run(ctx) {
      const url = page(ctx)
      await withActivityOn(ctx, async () => {
        await ctx.chrome.invoke('activity', 'clear', 'today')
        // Private windows, agent-driven pages and guarded fields are covered by the gate matrix in tests/activity.test.ts.
        await ctx.chrome.invoke('activity', 'update', { enabled: false })
        const tab = ctx.tabs.create(url, { activate: true })
        await new Promise((r) => setTimeout(r, 400))
        assert((await ctx.chrome.invoke<{ total: number }>('activity', 'items', { query: 'ryokan' })).total === 0, 'a visit was recorded while off')
        ctx.tabs.close(tab.id)
      })
    },
  },
  {
    name: 'memory build estimates and the per-chat switch answer without a model',
    async run(ctx) {
      const estimate = await ctx.chrome.invoke<MemoryBuildEstimate>('memory', 'estimateBuild', 'all')
      assert(Number.isInteger(estimate.chats) && estimate.approxInputTokens >= 0, 'the estimate is malformed')
      const jobs = await ctx.chrome.invoke<MemoryJob[]>('memory', 'jobs')
      assert(Array.isArray(jobs), 'no job list')
      const chat = '00000000-0000-4000-8000-0000000000d4'
      await ctx.chrome.invoke('activity', 'includeInChat', chat, false)
      assert((await ctx.chrome.invoke<boolean>('activity', 'chatIncluded', chat)) === false, 'the chat switch did not turn off')
      await ctx.chrome.invoke('activity', 'includeInChat', chat, true)
      const now = Date.now()
      const days = await ctx.chrome.invoke<TimelineDay[]>('timeline', 'days', { from: now - 7 * DAY, to: now })
      assert(Array.isArray(days), 'no timeline days')
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'memory-settings',
    async run(ctx) {
      ctx.tabs.openInternal('atelier://settings/memory')
      await ctx.chrome.until(`return document.querySelector('.am-block') && document.querySelector('.am-tidy')`, 8000, 'Settings › Memory')
      await ctx.shot('memory-settings')
    },
  },
  {
    name: 'activity-settings',
    async run(ctx) {
      await withActivityOn(ctx, async () => {
        await ctx.chrome.invoke('activity', 'pause', Date.now() + 60 * 60_000)
        ctx.tabs.openInternal('atelier://settings/activity')
        await ctx.chrome.until(`return document.querySelector('.am-days, .am-status') && document.querySelector('.am-inspector')`, 8000, 'Settings › Activity memory')
        await ctx.shot('activity-settings')
        await ctx.chrome.js(`document.querySelector('.am-inspector')?.scrollIntoView({ block: 'center' }); return true`)
        await ctx.shot('activity-settings-inspector')
      }, { schedule: { on: true, days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 } })
    },
  },
  {
    name: 'activity-popover',
    async run(ctx) {
      const url = page(ctx)
      await withActivityOn(ctx, async () => {
        const tab = ctx.tabs.create(url, { activate: true })
        await ctx.chrome.until(`return document.querySelector('.am-glyph')`, 8000, 'the activity glyph')
        await ctx.chrome.js(`document.querySelector('.am-glyph')?.click(); return true`)
        await new Promise((r) => setTimeout(r, 400))
        await ctx.shot('activity-popover')
        await ctx.chrome.escape()
        ctx.tabs.close(tab.id)
      })
    },
  },
  {
    name: 'workspace-timeline',
    async run(ctx) {
      const url = page(ctx)
      const tab = ctx.tabs.create(url, { activate: true })
      await new Promise((r) => setTimeout(r, 300))
      ctx.tabs.close(tab.id)
      // The timeline is History's Timeline view now.
      ctx.tabs.openInternal('atelier://history?view=timeline&scope=day')
      await ctx.chrome.until(`return document.querySelector('.tl-cal') && (document.querySelector('.tl-sessions') || document.querySelector('.tl .ui-state'))`, 8000, 'the timeline')
      await ctx.shot('workspace-timeline')
      for (const t of ctx.tabs.all()) if (t.internalUrl?.startsWith('atelier://history')) ctx.tabs.close(t.id)
    },
  },
]
