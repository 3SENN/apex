/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SpeechBroker, SpeechSession, SpeechSessionEvent } from '@shared/speech'

// Under ATELIER_SMOKE the fake speech helper hears nothing, so the voice smoke
// checks queue the words a hold or the launcher "says" here. Only voice's own
// sessions (voice-command and launcher) are wrapped; meetings and dictation
// elsewhere see the broker unchanged.

const phrases: string[] = []

/** Words the next voice session hears, as a partial and then a final. */
export const voiceSmoke = {
  say(text: string): void {
    phrases.push(text)
  },
  clear(): void {
    phrases.length = 0
  },
}

/** How long after a listener attaches the queued words arrive, like a recogniser's first result. */
const HEAR_MS = 60

function hearing(session: SpeechSession, text: string): SpeechSession {
  let heard = false
  return {
    id: session.id,
    purpose: session.purpose,
    on(fn: (e: SpeechSessionEvent) => void) {
      const off = session.on(fn)
      if (!heard) {
        heard = true
        setTimeout(() => {
          fn({ type: 'partial', source: 'mic', text, startMs: 0, endMs: 400 })
          fn({ type: 'final', source: 'mic', text, startMs: 0, endMs: 800 })
        }, HEAR_MS)
      }
      return off
    },
    stop: () => session.stop(),
    pause: () => session.pause(),
    resume: () => session.resume(),
    cancel: () => session.cancel(),
  }
}

/** The broker voice uses under smoke: begin() hands queued words to voice's sessions. */
export function smokeVoiceBroker(broker: SpeechBroker): SpeechBroker {
  return new Proxy(broker, {
    get(target, prop) {
      if (prop === 'begin') {
        return async (options: Parameters<SpeechBroker['begin']>[0]) => {
          const session = await target.begin(options)
          const voice = options.purpose === 'voice-command' || options.purpose === 'launcher'
          const text = voice ? phrases.shift() : undefined
          return text ? hearing(session, text) : session
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
