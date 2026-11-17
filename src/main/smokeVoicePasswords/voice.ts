/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { screen, type Input, type WebContents } from 'electron'
import type { VoiceSettings } from '@shared/voice'
import { shortcuts } from '../shortcuts'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { CONTENT_PROTECTION } from '../float/manager'
import { voiceProbe, type VoiceProbe } from '../voice'
import { voiceSmoke } from '../voice/smokeSpeech'
import { crossSiteFixtures } from './fixtures'

// Voice: the chord through the input interceptor with the fake
// helper (the words come from voiceSmoke, since the fake hears nothing), the
// HUD and the offline client's reply with the tab's screenshot as an image
// block, dictation into a fixture input, and the launcher through
// voice.launcherToggle. The global shortcut is never registered in smoke.

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Voice fixture</title></head>
<body style="font: 16px system-ui; padding: 24px">
<h1>Voice fixture</h1>
<p>A made-up page for the voice smoke check.</p>
<label>Note <input id="voice-field" type="text" autocomplete="off"></label>
<label>Secret <input id="voice-secret" type="password" autocomplete="off"></label>
</body></html>`

function probe(): VoiceProbe {
  const p = voiceProbe()
  assert(p, 'voice is running')
  return p
}

function key(type: 'keyDown' | 'keyUp', k: string, code: string, alt: boolean): Input {
  return { type, key: k, code, isAutoRepeat: false, isComposing: false, shift: false, control: false, alt, meta: false, location: 0, modifiers: alt ? ['alt'] : [] } as unknown as Input
}

/**
 * Holds ⌥Space on `wc` through the interceptors for `ms`, then lets go. The keys always come up: a step
 * that fails mid-hold first drops the turn (the HUD's ✕), so no held chord or half-done turn carries
 * into the next check.
 */
async function hold(ctx: SmokeContext, wc: WebContents, ms: number, during?: () => Promise<void>): Promise<void> {
  shortcuts.intercept(key('keyDown', 'Alt', 'AltLeft', true), wc, null)
  assert(shortcuts.intercept(key('keyDown', ' ', 'Space', true), wc, null), 'the chord is handled')
  let done = false
  try {
    await sleep(ms)
    await during?.()
    done = true
  } finally {
    if (!done) await ctx.chrome.invoke('voice', 'hudAction', 'dismiss').catch(() => undefined)
    const up = shortcuts.intercept(key('keyUp', ' ', 'Space', true), wc, null)
    shortcuts.intercept(key('keyUp', 'Alt', 'AltLeft', false), wc, null)
    if (done) assert(up, 'the chord’s key-up is handled')
  }
}

async function withVoice(ctx: SmokeContext, patch: Partial<VoiceSettings>, run: () => Promise<void>): Promise<void> {
  const before = ctx.settings.get().voice
  ctx.settings.update({ voice: { holdToTalk: true, chord: 'alt+space', sounds: false, ...patch } })
  voiceSmoke.clear()
  try {
    await run()
  } finally {
    voiceSmoke.clear()
    // Whatever the check left (a reply still coming, an error showing) ends here, as the HUD's ✕ ends it.
    await ctx.chrome.invoke('voice', 'hudAction', 'dismiss').catch(() => undefined)
    probe().float.close('voice-hud')
    ctx.settings.update({ voice: before })
  }
}

/** waitFor, with the HUD as it was when the wait gave up in the message. */
async function waitForHud(p: VoiceProbe, condition: () => boolean, ms: number, what: string): Promise<void> {
  try {
    await waitFor(condition, ms, what)
  } catch (err) {
    const h = p.hud()
    throw new Error(`${err instanceof Error ? err.message : String(err)} (state ${h.state}, target ${h.target}, error ${h.error?.code ?? 'none'}, inserted ${h.inserted ?? 'none'}, heard ${JSON.stringify(h.settled)})`)
  }
}

/** Where the system's pointer rests and where the HUD is, and whether the one is on the other (screen DIP). */
function pointerOnHud(p: VoiceProbe): { on: boolean; where: string } {
  const win = p.float.window('voice-hud')
  const at = screen.getCursorScreenPoint()
  if (!win || win.isDestroyed()) return { on: false, where: `pointer ${at.x},${at.y}, no HUD window` }
  const b = win.getBounds()
  const on = at.x >= b.x && at.x < b.x + b.width && at.y >= b.y && at.y < b.y + b.height
  return { on, where: `pointer ${at.x},${at.y}, HUD ${b.x},${b.y} ${b.width}x${b.height}` }
}

/**
 * Waits for the answered HUD's countdown. Windows tells a window that grows under a resting pointer that the
 * pointer is on it, so a pointer left where the answer grows the HUD (the middle of a small CI screen) hovers
 * it, and a hovered HUD rightly waits; macOS says nothing until the pointer moves. There the pointer leaving
 * (the HUD's mouseleave) is what starts the countdown.
 */
async function answeredCountdown(ctx: SmokeContext, p: VoiceProbe): Promise<void> {
  let left = false
  try {
    await waitFor(async () => {
      if ((p.hud().countdownMs ?? 0) > 0) return true
      if (!left && p.hud().state === 'answered' && p.hud().countdownMs === null && pointerOnHud(p).on) {
        left = true
        await ctx.chrome.invoke('voice', 'hudAction', 'hover-end')
      }
      return false
    }, 3000, 'the answered HUD to count down to close')
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (state ${p.hud().state}, countdown ${p.hud().countdownMs}, ${pointerOnHud(p).where}${left ? ', after the pointer left' : ''})`)
  }
}

async function fixtureTab(ctx: SmokeContext): Promise<{ id: string; wc: WebContents }> {
  const url = (await crossSiteFixtures(ctx.server)).addFixture('/voice-fixture.html', FIXTURE)
  const tab = ctx.tabs.create(url, { activate: true })
  const wc = tab.view.webContents
  await waitForPage(wc, 'the voice fixture page', 8000, (at) => at === url)
  return { id: tab.id, wc }
}

const companion: SmokeCheck = {
  name: 'voice: a hold asks the companion with the tab’s screenshot',
  async run(ctx) {
    const p = probe()
    const { id, wc } = await fixtureTab(ctx)
    try {
      await withVoice(ctx, { target: 'companion', screenshot: true, screenshotSource: 'tab' }, async () => {
        voiceSmoke.say('Help me plan a picnic for Saturday')
        await hold(ctx, wc, 450, async () => {
          await waitFor(() => p.hud().state === 'listening', 3000, 'the HUD to listen')
          await waitFor(() => p.float.window('voice-hud')?.isVisible() === true, 3000, 'the HUD window to show')
          const hudWin = p.float.window('voice-hud')
          assert(hudWin, 'the HUD window exists')
          assert(hudWin.isAlwaysOnTop(), 'the HUD stays on top')
          if (CONTENT_PROTECTION) {
            assert(hudWin.isContentProtected(), 'the HUD is kept out of screen captures')
          } else {
            // Linux has no content protection: Atelier's own screen captures hide the floats while they run.
            const shownDuring = await p.float.keepOutOf(async () => hudWin.isVisible())
            assert(!shownDuring, 'the HUD hides while Atelier captures the screen (no content protection here)')
            await waitFor(() => hudWin.isVisible(), 2000, 'the HUD to come back after the capture')
          }
          assert(process.platform !== 'darwin' || hudWin.isVisibleOnAllWorkspaces(), 'the HUD shows on every Space')
          await waitFor(() => p.hud().settled.includes('picnic'), 3000, 'the words to settle')
          assert((await ctx.chrome.invoke<{ state: string }>('voice', 'status')).state === 'listening', 'voice.status says listening')
        })
        await waitFor(() => p.hud().state === 'answered' && (p.hud().answer?.markdown ?? '').includes('simple plan'), 10_000, 'the companion’s answer in the HUD')
        const hud = p.hud()
        assert(hud.target === 'companion' && hud.chatId, 'the command went to a chat')
        assert(ctx.client.lastImages >= 1, `the offline client received the screenshot as an image block (got ${ctx.client.lastImages})`)
        await answeredCountdown(ctx, p)
        await ctx.chrome.invoke('voice', 'hudAction', 'hover-start')
        await waitFor(() => p.hud().countdownMs === null, 2000, 'hovering to pause the countdown')
        await ctx.chrome.invoke('voice', 'hudAction', 'hover-end')
        await ctx.chrome.invoke('voice', 'hudAction', 'dismiss')
        await waitFor(() => p.hud().state === 'idle' && p.float.window('voice-hud')?.isVisible() !== true, 3000, 'the HUD to close')
      })
    } finally {
      ctx.tabs.close(id)
    }
  },
}

const tapAndSilence: SmokeCheck = {
  name: 'voice: a short tap opens no session, and silence says so',
  async run(ctx) {
    const p = probe()
    const { id, wc } = await fixtureTab(ctx)
    try {
      await withVoice(ctx, { target: 'companion', screenshot: false }, async () => {
        await waitFor(() => p.hud().state === 'idle' && !p.float.isOpen('voice-hud'), 3000, `the HUD to be closed before the tap (it shows ${p.hud().state})`)
        const turn = p.hud().turn
        await hold(ctx, wc, 60)
        // Past the hold threshold (250 ms): a session would have started by now.
        await sleep(350)
        assert(p.hud().state === 'idle' && p.hud().turn === turn && !p.float.isOpen('voice-hud'), `a tap leaves the HUD closed (state ${p.hud().state}, turn ${turn} → ${p.hud().turn})`)
        // Nothing queued: the fake helper hears nothing at all.
        await hold(ctx, wc, 400)
        await waitFor(() => p.hud().state === 'error' && p.hud().error?.code === 'no-speech', 3000, 'the no-speech error')
      })
    } finally {
      ctx.tabs.close(id)
    }
  },
}

const dictation: SmokeCheck = {
  name: 'voice: dictation types into the focused fixture input',
  async run(ctx) {
    const p = probe()
    const { id, wc } = await fixtureTab(ctx)
    try {
      await wc.executeJavaScript(`document.getElementById('voice-field').focus(); true`)
      await withVoice(ctx, { target: 'auto', screenshot: false, rewriteField: false }, async () => {
        // Each hold lasts until the words are in, as a person keeps holding while they speak: a slow
        // machine can take longer than the hold to start the session, and a turn that heard nothing
        // ends in no-speech instead of reaching the field.
        voiceSmoke.say('remember the oat milk')
        await hold(ctx, wc, 450, async () => {
          await waitForHud(p, () => p.hud().target === 'field', 3000, 'the HUD to aim at the field')
          await waitForHud(p, () => p.hud().settled.includes('oat milk'), 3000, 'the words to settle')
        })
        await waitForHud(p, () => p.hud().inserted === 'typed', 6000, 'the text to be typed in')
        const value = await wc.executeJavaScript(`document.getElementById('voice-field').value`)
        assert(String(value).includes('remember the oat milk'), `the field holds the words (got ${JSON.stringify(value)})`)
        // A password field never takes dictation.
        await wc.executeJavaScript(`document.getElementById('voice-secret').focus(); true`)
        voiceSmoke.say('not for this field')
        await hold(ctx, wc, 450, async () => {
          // An error still shows the field it refused (hudTarget), so 'field' means the focus was read.
          await waitForHud(p, () => p.hud().target === 'field', 3000, 'the HUD to aim at the password field')
          await waitForHud(p, () => p.hud().settled.includes('this field'), 3000, 'the words to settle')
        })
        await waitForHud(p, () => p.hud().state === 'error' && p.hud().error?.code === 'no-field', 4000, 'the no-field error on a password field')
        const secret = await wc.executeJavaScript(`document.getElementById('voice-secret').value`)
        assert(secret === '', 'nothing was typed into the password field')
      })
    } finally {
      ctx.tabs.close(id)
    }
  },
}

const launcher: SmokeCheck = {
  name: 'voice: the quick-ask launcher listens, shows the text and sends a new chat',
  async run(ctx) {
    const p = probe()
    const chatTabs = (): number => ctx.tabs.all().filter((t) => (t.internalUrl ?? '').startsWith('atelier://chat/')).length
    const chatsBefore = chatTabs()
    const before = ctx.settings.get().voice
    ctx.settings.update({ voice: { sounds: false, launcherScreenshot: false } })
    voiceSmoke.clear()
    try {
      assert(!(await ctx.chrome.invoke<{ registered: boolean }>('voice', 'shortcutStatus')).registered, 'no global shortcut under smoke')
      voiceSmoke.say('What is a good laptop for travel')
      await ctx.chrome.invoke('voice', 'launcherToggle')
      await waitFor(() => p.status().launcherOpen && p.float.window('launcher')?.isVisible() === true, 4000, 'the launcher to open')
      await waitFor(() => p.launcher().text.includes('laptop'), 3000, 'the launcher to hear the words')
      assert(p.launcher().state === 'listening', 'the launcher is listening')
      // The key again while listening stops and shows the text to edit.
      await ctx.chrome.invoke('voice', 'launcherToggle')
      await waitFor(() => p.launcher().state === 'typing', 3000, 'the text to settle for editing')
      const win = p.float.window('launcher')
      assert(win, 'the launcher window is up')
      // Send the way a person would: the button, once the text has reached the field.
      await waitFor(
        async () => Boolean(await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.voice-send'); if (!b || b.disabled) return false; b.click(); return true })()`)),
        6000,
        'the launcher’s Send button',
      ).catch(async (err: unknown) => {
        const dom = await win.webContents
          .executeJavaScript(`(() => { const b = document.querySelector('.voice-send'); const f = document.querySelector('.voice-launcher textarea, .voice-launcher input'); return JSON.stringify({ button: b ? (b.disabled ? 'disabled' : 'enabled') : 'missing', field: f ? f.value : null }) })()`)
          .catch(() => 'unreadable')
        throw new Error(`${err instanceof Error ? err.message : String(err)} Launcher: ${p.launcher().state} "${p.launcher().text}"; page: ${dom}`)
      })
      await waitFor(() => !p.status().launcherOpen, 6000, 'the launcher to hand over and hide')
      await waitFor(() => chatTabs() > chatsBefore, 6000, 'a new chat tab')
    } finally {
      voiceSmoke.clear()
      if (p.status().launcherOpen) await ctx.chrome.invoke('voice', 'launcherToggle').catch(() => undefined)
      ctx.settings.update({ voice: before })
    }
  },
}

export const checks: SmokeCheck[] = [companion, tapAndSilence, dictation, launcher]
export const shots: ShotSpec[] = []
