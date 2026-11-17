/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Lightbulb, X } from 'lucide-react'
import { tipsFor, type Tip } from '@shared/tips'
import { apex, call } from '../api'
import { useT } from '../i18n/useT'
import { IconButton, cx } from '../ui'
import { useSettingsView } from './hooks'
import { pickTip, tipBlocked } from './logic/tips'
import type { ChatState } from './store'
import './chatTools.css'

// CH-29: one tip under the live status while a run lasts, from the tips catalogue.

let dismissed: string[] = []
let loaded = false
const listeners = new Set<() => void>()

function loadGuidance(): void {
  if (loaded) return
  loaded = true
  void call('guidance', 'state').then(
    (state) => {
      dismissed = state.dismissedTips
      for (const l of listeners) l()
    },
    () => undefined,
  )
  apex.onAppEvent((event) => {
    if (event.type !== 'guidance') return
    dismissed = event.state.dismissedTips
    for (const l of listeners) l()
  })
}

/** Hides a tip at once; guidance remembers it for good. */
function dismissTip(id: string): void {
  dismissed = [...dismissed, id]
  for (const l of listeners) l()
  void call('guidance', 'dismissTip', id).catch(() => undefined)
}

function useDismissedTips(): string[] {
  const [, bump] = useState(0)
  useEffect(() => {
    loadGuidance()
    const listener = (): void => bump((n) => n + 1)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
  return dismissed
}

/** The tips catalogue for a working chat; nothing when it can't be read. */
function workingTips(features: Record<string, boolean>): Tip[] {
  try {
    return tipsFor('chat-working', features)
  } catch {
    return []
  }
}

export function WorkingTip({ state }: { state: ChatState }): ReactElement | null {
  const t = useT()
  const settings = useSettingsView()
  const hidden = useDismissedTips()
  const [now, setNow] = useState(() => Date.now())
  const features = useMemo(() => ({ memory: state.setup?.memory ?? false, browser: state.setup?.browser ?? false, webTools: state.setup?.webTools ?? false }), [state.setup?.memory, state.setup?.browser, state.setup?.webTools])
  const tips = useMemo(() => workingTips(features), [features])
  // Never over a request card or an error.
  const blocked = tipBlocked(state.log.items, state.log.status)
  const { tip, changesIn } = pickTip({ runStartedAt: state.runStartedAt, now, enabled: settings.chatTips !== false, blocked, tips, dismissed: hidden })
  useEffect(() => {
    if (changesIn === null) return
    const timer = setTimeout(() => setNow(Date.now()), changesIn + 16)
    return () => clearTimeout(timer)
  }, [changesIn, tip?.id])
  if (!tip) return null
  return (
    <p className={cx('cd-tip')} role="note" aria-live="polite" key={tip.id}>
      <Lightbulb size={13} aria-hidden="true" className="cd-tip__icon" />
      <span className="ui-sr-only">{t('chatTools.tip.label')}: </span>
      <span className="cd-tip__text">{tip.text}</span>
      {tip.link && (
        <button type="button" className="cd-tip__link" onClick={() => void call('pages', 'open', tip.link?.url ?? 'apex://guides').catch(() => undefined)}>{tip.link.label}</button>
      )}
      <IconButton size="sm" label={t('chatTools.tip.dismiss')} icon={<X />} className="cd-tip__close" onClick={() => dismissTip(tip.id)} />
    </p>
  )
}
