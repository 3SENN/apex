/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import {
  NO_SECOND_LOCALE,
  PRIVACY_PANES,
  WINDOWS_PRIVACY_PANES,
  SpeechError,
  encodeSpeechError,
  samePermissions,
  transcriptionReady,
  type SpeechBroker,
  type SpeechPermissions,
  type SpeechPurpose,
  type SpeechServices,
  type SpeechSession,
} from '@shared/speech'
import type { AppContext } from '../features/types'
import { captureSpeechExit } from '../diagnostics/capture'
import { log } from '../log'
import { appRoot } from '../resources'
import { calendarSource, desktopCallsSupported } from '../meetings/capture'
import { createSpeechBroker, type SpeechBrokerHost } from './broker'
import { createSmokeSpeechHelper, smokeSpeechPermissions } from './fake'
import { fakeM4a } from './fakeAudio'
import { HelperLink, speechHelperPath } from './helper'
import { createMicTest } from './micTest'
import { createScreenAccess, screenPromptFile, setScreenAccess } from './screenAccess'

// The speech domain's entry point: the protocol v2 broker over
// the atelier-speech helper (the scripted fake under ATELIER_SMOKE, so the smoke
// run never records or prompts), the permission report that drives the
// getting-started signal, and the speech and transcription services.

export interface SpeechSetup {
  broker: SpeechBroker
  services: SpeechServices
  dispose(): void
}

/** Purposes whose events the chrome draws itself: dictation, the level test and the meeting live row. */
const CHROME_PURPOSES: ReadonlySet<SpeechPurpose> = new Set(['dictation', 'level-test', 'meeting'])

/** Defaults for Reset on Settings › Transcription: the mic, sensitivities and languages. */
export const CAPTURE_DEFAULTS = { mic: 'built-in', micSensitivity: 1, systemSensitivity: 1, locale: null, secondaryLocale: NO_SECOND_LOCALE } as const

/** IPC only carries an error's message, so a SpeechError crosses tagged with its code (decodeSpeechError reads it). */
function tagged<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const wrap = (err: unknown): never => {
    throw err instanceof SpeechError ? new Error(encodeSpeechError(err)) : err
  }
  return (...args: A): R => {
    try {
      const out = fn(...args)
      return (out instanceof Promise ? out.catch(wrap) : out) as R
    } catch (err) {
      return wrap(err)
    }
  }
}

function createLink(ctx: AppContext): HelperLink {
  const link = ctx.smoke
    ? new HelperLink({ path: 'atelier-speech (smoke)', assumeExists: true, spawn: createSmokeSpeechHelper(fakeM4a), handshakeMs: 2_000 })
    : new HelperLink({ path: speechHelperPath({ platform: process.platform, packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot() }) })
  // DG-02: every helper exit goes to the diagnostics log, flagged when Atelier didn't ask for it.
  link.on('exit', (code, expected) => captureSpeechExit(code, expected))
  return link
}

/** Main's own Screen Recording check (it never prompts). */
function mainScreenGranted(): boolean {
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    return false
  }
}

export function setupSpeech(ctx: AppContext): SpeechSetup {
  const dir = join(ctx.dataDir, 'speech')
  const screenPrompt = screenPromptFile(join(dir, 'screen-access.json'))
  const platform = ctx.smoke ? 'darwin' : process.platform
  const broker: SpeechBrokerHost = createSpeechBroker({
    link: createLink(ctx),
    platform,
    settings: () => ctx.settings.get().transcription,
    screenPrompt,
    preferredLanguages: () => (ctx.smoke ? [] : app.getPreferredSystemLanguages()),
  })
  const screen = createScreenAccess({
    platform,
    // The smoke run's fake helper decides for both, so the real Mac's grant never shows through.
    mainGranted: () => (ctx.smoke ? smokeSpeechPermissions.current.screen === 'granted' : mainScreenGranted()),
    helperScreen: async () => (await broker.permissions()).screen,
    requestScreen: async () => {
      try {
        return (await broker.request('screen')).screen
      } catch (err) {
        // No helper (a build without it): a first capture is what makes macOS ask.
        if (!ctx.smoke) await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined)
        throw err
      }
    },
    prompt: screenPrompt,
    relaunch: () => {
      if (ctx.smoke) return
      // A normal quit (not app.exit), so tabs, history and a running meeting are saved on the way.
      app.relaunch()
      app.quit()
    },
  })
  setScreenAccess(screen)
  const test = createMicTest({
    broker,
    dir,
    systemAudio: async () => (await broker.permissions()).screen === 'granted',
  })
  const dictations = new Map<string, SpeechSession>()

  // The report reaches the chrome when it changes; microphone plus speech is the getting-started signal.
  let reported: SpeechPermissions | null = null
  const offPermissions = broker.onPermissions((p) => {
    if (!samePermissions(reported, p)) {
      reported = p
      ctx.broadcast({ type: 'speech-permissions', permissions: p })
    }
    if (transcriptionReady(p)) ctx.signal('transcription-ready')
  })
  const offStatus = broker.onStatus((status) => ctx.broadcast({ type: 'speech-status', status }))
  const offSessions = broker.onSession((session) => {
    if (!CHROME_PURPOSES.has(session.purpose)) return
    session.on((event) => ctx.broadcast({ type: 'speech-session', id: session.id, purpose: session.purpose, event }))
  })
  const offLines = broker.onLine((line) => {
    if (line.type === 'error' && !line.session) log.warn('speech', 'helper error', { code: line.code })
    // Transcription engine: which of Apple's engines listened, for diagnostics.
    if (line.type === 'started') log.info('speech', 'session started', { mode: line.mode, engine: line.engine ?? 'recognizer', onDevice: line.onDevice })
  })
  // Transcription engine: model progress reaches Settings › Transcription.
  const offAssets = broker.onAssets((assets) => {
    ctx.broadcast({ type: 'speech-assets', assets })
    if (assets.state === 'failed') log.warn('speech', 'language model install failed', { locale: assets.locale })
  })

  const services: SpeechServices = {
    speech: {
      status: () => broker.status(),
      permissions: tagged(() => broker.permissions()),
      request: tagged((kind) => broker.request(kind)),
      openPrivacySettings: (kind) => {
        // The smoke run never leaves Atelier.
        if (ctx.smoke) return
        const pane = process.platform === 'darwin' ? PRIVACY_PANES[kind] : process.platform === 'win32' ? WINDOWS_PRIVACY_PANES[kind] : null
        if (pane) void shell.openExternal(pane)
      },
      screenAccess: () => screen.status(),
      requestScreen: () => screen.request(),
      relaunch: () => screen.relaunch(),
      devices: tagged(() => broker.devices()),
      locales: tagged(() => broker.locales()),
      startDictation: tagged(async () => {
        const session = await broker.begin({ purpose: 'dictation', mode: 'dictation', levels: true })
        dictations.set(session.id, session)
        session.on((e) => {
          if (e.type === 'stopped' || (e.type === 'error' && e.fatal)) dictations.delete(session.id)
        })
        return session.id
      }),
      stop: tagged(async (sessionId) => {
        const session = dictations.get(sessionId)
        if (!session) return
        dictations.delete(sessionId)
        await session.stop()
      }),
      cancel: (sessionId) => {
        dictations.get(sessionId)?.cancel()
        dictations.delete(sessionId)
      },
    },
    transcription: {
      testStart: tagged(async () => {
        await test.start()
      }),
      testStop: tagged(() => test.stop()),
      testInfo: () => test.info(),
      testDelete: () => {
        if (test.running()) return
        test.remove()
      },
      resetCapture: () => {
        ctx.settings.update({ transcription: { ...CAPTURE_DEFAULTS } })
      },
      calendarAvailable: () => calendarSource() !== null,
      desktopCalls: () => ({ supported: desktopCallsSupported() }),
      assets: tagged(() => broker.assets()),
      prepareAssets: tagged(() => broker.assets({ install: true })),
    },
  }

  return {
    broker,
    services,
    dispose: () => {
      setScreenAccess(null)
      offPermissions()
      offStatus()
      offSessions()
      offLines()
      offAssets()
      for (const session of dictations.values()) session.cancel()
      dictations.clear()
      test.dispose()
      broker.dispose()
    },
  }
}
