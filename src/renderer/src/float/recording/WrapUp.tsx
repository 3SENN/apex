/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, FileAudio, FileText, TriangleAlert, X } from 'lucide-react'
import type { Companion } from '@shared/companion'
import type { FloatEvent } from '@shared/float'
import type { WrapUp, WrapUpAction } from '@shared/meetingCapture'
import { FaceAvatar } from '../../companion/FaceAvatar'
import { t } from '../../i18n/useT'
import { isWindows } from '../../system/platform'
import { Button, IconButton } from '../../ui/Button'
import { Spinner } from '../../ui/indicators'
import { floatApi, floatInvoke, useFloatEvent } from '../api'

// The wrap-up (MV-11): the widget, grown into a card once a recording stops.
// Processing first; then discuss the meeting with a chosen companion (the
// chat starts through meetings.discuss with the meeting attached), view the
// summary, open Meetings, or dismiss. With no engine ready it says the
// transcript is saved and the summary follows. A meeting recorded as audio
// only says the recording is saved (and why, when Atelier couldn't transcribe
// it) and opens it; there is nothing to discuss yet.

function useCompanions(enabled: boolean): { list: Companion[]; active: Companion | null } {
  const [active, setActive] = useState<Companion | null>(floatApi?.initial.companion ?? null)
  const [list, setList] = useState<Companion[]>([])
  useFloatEvent(
    useRef((e: FloatEvent) => {
      if (e.type === 'companion') setActive(e.companion)
    }).current,
  )
  useEffect(() => {
    if (!enabled) return
    let live = true
    floatInvoke<Companion[]>('companions.list')
      .then((all) => {
        if (live) setList(all.filter((c) => !c.hidden))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [enabled, active?.id])
  return { list, active: active && !active.hidden ? active : (list[0] ?? null) }
}

export function WrapUpCard({ wrapUp }: { wrapUp: WrapUp }): ReactElement {
  const audioOnly = wrapUp.audioOnly ?? null
  // Discussing needs a transcript.
  const ready = wrapUp.phase === 'ready' && !audioOnly
  const { list, active } = useCompanions(ready)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const chooser = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBusy(null)
    setError(null)
  }, [wrapUp.phase, wrapUp.meetingId])
  useEffect(() => {
    if (picking) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [picking])

  const act = (action: WrapUpAction): void => {
    if (busy) return
    setBusy(action)
    floatInvoke('wrapup:action', action).catch(() => {
      setBusy(null)
      setError(t('capture.card.error'))
    })
  }

  const discuss = (companion: Companion | null): void => {
    if (busy) return
    setPicking(false)
    setBusy('discuss')
    setError(null)
    floatInvoke<string>('meetings.discuss', wrapUp.meetingId, ...(companion ? [companion.id] : []))
      .then((chatId) => floatInvoke('wrapup:action', 'discuss', chatId))
      .catch(() => {
        setBusy(null)
        setError(t('capture.wrap.discussFailed'))
      })
  }

  let heading: string
  let body: string | null = null
  if (audioOnly) {
    heading = wrapUp.phase === 'failed' ? t('capture.wrap.recordingFailed') : wrapUp.phase === 'ready' ? t('capture.wrap.recordingSaved') : t('capture.wrap.saving')
    if (wrapUp.phase === 'failed') body = t('capture.wrap.recordingFailedBody')
    else if (wrapUp.phase === 'ready' && audioOnly === 'speech-denied') body = t((isWindows() ? 'capture.wrap.recordingSavedSpeech.win' : 'capture.wrap.recordingSavedSpeech'))
    else if (wrapUp.phase === 'ready' && audioOnly === 'locale-unsupported') body = t((isWindows() ? 'capture.wrap.recordingSavedLocale.win' : 'capture.wrap.recordingSavedLocale'))
  } else {
    switch (wrapUp.phase) {
      case 'processing':
        heading = t('capture.wrap.processing')
        body = t('capture.wrap.processingBody')
        break
      case 'ready':
        heading = wrapUp.summarized ? t('capture.wrap.ready') : t('capture.wrap.transcriptSaved')
        break
      case 'no-engine':
        heading = t('capture.wrap.noEngine')
        body = t('capture.wrap.noEngineBody')
        break
      case 'failed':
        heading = t('capture.wrap.failed')
        body = t('capture.wrap.failedBody')
        break
    }
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setPicking(false)
      chooser.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && !picking) {
      e.preventDefault()
      act('dismiss')
    }
  }

  const others = list.filter((c) => c.id !== active?.id)
  const view = audioOnly ? t('capture.wrap.openRecording') : wrapUp.summarized ? t('capture.wrap.viewSummary') : t('capture.wrap.viewTranscript')

  return (
    <section className="float-card wu" data-phase={wrapUp.phase} role="dialog" aria-labelledby="wu-title" aria-describedby="wu-heading" onKeyDown={onKeyDown}>
      <header className="wu-head">
        <span className="wu-glyph" aria-hidden="true">
          {wrapUp.phase === 'processing' ? <Spinner size={14} /> : wrapUp.phase === 'failed' ? <TriangleAlert size={15} /> : audioOnly ? <FileAudio size={15} /> : <FileText size={15} />}
        </span>
        <div className="wu-titles">
          <h1 id="wu-title" className="wu-title">
            {wrapUp.title}
          </h1>
          <p id="wu-heading" className="wu-heading" role="status">
            {heading}
          </p>
        </div>
        <IconButton size="sm" label={t('capture.wrap.dismiss')} icon={<X size={16} />} disabled={busy !== null} onClick={() => act('dismiss')} />
      </header>
      {body && !picking && <p className="wu-body">{body}</p>}
      {error && (
        <p className="mc-error" role="alert">
          {error}
        </p>
      )}
      {ready && active && (
        <div className="wu-discuss">
          <Button
            size="sm"
            variant="primary"
            className="wu-discuss__main"
            loading={busy === 'discuss'}
            disabled={busy !== null && busy !== 'discuss'}
            icon={<FaceAvatar look={active.look} name={active.name} label="" size={18} mark={null} />}
            onClick={() => discuss(active)}
          >
            {t('capture.wrap.discussWith', { name: active.name })}
          </Button>
          {others.length > 0 && (
            <IconButton
              ref={chooser}
              size="sm"
              variant="subtle"
              label={t('capture.wrap.chooseCompanion')}
              icon={<ChevronDown size={14} />}
              aria-haspopup="menu"
              aria-expanded={picking}
              disabled={busy !== null}
              onClick={() => setPicking((open) => !open)}
            />
          )}
        </div>
      )}
      {picking && (
        <div ref={menu} className="mc-menu wu-picker" role="menu" aria-label={t('capture.wrap.chooseCompanion')} onKeyDown={onMenuKey}>
          {others.map((c) => (
            <button key={c.id} type="button" role="menuitem" className="mc-menu__item wu-picker__item" onClick={() => discuss(c)}>
              <FaceAvatar look={c.look} name={c.name} label="" size={20} mark={null} />
              <span>{t('capture.wrap.discussWith', { name: c.name })}</span>
            </button>
          ))}
        </div>
      )}
      {/* The picker takes the actions' place, so the card stays inside its 240 px. */}
      <div className="mc-actions" hidden={picking}>
        {wrapUp.phase !== 'failed' && (
          <Button size="sm" variant={ready && active ? 'secondary' : 'primary'} loading={busy === 'view-summary'} disabled={busy !== null && busy !== 'view-summary'} onClick={() => act('view-summary')}>
            {view}
          </Button>
        )}
        <Button size="sm" variant={wrapUp.phase === 'failed' ? 'primary' : 'ghost'} loading={busy === 'open-meetings'} disabled={busy !== null && busy !== 'open-meetings'} onClick={() => act('open-meetings')}>
          {t('capture.wrap.openMeetings')}
        </Button>
      </div>
    </section>
  )
}
