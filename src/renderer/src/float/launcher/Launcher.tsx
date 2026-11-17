/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import '../../voice/floatShim'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowUp, Image, Keyboard, Mic, Square, X } from 'lucide-react'
import type { CompanionMood } from '@shared/companion'
import { chordAccelerator, type LauncherPayload, type VoiceErrorCode } from '@shared/voice'
import { t, type MessageKey } from '../../i18n/useT'
import { formatShortcut } from '../../ui/logic/shortcut'
import { useMotion } from '../../ui/motion'
import { LevelBars } from '../../voice/LevelBars'
import { playTone, toneFor } from '../../voice/tones'
import { companionColors, useFloatCompanion, VoiceBust } from '../../voice/VoiceBust'
import { floatInvoke, useFloatPayload } from '../api'
import { nextRelay, type RelayState } from './presenceRelay'
import { LAUNCHER_PRESENCE } from '@shared/voice'

// The quick-ask launcher float (MV-02, MV-03): one input that shows the live
// words and then the final text to edit, the screenshot chip, talk, type,
// send and close, with key hints. Return sends, Esc closes, the launcher key
// stops listening (main handles that key).

const MOODS: Record<LauncherPayload['state'], CompanionMood> = {
  listening: 'listening',
  transcribing: 'thinking',
  typing: 'idle',
  sending: 'thinking',
  working: 'working',
  error: 'sad',
}

const FIXES: Partial<Record<VoiceErrorCode, MessageKey>> = {
  'mic-blocked': 'voice.fix.mic-blocked',
  'no-engine': 'voice.fix.no-engine',
  'another-recording': 'voice.fix.another-recording',
  'recording-failed': 'voice.fix.retry',
  'no-speech': 'voice.fix.retry',
  'mic-busy': 'voice.fix.retry',
  failed: 'voice.fix.retry',
}

function invoke(method: string, ...args: unknown[]): void {
  void floatInvoke(method, ...args).catch(() => undefined)
}

function joined(text: string, partial: string): string {
  return [text, partial].filter((s) => s.trim()).join(' ')
}

export function Launcher(): ReactElement | null {
  const payload = useFloatPayload<LauncherPayload>()
  const companion = useFloatCompanion()
  const { reduced } = useMotion()
  const input = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const previous = useRef<{ state: string; turn: number } | null>(null)
  // DS-68: typing, focus and send here reach the companions in every window, through main.
  const relayed = useRef<RelayState>({ signal: null, at: 0 })
  const relay = (event: Parameters<typeof nextRelay>[1]): void => {
    const now = Date.now()
    const signal = nextRelay(relayed.current, event, now)
    if (!signal) return
    relayed.current = { signal, at: now }
    invoke(LAUNCHER_PRESENCE, signal, companion?.id ?? null)
  }
  const mac = /Mac/i.test(navigator.platform)
  const state = payload?.state ?? 'listening'
  const turn = payload?.turn ?? 0

  // While the recogniser drives, the input follows it; once typing, the input is yours.
  useEffect(() => {
    if (!payload) return
    if (payload.state === 'listening' || payload.state === 'transcribing') setDraft(joined(payload.text, payload.partial))
  }, [payload?.text, payload?.partial, state])
  // The heard text can land in the same update as the switch to typing, or just after it.
  useEffect(() => {
    if (payload && (payload.state === 'typing' || payload.state === 'error')) setDraft((d) => d || payload.text)
  }, [state, payload?.text])

  // Each opening focuses the input; tones follow the state when sounds are on.
  useEffect(() => {
    input.current?.focus()
  }, [turn])
  useEffect(() => {
    if (!payload) return
    const before = previous.current && previous.current.turn === turn ? previous.current.state : null
    previous.current = { state, turn }
    const tone = toneFor(before, state)
    if (tone && payload.sounds) playTone(tone, reduced)
    if (state === 'typing') input.current?.focus()
  }, [state, turn])

  // The input grows with its text, up to the float's limit.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [draft])

  if (!payload) return null
  const p = payload
  const keys = formatShortcut(chordAccelerator(p.chord), mac)
  const busy = p.state === 'sending' || p.state === 'working'
  const canSend = !busy && draft.trim().length > 0
  const send = (): void => {
    if (!canSend) return
    relay({ kind: 'send' })
    invoke('launcher:submit', draft, p.attachScreenshot)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      invoke('launcher:dismiss')
    }
  }
  const status = (() => {
    switch (p.state) {
      case 'listening':
        return t('voice.launcher.listening')
      case 'transcribing':
        return t('voice.launcher.transcribing')
      case 'typing':
        return t('voice.launcher.typing')
      case 'sending':
        return t('voice.launcher.sending')
      case 'working':
        return t('voice.launcher.working')
      case 'error':
        return t(`voice.error.${p.error ?? 'failed'}` as MessageKey)
    }
  })()
  const fix = p.error ? FIXES[p.error] : undefined

  return (
    <div className="voice-float-pad">
      <div
        className={`float-card voice-launcher voice-launcher--${p.state}`}
        style={companionColors(companion)}
        role="dialog"
        aria-label={t('voice.launcher.label')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') invoke('launcher:dismiss')
        }}
      >
        <VoiceBust companion={companion} mood={MOODS[p.state]} talkPulse={0} />
        <div className="voice-launcher__main">
          <div className="voice-launcher__head">
            <p className={p.state === 'error' ? 'voice-launcher__status voice-launcher__status--error' : 'voice-launcher__status'} role={p.state === 'error' ? 'alert' : 'status'} aria-live="polite">
              {status}
            </p>
            {p.state === 'listening' && <LevelBars reduced={reduced} label={t('voice.launcher.listening')} />}
            <button type="button" className="voice-icon-button" aria-label={t('voice.launcher.close')} title={t('voice.launcher.close')} onClick={() => invoke('launcher:dismiss')}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <textarea
            ref={input}
            className={p.state === 'listening' || p.state === 'transcribing' ? 'voice-launcher__input voice-launcher__input--live' : 'voice-launcher__input'}
            rows={1}
            value={draft}
            placeholder={t('voice.launcher.placeholder')}
            aria-label={t('voice.launcher.placeholder')}
            readOnly={busy}
            onChange={(e) => {
              // Typing while it listens switches to typing; the words so far stay.
              if (p.state === 'listening' || p.state === 'transcribing') invoke('launcher:type')
              setDraft(e.target.value)
              relay({ kind: 'text', text: e.target.value })
            }}
            onFocus={(e) => relay({ kind: 'focus', text: e.currentTarget.value })}
            onBlur={() => relay({ kind: 'blur' })}
            onKeyDown={onKeyDown}
          />

          {fix && (
            <div className="voice-launcher__fix">
              <button type="button" className="float-button voice-hud__action--primary" onClick={() => invoke('launcher:fix')}>
                {t(fix)}
              </button>
            </div>
          )}

          <div className="voice-launcher__bar">
            {p.screenshot ? (
              <button
                type="button"
                className={p.attachScreenshot ? 'voice-chip voice-chip--on' : 'voice-chip'}
                aria-pressed={p.attachScreenshot}
                title={p.attachScreenshot ? t('voice.launcher.screenshotRemove') : t('voice.launcher.screenshotAdd')}
                onClick={() => invoke('launcher:screenshot', !p.attachScreenshot)}
                disabled={busy}
              >
                <img className="voice-chip__thumb" src={p.screenshot} alt="" />
                <span>{t('voice.launcher.screenshot')}</span>
                {p.attachScreenshot && <X size={12} aria-hidden="true" />}
              </button>
            ) : p.screenshotBlocked ? (
              // Main asks macOS the first time, then opens System Settings, or relaunches once it is on there.
              <button type="button" className="voice-chip" onClick={() => invoke('launcher:screenshot', true)} disabled={busy}>
                <Image size={13} aria-hidden="true" />
                <span>{p.screenshotRelaunch ? t('voice.launcher.screenshotRelaunch') : t('voice.launcher.screenshotBlocked')}</span>
              </button>
            ) : (
              <button type="button" className="voice-chip" onClick={() => invoke('launcher:screenshot', true)} disabled={busy}>
                <Image size={13} aria-hidden="true" />
                <span>{t('voice.launcher.screenshotAdd')}</span>
              </button>
            )}
            <span className="voice-launcher__spacer" />
            {p.state === 'listening' ? (
              <button type="button" className="voice-icon-button voice-icon-button--labelled" onClick={() => invoke('voice.launcherToggle')} aria-label={t('voice.launcher.stopListening')} title={t('voice.launcher.stopListening')}>
                <Square size={13} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="voice-icon-button voice-icon-button--labelled" onClick={() => invoke('launcher:listen')} disabled={busy} aria-label={t('voice.launcher.listen')} title={t('voice.launcher.listen')}>
                <Mic size={14} aria-hidden="true" />
              </button>
            )}
            {(p.state === 'listening' || p.state === 'transcribing') && (
              <button type="button" className="voice-icon-button voice-icon-button--labelled" onClick={() => invoke('launcher:type')} aria-label={t('voice.launcher.type')} title={t('voice.launcher.type')}>
                <Keyboard size={14} aria-hidden="true" />
              </button>
            )}
            <button type="button" className="voice-send" onClick={send} disabled={!canSend} aria-label={t('voice.launcher.send')} title={t('voice.launcher.send')}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </div>

          <p className="voice-launcher__hints" aria-hidden="true">
            <kbd className="voice-kbd">⏎</kbd> {t('voice.launcher.hintSend')}
            <span className="voice-launcher__dot">·</span>
            <kbd className="voice-kbd">esc</kbd> {t('voice.launcher.hintClose')}
            {p.state === 'listening' && (
              <>
                <span className="voice-launcher__dot">·</span>
                <kbd className="voice-kbd">{keys}</kbd> {t('voice.launcher.hintStop')}
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
