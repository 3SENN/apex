/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureStatus } from '@shared/meetingCapture'
import type { LidAction } from '@shared/haptics'
import { captureSmokeHooks, type CaptureSmokeHooks } from '../meetings/capture'
import { createHaptics, installHaptics, sharedHaptics } from '../native/haptics'
import { nativeSmokeHooks, type NativeSmokeHooks } from '../native/service'
import { parseHelperLine } from '../speech/protocol'
import { assert, sleep, waitFor } from '../smokeKit'
import type { SmokeContext } from '../smokeBrowser/types'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Native extras: haptics.perform resolves over IPC with and without the addon; a fake
// helper {type:'lid'} line during a fake recording pauses through
// recorder.pause('lid') and the open line resumes it, a pause the person made
// stays, and sleep and wake do the same; shots of the Haptics and Lid rows and
// the lid-paused widget (the harness runs the tour in light and dark).
// Offline only: the fake speech helper, no addon required.

function native(): NativeSmokeHooks {
  const h = nativeSmokeHooks()
  assert(h, 'the native feature is running')
  return h
}

function capture(): CaptureSmokeHooks {
  const h = captureSmokeHooks()
  assert(h, 'meeting capture is running under ATELIER_SMOKE')
  return h
}

const status = (ctx: SmokeContext): Promise<CaptureStatus> => ctx.chrome.invoke<CaptureStatus>('meetingCapture', 'status')

/** The raw line the helper prints, read through the real protocol parser. */
function lidLine(n: NativeSmokeHooks, closed: boolean): LidAction {
  const line = parseHelperLine(JSON.stringify({ type: 'lid', closed }))
  assert(line?.type === 'lid', 'the protocol reads the lid line')
  return n.line(line)
}

async function expectState(ctx: SmokeContext, state: CaptureStatus['state'], pausedBy: CaptureStatus['pausedBy'], what: string): Promise<void> {
  await waitFor(async () => {
    const s = await status(ctx)
    return s.state === state && s.pausedBy === pausedBy
  }, 3000, what)
}

export const checks: SmokeCheck[] = [
  {
    name: 'native: haptics.perform resolves over IPC, with the addon and without it',
    async run(ctx) {
      const n = native()
      const before = n.haptics().requested
      await ctx.chrome.invoke('haptics', 'perform', 'alignment')
      assert(n.haptics().requested === before + 1, 'the tick reached the haptics service')
      // Rate-limited, not an error: a burst still resolves.
      await Promise.all(['alignment', 'level-change', 'generic'].map((kind) => ctx.chrome.invoke('haptics', 'perform', kind)))

      const real = sharedHaptics()
      const stub = createHaptics({ load: () => ({ addon: null, reason: 'missing' }), enabled: () => true })
      installHaptics(stub)
      try {
        await ctx.chrome.invoke('haptics', 'perform', 'generic')
        const s = n.haptics()
        assert(s.requested === 1 && s.played === 0 && !s.available && s.reason === 'missing', `the no-addon fallback played or failed: ${JSON.stringify(s)}`)
      } finally {
        installHaptics(real)
      }
      // A kind outside the schema is refused at the IPC boundary.
      let refused = false
      await ctx.chrome.invoke('haptics', 'perform', 'thud').catch(() => (refused = true))
      assert(refused, 'an unknown haptic kind got through')
    },
  },
  {
    name: 'native: a helper lid line pauses a fake recording through the recorder and the open line resumes it; a pause you made stays',
    async run(ctx) {
      const n = native()
      const h = capture()
      const was = ctx.settings.get().pauseMeetingsOnLidClose
      ctx.settings.update({ pauseMeetingsOnLidClose: true })
      let id: string | null = null
      try {
        id = await h.recorder.start({ kind: 'recording', title: 'Lid pause smoke' })
        await expectState(ctx, 'recording', null, 'the fake recording to start')

        assert(lidLine(n, true) === 'pause', 'closing the lid did not pause')
        await expectState(ctx, 'paused', 'lid', 'a lid pause')
        const paused = await status(ctx)
        await sleep(300)
        assert((await status(ctx)).elapsedMs === paused.elapsedMs, 'the lid pause kept counting')
        assert(lidLine(n, true) === 'none', 'a repeated close line paused twice')
        assert(lidLine(n, false) === 'resume', 'opening the lid did not resume')
        await expectState(ctx, 'recording', null, 'the lid to resume the recording')

        // The person pauses: neither the lid nor waking undoes it.
        await ctx.chrome.invoke('meetingCapture', 'pause')
        await expectState(ctx, 'paused', 'user', 'the person’s pause')
        assert(lidLine(n, true) === 'none' && lidLine(n, false) === 'none', 'the lid touched a pause the person made')
        assert(n.power('suspend') === 'none' && n.power('resume') === 'none', 'sleeping touched a pause the person made')
        await expectState(ctx, 'paused', 'user', 'the person’s pause to stay')
        await ctx.chrome.invoke('meetingCapture', 'resume')
        await expectState(ctx, 'recording', null, 'the person’s resume')

        // Sleep without a lid line (Windows, or idle sleep) pauses and wakes the same way.
        assert(n.power('suspend') === 'pause', 'sleeping did not pause')
        await expectState(ctx, 'paused', 'lid', 'a sleep pause')
        assert(n.power('resume') === 'resume', 'waking did not resume')
        await expectState(ctx, 'recording', null, 'waking to resume the recording')

        // With the setting off, closing the lid leaves the recording alone.
        ctx.settings.update({ pauseMeetingsOnLidClose: false })
        assert(lidLine(n, true) === 'none', 'the lid paused with the setting off')
        assert(lidLine(n, false) === 'none', 'the lid resumed something it never paused')
        await expectState(ctx, 'recording', null, 'the recording to carry on with the setting off')
      } finally {
        ctx.settings.update({ pauseMeetingsOnLidClose: was })
        if (h.recorder.isLive()) await h.recorder.stop().catch(() => undefined)
        h.recorder.dismissWrapUp()
        if (id) await ctx.chrome.invoke('meetings', 'remove', id).catch(() => undefined)
      }
    },
  },
]

async function showRow(ctx: SmokeContext, page: string, anchor: string): Promise<void> {
  ctx.tabs.openInternal(`atelier://settings/${page}`)
  await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('[data-settings-anchor="${anchor}"] [role="switch"]'))`, 8000, `the ${anchor} row`)
  await ctx.chrome.js(`document.querySelector('[data-settings-anchor="${anchor}"]').scrollIntoView({ block: 'center' })`)
  await sleep(300)
}

const LID_PAUSED: CaptureStatus = {
  state: 'paused',
  meetingId: null,
  startedAt: Date.now(),
  elapsedMs: 1_284_000,
  systemAudio: true,
  origin: { tabId: null, url: null },
  warnings: [],
  pausedBy: 'lid',
  audioOnly: null,
}

export const shots: ShotSpec[] = [
  {
    name: 'e6 haptics row',
    async run(ctx) {
      // macOS only: elsewhere the row is hidden.
      if (process.platform !== 'darwin') return
      await showRow(ctx, 'general', 'haptics')
      await ctx.shot('native-haptics-row')
    },
  },
  {
    name: 'e6 lid pause row',
    async run(ctx) {
      await showRow(ctx, 'transcription', 'lid-pause')
      await ctx.shot('native-lid-pause-row')
    },
  },
  {
    name: 'e6 widget paused by the lid',
    async run() {
      const dir = process.env.ATELIER_SMOKE_SHOTS
      if (!dir) return
      const h = capture()
      const theme = process.env.ATELIER_SMOKE_THEME === 'dark' ? 'dark' : 'light'
      h.float.open('recording', { status: LID_PAUSED, wrapUp: null })
      try {
        await waitFor(() => h.float.window('recording')?.isVisible() === true, 5000, 'the recording widget')
        await sleep(350)
        const win = h.float.window('recording')
        assert(win, 'the recording widget window exists')
        const image = await win.webContents.capturePage()
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `native-widget-lid-paused-${theme}.png`), image.toPNG())
      } finally {
        h.float.close('recording')
      }
    },
  },
]
