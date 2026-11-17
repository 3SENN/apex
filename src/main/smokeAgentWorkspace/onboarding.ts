/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Guide, GuideTryResult } from '@shared/guides'
import type { HelpTopic } from '@shared/help'
import type { DockIconDesign, PresetDetail, SetupState } from '@shared/onboarding'
import type { CompanionPreset } from '@shared/companion'
import type { GuidanceState } from '@shared/tips'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// The setup flow and resume, guides and Try it, help topics, guidance, preset extras and the Dock designer.
// Offline only: nothing here starts a model run; help and guide chats are
// checked through their services, and every check puts state back.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Runs `body` with setup at `step`, then puts setup back where it was. */
async function atStep(ctx: SmokeContext, step: SetupState['step'], body: () => Promise<void>): Promise<void> {
  const before = await ctx.chrome.invoke<SetupState>('onboarding', 'state')
  try {
    await ctx.chrome.invoke('onboarding', 'goTo', step)
    await body()
  } finally {
    await ctx.chrome.invoke('onboarding', 'save', { step: before.step }).catch(() => undefined)
  }
}

/** Clicks the first button in the chrome whose text is `label`. */
async function press(ctx: SmokeContext, selector: string, label: string): Promise<void> {
  const ok = await ctx.chrome.js<boolean>(`const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)}); if (b) b.click(); return Boolean(b)`)
  assert(ok, `no “${label}” to press`)
}

const conversation: SmokeCheck = {
  name: 'd7 (ON-18): the setup conversation becomes your profile, and the workspace step sets only what you keep',
  async run(ctx) {
    const rowsBefore = { ...ctx.settings.get().sidebar.destinations }
    const routinesBefore = new Set((await ctx.chrome.invoke<Array<{ id: string }>>('routines', 'list')).map((r) => r.id))
    await ctx.chrome.invoke('onboarding', 'clearProfile')
    try {
      await atStep(ctx, 'questions', async () => {
        ctx.tabs.openInternal('atelier://welcome')
        // An engine is ready (the offline stand-in), so the companion talks instead of showing cards.
        await ctx.chrome.until(`return [...document.querySelectorAll('.iv-chip')].some((b) => b.textContent.trim() === '🎨 I design apps') ? true : null`, 15_000, 'the companion’s first question with quick replies')
        await press(ctx, '.iv-chip', '🎨 I design apps')
        await ctx.chrome.until(`return [...document.querySelectorAll('.iv-chip')].some((b) => b.textContent.trim() === '🎨 Figma') ? true : null`, 15_000, 'the follow-up question')
        await press(ctx, '.iv-chip', '🎨 Figma')
        await press(ctx, 'button', 'Done (1)')
        await ctx.chrome.until(`return document.querySelector('.wlx__workspace') ? true : null`, 15_000, 'the workspace step')
        const profile = await ctx.chrome.invoke<{ techLevel: string; apps: string[]; habits: Array<{ what: string }> }>('onboarding', 'profile')
        assert(profile?.techLevel === 'mixed' && profile.apps.join() === 'Figma' && profile.habits[0]?.what === 'Plan the week', `the conversation became the wrong profile: ${JSON.stringify(profile)}`)
        const shown = await ctx.chrome.js<{ rows: string[]; routines: string[]; apps: string }>(
          `return { rows: [...document.querySelectorAll('.yw-mini__row[aria-pressed="true"]')].map((b) => b.textContent.trim()), routines: [...document.querySelectorAll('.yw-tile__name')].map((n) => n.textContent.trim()), apps: [...document.querySelectorAll('.yw-app')].map((n) => n.textContent).join(' ') }`,
        )
        assert(shown.routines.join() === 'Plan the week', `the review shows routines ${JSON.stringify(shown.routines)}`)
        assert(shown.apps.includes('Figma'), 'the review doesn’t name Figma to connect')
        assert(!ctx.settings.get().sidebar.destinations.meetings || rowsBefore.meetings, 'the review changed the sidebar before Set it up')
        await press(ctx, 'button', 'Set it up')
        await ctx.chrome.until(`return document.querySelector('.wlx__workspace') ? null : true`, 10_000, 'the next step')
        const rows = ctx.settings.get().sidebar.destinations
        // Connectors stays in More: companions already work in the sites you have open (1.3.1).
        assert(rows.chats && rows.meetings && rows.routines && !rows.connectors && !rows.workspace && !rows.guides, `the sidebar rows weren’t set: ${JSON.stringify(rows)}`)
        const made = (await ctx.chrome.invoke<Array<{ id: string; name: string; enabled: boolean }>>('routines', 'list')).filter((r) => !routinesBefore.has(r.id))
        assert(made.length === 1 && made[0]?.name === 'Plan the week' && made[0].enabled, `the routines made: ${JSON.stringify(made)}`)
      })
    } finally {
      ctx.settings.update({ sidebar: { destinations: rowsBefore } })
      for (const r of await ctx.chrome.invoke<Array<{ id: string }>>('routines', 'list')) if (!routinesBefore.has(r.id)) await ctx.chrome.invoke('routines', 'remove', r.id).catch(() => undefined)
      await ctx.chrome.invoke('onboarding', 'clearProfile').catch(() => undefined)
      for (const tab of ctx.tabs.all()) if (tab.internalUrl?.includes('welcome')) ctx.tabs.close(tab.id)
    }
  },
}

export const checks: SmokeCheck[] = [
  conversation,
  {
    name: 'd7: setup saves each step and resumes',
    async run(ctx) {
      await atStep(ctx, 'layout', async () => {
        const state = await ctx.chrome.invoke<SetupState>('onboarding', 'state')
        assert(state.step === 'layout' && state.visited.includes('layout'), 'the step was not saved')
      })
    },
  },
  {
    name: 'd7: guides list, search and Try it',
    async run(ctx) {
      const all = await ctx.chrome.invoke<Guide[]>('guides', 'list')
      assert(all.length >= 8, 'too few guides')
      const travel = await ctx.chrome.invoke<Guide[]>('guides', 'list', { category: 'travel' })
      assert(travel.every((g) => g.category === 'travel'), 'the category filter leaked')
      const tried = await ctx.chrome.invoke<GuideTryResult>('guides', 'tryIt', 'trip-planning')
      assert(tried.chatId === null, 'an install bundle started a chat')
    },
  },
  {
    name: 'd7: help topics',
    async run(ctx) {
      const topics = await ctx.chrome.invoke<HelpTopic[]>('help', 'topics')
      assert(topics.length === 6 && topics[0]?.id === 'getting-started', 'the help topics are wrong')
    },
  },
  {
    name: 'd7: dismissed tips stay dismissed',
    async run(ctx) {
      await ctx.chrome.invoke('guidance', 'dismissTip', 'smoke-d7-tip')
      const state = await ctx.chrome.invoke<GuidanceState>('guidance', 'state')
      assert(state.dismissedTips.includes('smoke-d7-tip'), 'the dismissal was lost')
    },
  },
  {
    name: 'd7: Dock design clamps and saves',
    async run(ctx) {
      const before = await ctx.chrome.invoke<DockIconDesign>('dockIcon', 'design')
      try {
        const saved = await ctx.chrome.invoke<DockIconDesign>('dockIcon', 'save', { ...before, rotate: 45, scale: 1.2, smile: true })
        assert(saved.rotate === 45 && saved.scale === 1.2 && saved.smile, 'the design did not save')
        const bad = await ctx.chrome.invoke('dockIcon', 'save', { ...before, scale: 9 }).then(() => false, () => true)
        assert(bad, 'an out-of-range scale passed the schema')
      } finally {
        await ctx.chrome.invoke('dockIcon', 'save', before)
      }
    },
  },
  {
    name: 'd7: preset detail',
    async run(ctx) {
      const presets = await ctx.chrome.invoke<CompanionPreset[]>('companion', 'presets')
      const first = presets[0]
      if (!first) return
      const detail = await ctx.chrome.invoke<PresetDetail>('companions', 'presetDetail', first.id)
      assert(detail.name === first.name && detail.version, 'the preset detail is incomplete')
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'setup-conversation',
    async run(ctx) {
      await ctx.chrome.invoke('onboarding', 'clearProfile')
      try {
        await atStep(ctx, 'questions', async () => {
          ctx.tabs.openInternal('atelier://welcome')
          await ctx.chrome.until(`return [...document.querySelectorAll('.iv-chip')].some((b) => b.textContent.trim() === '🎨 I design apps') ? true : null`, 15_000, 'the first question')
          await pause(400)
          await ctx.shot('setup-conversation')
          await press(ctx, '.iv-chip', '🎨 I design apps')
          await ctx.chrome.until(`return [...document.querySelectorAll('.iv-chip')].some((b) => b.textContent.trim() === '🎨 Figma') ? true : null`, 15_000, 'the follow-up')
          await press(ctx, '.iv-chip', '🎨 Figma')
          await pause(300)
          await ctx.shot('setup-conversation-apps')
          await press(ctx, 'button', 'Done (1)')
          await ctx.chrome.until(`return document.querySelector('.wlx__workspace') ? true : null`, 15_000, 'the workspace step')
          await pause(400)
          await ctx.shot('setup-workspace')
        })
        ctx.tabs.openInternal('atelier://settings/you')
        await ctx.chrome.until(`return [...document.querySelectorAll('h2, h3')].some((h) => h.textContent.trim() === 'About you') ? true : null`, 10_000, 'About you in Settings')
        await ctx.chrome.js(`[...document.querySelectorAll('h2, h3')].find((h) => h.textContent.trim() === 'About you').scrollIntoView({ block: 'start' })`)
        await pause(400)
        await ctx.shot('about-you-settings')
      } finally {
        await ctx.chrome.invoke('onboarding', 'clearProfile').catch(() => undefined)
        for (const tab of ctx.tabs.all()) if (tab.internalUrl?.includes('welcome') || tab.internalUrl?.includes('settings')) ctx.tabs.close(tab.id)
      }
    },
  },
  {
    name: 'setup-questions',
    async run(ctx) {
      await atStep(ctx, 'questions', async () => {
        ctx.tabs.openInternal('atelier://welcome')
        await ctx.chrome.until(`return document.querySelector('.wlx__card')`, 8000, 'the question card')
        await pause(400)
        await ctx.shot('setup-questions')
      })
    },
  },
  {
    name: 'setup-showcase',
    async run(ctx) {
      await atStep(ctx, 'showcase', async () => {
        ctx.tabs.openInternal('atelier://welcome')
        await ctx.chrome.until(`return document.querySelector('.wlx__showcase')`, 8000, 'the showcase')
        await pause(400)
        await ctx.shot('setup-showcase')
      })
    },
  },
  {
    name: 'guides-page',
    async run(ctx) {
      ctx.tabs.openInternal('atelier://guides')
      // The library opens on its shelves of books; a search shows cards.
      await ctx.chrome.until(`return document.querySelector('.gd-book, .gd-card')`, 8000, 'the guides library')
      await ctx.shot('guides-page')
      ctx.tabs.openInternal('atelier://guides/morning-digest')
      await ctx.chrome.until(`return document.querySelector('.gd-bundle')`, 8000, 'the guide detail')
      await ctx.shot('guides-detail')
    },
  },
]
