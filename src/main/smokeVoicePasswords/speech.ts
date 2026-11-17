/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranscriptionSettings } from '@shared/speech'
import { smokeSpeechAssets, smokeSpeechPermissions } from '../speech/fake'
import { screenAccess } from '../speech/screenAccess'
import { assert } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Settings › Transcription over the fake speech helper (no
// real prompts, no microphone): the checklist's states as Allow grants each
// permission, and the level test with the helper's scripted levels. Offline
// only; the shots run in both themes.

const PAGE = 'atelier://settings/transcription'
const CHECKLIST = `document.querySelector('.sk-checklist')`
const TEST = `document.querySelector('.sk-test')`

/** Runs `body` with the checklist showing from scratch, then puts permissions and settings back. */
async function withFreshSetup(ctx: SmokeContext, body: () => Promise<void>): Promise<void> {
  const before: TranscriptionSettings = ctx.settings.get().transcription
  smokeSpeechPermissions.set({ microphone: 'not-determined', speech: 'not-determined', screen: 'denied' })
  ctx.settings.update({ transcription: { setupDismissed: false } })
  // Main remembers whether Atelier asked for Screen Recording; start from never asked.
  screenAccess().forgetAsked()
  // Another page first, so Transcription mounts afresh and reads the scripted report.
  ctx.tabs.openInternal('atelier://settings/you')
  await ctx.chrome.until(`return !document.querySelector('.sk-page')`, 5000, 'Settings to leave Transcription')
  try {
    await body()
  } finally {
    smokeSpeechPermissions.reset()
    ctx.settings.update({ transcription: before })
  }
}

async function progress(ctx: SmokeContext, done: number): Promise<void> {
  await ctx.chrome.until(`return ${CHECKLIST}?.innerText.includes('${done} of 3 done')`, 8000, `the checklist at ${done} of 3`)
}

const checklist: SmokeCheck = {
  name: 'speech: the Transcription checklist ticks each permission and hides when done',
  async run(ctx) {
    await withFreshSetup(ctx, async () => {
      ctx.tabs.openInternal(PAGE)
      await ctx.chrome.until(`return document.querySelector('[data-settings-anchor="transcription-mic"]')`, 8000, 'Settings › Transcription')
      await progress(ctx, 0)
      assert(await ctx.chrome.js<boolean>(`return !!document.querySelector('.sk-step--current[aria-current="step"]')`), 'one step is open')
      await ctx.chrome.click(/^Allow$/, CHECKLIST)
      await progress(ctx, 1)
      await ctx.chrome.click(/^Allow$/, CHECKLIST)
      await progress(ctx, 2)
      // Microphone and speech done: the call-audio step offers to skip.
      await ctx.chrome.until(`return ${CHECKLIST}?.innerText.includes('Skip the other side')`, 5000, 'the skip offer')
      await ctx.chrome.click(/^Allow$/, CHECKLIST)
      await ctx.chrome.until(`return !${CHECKLIST}`, 8000, 'the checklist to hide once everything is allowed')
    })
  },
}

const levels: SmokeCheck = {
  name: 'speech: the level test meters scripted levels, keeps the last test and deletes it',
  async run(ctx) {
    ctx.tabs.openInternal(PAGE)
    await ctx.chrome.until(`return ${TEST}`, 8000, 'the microphone test')
    await ctx.chrome.click(/^Test$/, TEST)
    await ctx.chrome.until(
      `return [...document.querySelectorAll('[data-settings-anchor="transcription-levels"] [role="meter"]')].some((m) => Number(m.getAttribute('aria-valuenow')) > 0)`,
      5000,
      'a live microphone level',
    )
    await ctx.chrome.click(/^Stop$/, TEST)
    await ctx.chrome.until(`return ${TEST}?.innerText.includes('Last test')`, 8000, 'the last test')
    const info = await ctx.chrome.invoke<{ exists: boolean; url: string | null }>('transcription', 'testInfo')
    assert(info.exists && info.url === 'atelier-media://speech/test', 'the test recording is kept for playback')
    await ctx.chrome.click(/^Delete$/, TEST)
    await ctx.chrome.until(`return ${TEST}?.innerText.includes('No test yet')`, 5000, 'the test to be deleted')
  },
}

// Transcription engine: macOS 26's on-device model for the language, over
// the fake helper (nothing is downloaded): offered, prepared with progress, ready.
const MODEL = `document.querySelector('[data-testid="transcription-model"]')`
const model: SmokeCheck = {
  name: 'speech: Settings › Transcription prepares the language’s on-device model and says when it is ready',
  async run(ctx) {
    smokeSpeechAssets.set('supported')
    try {
      // Another page first, so Transcription mounts afresh and asks again.
      ctx.tabs.openInternal('atelier://settings/you')
      await ctx.chrome.until(`return !document.querySelector('[data-settings-anchor="transcription-mic"]')`, 5000, 'Settings to leave Transcription')
      ctx.tabs.openInternal(PAGE)
      await ctx.chrome.until(`return ${MODEL}?.dataset.state === 'offer'`, 8000, 'the offer to prepare on-device speech')
      await ctx.chrome.click(/^Prepare now$/, MODEL)
      await ctx.chrome.until(`return ${MODEL}?.dataset.state === 'ready' && ${MODEL}.innerText.includes('is ready')`, 8000, 'on-device speech to be ready')
      const assets = await ctx.chrome.invoke<{ state: string }>('transcription', 'assets')
      assert(assets.state === 'installed', 'the model is reported installed')
    } finally {
      smokeSpeechAssets.reset()
    }
  },
}

const MODE = `document.querySelector('[data-settings-anchor="transcription-mode"]')`
const meetingMode: SmokeCheck = {
  name: 'speech: Settings › Transcription chooses between transcribing meetings and recording audio only',
  async run(ctx) {
    const before = ctx.settings.get().transcription
    try {
      ctx.tabs.openInternal(PAGE)
      await ctx.chrome.until(`return ${MODE}?.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes('Transcribe and take notes')`, 8000, 'Transcribe and take notes chosen')
      await ctx.chrome.click(/^Record audio only/, MODE)
      await ctx.chrome.until(`return ${MODE}?.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes('Record audio only')`, 8000, 'Record audio only chosen')
      assert(ctx.settings.get().transcription.recordOnly === true, 'the choice is saved')
      // Audio only always keeps the audio: its switch is on and can't be turned off.
      const keep = await ctx.chrome.js<{ checked: boolean; disabled: boolean } | null>(
        `const el = document.querySelector('[data-settings-anchor="transcription-record"] [role="switch"], [data-settings-anchor="transcription-record"] input')
         return el ? { checked: el.getAttribute('aria-checked') === 'true' || el.checked === true, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' } : null`,
      )
      assert(keep?.checked && keep.disabled, `Keep audio recordings is on and fixed (${JSON.stringify(keep)})`)
      await ctx.chrome.click(/^Transcribe and take notes/, MODE)
      await ctx.chrome.until(`return ${MODE}?.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes('Transcribe and take notes')`, 8000, 'back to transcribing')
      assert(ctx.settings.get().transcription.recordOnly === false, 'switching back is saved')
    } finally {
      ctx.settings.update({ transcription: { recordOnly: before.recordOnly } })
    }
  },
}

export const checks: SmokeCheck[] = [checklist, levels, model, meetingMode]

export const shots: ShotSpec[] = [
  {
    name: 'transcription-settings',
    async run(ctx) {
      ctx.tabs.openInternal(PAGE)
      await ctx.chrome.until(`return document.querySelector('[data-settings-anchor="transcription-levels"]')`, 8000, 'Settings › Transcription')
      await ctx.shot('transcription-settings')
    },
  },
  {
    name: 'transcription-settings-checklist',
    async run(ctx) {
      await withFreshSetup(ctx, async () => {
        smokeSpeechPermissions.set({ microphone: 'granted' })
        ctx.tabs.openInternal(PAGE)
        await progress(ctx, 1)
        await ctx.shot('transcription-settings-checklist')
      })
    },
  },
]
