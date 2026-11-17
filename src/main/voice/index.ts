/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, BrowserWindow, globalShortcut } from 'electron'
import type { MeetingRecorder } from '@shared/meetingCapture'
import type { SpeechBroker } from '@shared/speech'
import { chordAccelerator, type HudPayload, type LauncherPayload, type VoiceServices, type VoiceStatus } from '@shared/voice'
import type { AppContext } from '../features/types'
import type { CaptureMasker } from '../features/personalRuntime'
import type { FloatManager } from '../float/manager'
import { errorMessage, log } from '../log'
import { shortcuts } from '../shortcuts'
import { ChordTracker, tapText } from './keys'
import { QuickAsk } from './quickAsk'
import { RECORDING_STATES, type VoiceRuntime } from './runtime'
import { LauncherShortcut } from './shortcut'
import { smokeVoiceBroker } from './smokeSpeech'
import { VoiceTurns, type KeyContext } from './turns'

// Voice's entry point: the hold-to-talk chord through the core input
// interceptor on every Atelier webContents, the turns and the HUD, the quick-ask
// launcher and its opt-in global shortcut (registered only while no Atelier
// window has focus, never under ATELIER_SMOKE).

/** Above the core's own interceptors: the chord must be seen before any page or shortcut. */
const INTERCEPT_PRIORITY = 100

export interface VoiceSetup {
  services: VoiceServices
  dispose(): void
}

/** The personal runtime slots voice reads; getters, so a slot filled later is still found. */
export interface VoiceDeps {
  broker(): SpeechBroker
  masker(): CaptureMasker
  recorder(): MeetingRecorder
}

/** For the smoke run: what the floats show and the status, without reaching into the windows. */
export interface VoiceProbe {
  float: FloatManager
  hud(): HudPayload
  launcher(): LauncherPayload
  status(): VoiceStatus
}

let probe: VoiceProbe | null = null

export function voiceProbe(): VoiceProbe | null {
  return probe
}

export function setupVoice(ctx: AppContext, deps: VoiceDeps): VoiceSetup {
  let blocked: 'microphone' | 'speech' = 'microphone'
  let lastStatus = ''
  // Under smoke the fake helper hears nothing: the checks queue words through voiceSmoke.
  const broker = ctx.smoke ? (): SpeechBroker => smokeVoiceBroker(deps.broker()) : deps.broker
  const rt: VoiceRuntime = {
    broker,
    masker: deps.masker,
    recorder: deps.recorder,
    recordingMeeting: () => {
      try {
        const status = deps.recorder().status()
        return RECORDING_STATES.has(status.state) ? status.meetingId : null
      } catch {
        return null
      }
    },
    noteBlocked: (code) => {
      blocked = code === 'speech-denied' ? 'speech' : 'microphone'
    },
    blockedPane: () => blocked,
    changed: () => {
      const s = status()
      const key = JSON.stringify(s)
      if (key === lastStatus) return
      lastStatus = key
      ctx.broadcast({ type: 'voice', status: s })
    },
  }

  const turns = new VoiceTurns(ctx, rt)
  const launcher = new QuickAsk(ctx, rt)

  function status(): VoiceStatus {
    const hud = turns.hud()
    return {
      enabled: ctx.settings.get().voice.holdToTalk,
      state: hud.state,
      target: hud.state === 'idle' ? null : hud.target,
      chatId: hud.chatId,
      queued: hud.queued,
      launcherOpen: launcher.isOpen,
      speaking: hud.state === 'speaking',
    }
  }

  // ── the chord ──
  const tracker = new ChordTracker<KeyContext>({
    start: (context, readAloud) => turns.start(context, readAloud),
    readAloud: () => turns.readAloud(),
    end: (_context, readAloud) => void turns.end(readAloud).catch((err: unknown) => log.warn('voice', 'turn failed', { error: errorMessage(err) })),
    tap: (context) => {
      const text = tapText(ctx.settings.get().voice.chord)
      if (text && !context.wc.isDestroyed()) void context.wc.insertText(text).catch(() => undefined)
    },
  })

  const isLauncherWindow = (id: number): boolean => ctx.float.window('launcher')?.webContents.id === id
  const removeInterceptor = shortcuts.addInputInterceptor(
    (input, wc, win) => {
      // Esc in any Atelier surface stops a reply being read aloud.
      if (input.type === 'keyDown' && input.key === 'Escape' && turns.stopSpeech()) return 'handled'
      // The launcher handles its own key (QuickAsk); a hold there would fight it.
      if (isLauncherWindow(wc.id)) return 'pass'
      const v = ctx.settings.get().voice
      if (!v.holdToTalk && tracker.phase === 'idle') return 'pass'
      return tracker.input(input, v.chord, v.readAloudModifier, { wc, win })
    },
    { priority: INTERCEPT_PRIORITY },
  )

  // ── the launcher's global shortcut ──
  const shortcut = new LauncherShortcut({
    backend: {
      register: (accelerator, fn) => globalShortcut.register(accelerator, fn),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    wanted: () => {
      const v = ctx.settings.get().voice
      return { on: v.launcher, accelerator: chordAccelerator(v.chord) }
    },
    atelierFocused: () => BrowserWindow.getFocusedWindow() !== null,
    onPress: () => launcher.toggle(),
    smoke: ctx.smoke,
    onChange: () => rt.changed(),
  })
  // Focus moves between Atelier windows blur one and focus the next: decide once both have run.
  let pending: NodeJS.Immediate | null = null
  const reconcile = (): void => {
    if (pending) return
    pending = setImmediate(() => {
      pending = null
      shortcut.reconcile()
    })
  }
  const onBlur = (): void => {
    tracker.blur()
    reconcile()
  }
  app.on('browser-window-focus', reconcile)
  app.on('browser-window-blur', onBlur)
  const onSettings = (next: ReturnType<typeof ctx.settings.get>, previous: ReturnType<typeof ctx.settings.get>): void => {
    const a = next.voice
    const b = previous.voice
    if (a.launcher !== b.launcher || a.chord !== b.chord) {
      // Turning the switch on while in Atelier tries the keys once, so Settings can show a conflict straight away.
      if (a.launcher) shortcut.probe()
      else shortcut.reconcile()
    }
    if (!a.holdToTalk && b.holdToTalk) tracker.blur()
    if (a.holdToTalk !== b.holdToTalk) rt.changed()
  }
  ctx.settings.on('changed', onSettings)
  if (app.isReady()) reconcile()
  else void app.whenReady().then(reconcile)

  probe = { float: ctx.float, hud: () => turns.hud(), launcher: () => launcher.payload(), status }

  return {
    services: {
      voice: {
        status,
        launcherToggle: () => launcher.toggle(),
        hudAction: (action) => turns.action(action),
        shortcutStatus: () => shortcut.status(),
      },
    },
    dispose: () => {
      removeInterceptor()
      app.off('browser-window-focus', reconcile)
      app.off('browser-window-blur', onBlur)
      ctx.settings.off('changed', onSettings)
      if (pending) clearImmediate(pending)
      shortcut.dispose()
      turns.dispose()
      launcher.dispose()
      probe = null
    },
  }
}
