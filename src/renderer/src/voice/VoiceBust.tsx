/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState, type CSSProperties, type ReactElement } from 'react'
import { accentTokens } from '@shared/accent'
import type { Companion as CompanionRecord, CompanionMood } from '@shared/companion'
import type { FloatEvent } from '@shared/float'
import { Companion } from '../companion/Companion'
import { floatApi, useFloatEvent } from '../float/api'

// The live 3D companion in the voice floats (DS-PRES): a bust at the live
// size, with no disc or frame, in the companion's own colours. The mood is
// fixed by the float's state (listening, thinking, talking while it reads).

/** At or above the live-figure minimum (LIVE_MIN_PX), so it renders in 3D rather than as a still. */
export const BUST_PX = 96

/** The active companion, kept current from the float's companion events. */
export function useFloatCompanion(): CompanionRecord | null {
  const [companion, setCompanion] = useState<CompanionRecord | null>(floatApi?.initial.companion ?? null)
  const onEvent = useCallback((e: FloatEvent) => {
    if (e.type === 'companion') setCompanion(e.companion)
  }, [])
  useFloatEvent(onEvent)
  return companion
}

/** Companion colour variables for both schemes; the float CSS picks one with light-dark(). */
export function companionColors(companion: CompanionRecord | null): CSSProperties {
  if (!companion) return {}
  const light = accentTokens(companion.look.colors.accent, 'light')
  const dark = accentTokens(companion.look.colors.accent, 'dark')
  return {
    '--voice-co-light': light.accent,
    '--voice-co-dark': dark.accent,
    '--voice-co-text-light': light.text,
    '--voice-co-text-dark': dark.text,
    '--voice-co-soft-light': light.soft,
    '--voice-co-soft-dark': dark.soft,
  } as CSSProperties
}

export function VoiceBust({ companion, mood, talkPulse }: { companion: CompanionRecord | null; mood: CompanionMood; talkPulse: number }): ReactElement {
  return (
    <div className="voice-bust" aria-hidden="true">
      {companion && <Companion profile={companion} mood={mood} talkPulse={talkPulse} size={BUST_PX} framing="bust" shadow={false} priority={10} />}
    </div>
  )
}
