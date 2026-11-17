/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import '../../voice/floatShim'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowRightLeft, Copy, MessageSquare, Square, Volume2, X } from 'lucide-react'
import type { CompanionMood } from '@shared/companion'
import { HUD_SPEECH, chordAccelerator, type HudAction, type HudPayload, type VoiceState } from '@shared/voice'
import { t, type MessageKey } from '../../i18n/useT'
import { formatShortcut } from '../../ui/logic/shortcut'
import { useMotion } from '../../ui/motion'
import { LevelBars } from '../../voice/LevelBars'
import { LightMarkdown } from '../../voice/LightMarkdown'
import { plainText, speak } from '../../voice/speak'
import { playTone, toneFor } from '../../voice/tones'
import { companionColors, useFloatCompanion, VoiceBust } from '../../voice/VoiceBust'
import { floatInvoke, useFloatPayload } from '../api'

// The voice HUD float (MV-04, DS-PRES): the live companion bust, the
// transcript in settled and still-changing parts, the reply preview, errors
// with their actions, the queue, and a countdown ring that closes it unless
// the pointer is over it. It never takes focus, so keys stay in Atelier: hold
// the keys again to reply, Esc stops the reading.

const THINKING_WORDS: MessageKey[] = ['voice.hud.thinking.0', 'voice.hud.thinking.1', 'voice.hud.thinking.2', 'voice.hud.thinking.3']
const THINKING_STEP_MS = 1800

const MOODS: Record<VoiceState, CompanionMood> = {
  idle: 'idle',
  listening: 'listening',
  transcribing: 'thinking',
  thinking: 'thinking',
  answered: 'happy',
  speaking: 'talking',
  error: 'sad',
}

const FIXES: Partial<Record<string, MessageKey>> = {
  'mic-blocked': 'voice.fix.mic-blocked',
  'no-engine': 'voice.fix.no-engine',
  'another-recording': 'voice.fix.another-recording',
}

/** A screenshot notice's way back: ask or open the pane, or relaunch once it's on. */
const NOTICE_FIXES: Partial<Record<string, MessageKey>> = {
  'screen-missing': 'voice.fix.screen-missing',
  'screen-relaunch': 'voice.settings.relaunch',
}

function act(action: HudAction): void {
  void floatInvoke('voice.hudAction', action).catch(() => undefined)
}

function keysText(chord: HudPayload['chord'], mac: boolean): string {
  return formatShortcut(chordAccelerator(chord), mac)
}

export function VoiceHud(): ReactElement | null {
  const payload = useFloatPayload<HudPayload>()
  const companion = useFloatCompanion()
  const { reduced } = useMotion()
  const [word, setWord] = useState(0)
  const [talk, setTalk] = useState(0)
  const previous = useRef<{ state: string; turn: number } | null>(null)
  const mac = /Mac/i.test(navigator.platform)
  const state = payload?.state ?? 'idle'
  const turn = payload?.turn ?? 0

  // Tones on each change of state, when the sounds switch is on.
  useEffect(() => {
    if (!payload) return
    const before = previous.current && previous.current.turn === turn ? previous.current.state : null
    previous.current = { state, turn }
    const tone = toneFor(before, state)
    if (tone && payload.sounds) playTone(tone, reduced)
  }, [state, turn])

  // Rotating status words while it thinks.
  useEffect(() => {
    if (state !== 'thinking') return
    setWord(0)
    const timer = setInterval(() => setWord((w) => (w + 1) % THINKING_WORDS.length), THINKING_STEP_MS)
    return () => clearInterval(timer)
  }, [state, turn])

  // Reading aloud: speaks while the state is 'speaking'; any other state stops it.
  const answerText = payload?.answer?.markdown ?? ''
  useEffect(() => {
    if (state !== 'speaking' || !payload) return
    const report = (event: 'started' | 'boundary' | 'ended' | 'failed'): void => void floatInvoke(HUD_SPEECH, event).catch(() => undefined)
    return speak(plainText(answerText), payload.voiceName, {
      onStart: () => report('started'),
      onBoundary: () => setTalk((n) => n + 1),
      onEnd: () => report('ended'),
      onError: () => report('failed'),
    })
  }, [state, turn])

  if (!payload || state === 'idle') return null
  const p = payload
  const name = companion?.name ?? t('voice.hud.companion')
  const keys = keysText(p.chord, mac)

  const status = (() => {
    switch (p.state) {
      case 'listening':
        return p.target === 'field' ? t('voice.hud.listeningField') : t('voice.hud.listeningCompanion', { name })
      case 'transcribing':
        return t('voice.hud.transcribing')
      case 'thinking':
        if (p.target === 'field') return t('voice.hud.rewriting')
        return p.waiting ? t('voice.hud.waiting') : t(THINKING_WORDS[word] ?? 'voice.hud.thinking.0')
      case 'answered':
        if (p.target === 'field') return t(p.inserted === 'rewritten' ? 'voice.hud.rewritten' : 'voice.hud.typed')
        return t('voice.hud.answered', { name })
      case 'speaking':
        return t('voice.hud.speaking')
      case 'error':
        return t(`voice.error.${p.error?.code ?? 'failed'}` as MessageKey)
      default:
        return ''
    }
  })()

  const heard = p.state === 'listening' || p.state === 'transcribing' || (p.target === 'field' && p.state !== 'error') || (p.state === 'thinking' && !p.answer?.markdown)
  const fix = p.error ? FIXES[p.error.code] : p.notice && p.target === 'companion' ? NOTICE_FIXES[p.notice] : undefined
  const canSwitch = p.state === 'listening' || p.state === 'transcribing'
  const canRescue = p.state === 'error' && Boolean(p.error?.text) && (p.error?.code === 'no-field' || p.error?.code === 'insert-failed')
  const ringKey = `${p.turn}:${p.state}:${p.countdownMs ?? 'none'}`

  return (
    <div className="voice-float-pad">
      <div
        className={`float-card voice-hud voice-hud--${p.state}`}
        style={companionColors(companion)}
        role="region"
        aria-label={t('voice.hud.region')}
        onMouseEnter={() => act('hover-start')}
        onMouseLeave={() => act('hover-end')}
      >
        <VoiceBust companion={companion} mood={MOODS[p.state]} talkPulse={talk} />
        <div className="voice-hud__body">
          <div className="voice-hud__head">
            <p className={p.state === 'error' ? 'voice-hud__status voice-hud__status--error' : 'voice-hud__status'} role={p.state === 'error' ? 'alert' : 'status'} aria-live="polite">
              {status}
            </p>
            {p.state === 'listening' && <LevelBars reduced={reduced} label={t('voice.hud.listening')} />}
            <button type="button" className="voice-icon-button voice-hud__close" aria-label={t('voice.hud.dismiss')} title={t('voice.hud.dismiss')} onClick={() => act('dismiss')}>
              {p.countdownMs !== null && (
                <svg key={ringKey} className={reduced ? 'voice-ring voice-ring--still' : 'voice-ring'} viewBox="0 0 28 28" aria-hidden="true" style={{ animationDuration: `${p.countdownMs}ms` }}>
                  <circle cx="14" cy="14" r="12.5" pathLength="100" />
                </svg>
              )}
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {heard && (p.settled || p.live) && (
            <p className="voice-hud__transcript">
              <span className="voice-hud__settled">{p.settled}</span>
              {p.live && <span className="voice-hud__live">{p.settled ? ' ' : ''}{p.live}</span>}
            </p>
          )}

          {p.target === 'companion' && p.answer?.markdown && (p.state === 'thinking' || p.state === 'answered' || p.state === 'speaking') && (
            <div className="voice-hud__answer" aria-live="polite">
              <LightMarkdown markdown={p.answer.markdown} />
              {p.answer.citations.length > 0 && (
                <ul className="voice-hud__sources" aria-label={t('voice.hud.sources')}>
                  {p.answer.citations.map((c) => (
                    <li key={c.url} className="voice-hud__source" title={c.url}>
                      {c.title || hostOf(c.url)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {p.state === 'error' && p.error?.text && <p className="voice-hud__transcript voice-hud__transcript--quoted">{p.error.text}</p>}
          {p.notice && p.target === 'companion' && p.state !== 'error' && <p className="voice-hud__notice">{t(`voice.hud.notice.${p.notice}` as MessageKey)}</p>}

          {p.queued > 0 && p.state === 'thinking' && (
            <p className="voice-hud__queue">
              <span>{t('voice.hud.queued', { count: p.queued })}</span>
              <button type="button" className="voice-link-button" onClick={() => act('cancel-queued')}>
                {t('voice.hud.cancelQueued')}
              </button>
            </p>
          )}

          <div className="voice-hud__actions">
            {canSwitch && (
              <button type="button" className="float-button voice-hud__action" onClick={() => act('switch-target')}>
                <ArrowRightLeft size={13} aria-hidden="true" />
                {p.target === 'field' ? t('voice.hud.toCompanion', { name }) : t('voice.hud.toField')}
              </button>
            )}
            {fix && (
              <button type="button" className="float-button voice-hud__action voice-hud__action--primary" onClick={() => act('fix')}>
                {t(fix)}
              </button>
            )}
            {canRescue && (
              <>
                <button type="button" className="float-button voice-hud__action" onClick={() => act('switch-target')}>
                  <ArrowRightLeft size={13} aria-hidden="true" />
                  {t('voice.hud.toCompanion', { name })}
                </button>
                <button type="button" className="float-button voice-hud__action" onClick={() => act('copy')}>
                  <Copy size={13} aria-hidden="true" />
                  {t('voice.hud.copy')}
                </button>
              </>
            )}
            {p.target === 'companion' && p.chatId && (p.state === 'thinking' || p.state === 'answered' || p.state === 'speaking') && (
              <button type="button" className="float-button voice-hud__action" onClick={() => act('open-chat')}>
                <MessageSquare size={13} aria-hidden="true" />
                {t('voice.hud.openChat')}
              </button>
            )}
            {p.state === 'answered' && p.target === 'companion' && p.answer?.markdown && (
              <button type="button" className="float-button voice-hud__action" onClick={() => act('read-aloud')}>
                <Volume2 size={13} aria-hidden="true" />
                {p.readAloud ? t('voice.hud.readAgain') : t('voice.hud.readAloud')}
              </button>
            )}
            {p.state === 'speaking' && (
              <button type="button" className="float-button voice-hud__action" onClick={() => void floatInvoke(HUD_SPEECH, 'ended').catch(() => undefined)}>
                <Square size={12} aria-hidden="true" />
                {t('voice.hud.stopReading')}
              </button>
            )}
          </div>

          {(p.state === 'answered' || p.state === 'speaking') && (
            <p className="voice-hud__hint">{p.target === 'companion' ? t('voice.hud.hint', { keys }) : t('voice.hud.hintAgain', { keys })}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
