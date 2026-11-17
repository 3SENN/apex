/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'

// Reading replies aloud (ST-16) with the system's speech synthesis: the chosen
// macOS voice, or the default one. Markdown is reduced to plain sentences
// first, and links to their text.

/** The spoken form of a Markdown reply. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function synth(): SpeechSynthesis | null {
  return typeof speechSynthesis === 'undefined' ? null : speechSynthesis
}

/** The system voices, kept current as macOS loads them. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth()?.getVoices() ?? [])
  useEffect(() => {
    const s = synth()
    if (!s) return
    const update = (): void => setVoices(s.getVoices())
    update()
    s.addEventListener('voiceschanged', update)
    return () => s.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

export interface SpeakHandlers {
  onStart?(): void
  onBoundary?(): void
  onEnd?(): void
  onError?(): void
}

/** Speaks `text`; the returned function stops it without calling any handler. */
export function speak(text: string, voiceName: string | null, handlers: SpeakHandlers = {}): () => void {
  const s = synth()
  if (!s || !text.trim()) {
    handlers.onError?.()
    return () => undefined
  }
  let live = true
  s.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = voiceName ? s.getVoices().find((v) => v.name === voiceName) : undefined
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  }
  utterance.onstart = () => live && handlers.onStart?.()
  utterance.onboundary = () => live && handlers.onBoundary?.()
  utterance.onend = () => live && handlers.onEnd?.()
  utterance.onerror = () => live && handlers.onError?.()
  s.speak(utterance)
  return () => {
    live = false
    s.cancel()
  }
}
