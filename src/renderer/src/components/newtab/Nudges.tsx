/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The new-tab nudges: at most one small, dismissible
// suggestion under the composer, picked from the getting-started checklist's
// unfinished automatic steps (shared/tips.ts's pickNudge). Dismissing hides
// it for good, everywhere, through guidance.
import { useEffect, useState, type ReactElement } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { FirstWeekView } from '@shared/firstWeek'
import { pickNudge, type Nudge } from '@shared/tips'
import { t } from '@shared/i18n/core'
import { companionUrl } from '@shared/url'
import { call, errorText, useAppEvent } from '../../api'
import { useActiveCompanion } from '../companionData'
import { IconButton, toast } from '../../ui'
import '../../guidance/guidance.css'

export function Nudges(): ReactElement | null {
  const active = useActiveCompanion()
  const [view, setView] = useState<FirstWeekView | null>(null)
  const [dismissed, setDismissed] = useState<string[] | null>(null)

  useEffect(() => {
    let live = true
    call('firstWeek', 'view').then((v) => live && setView(v), () => undefined)
    call('guidance', 'state').then((s) => live && setDismissed(s.dismissedNudges), () => live && setDismissed([]))
    return () => {
      live = false
    }
  }, [])
  useAppEvent('first-week', (e) => setView(e.view))
  useAppEvent('guidance', (e) => setDismissed(e.state.dismissedNudges))

  const nudge = dismissed ? pickNudge(view, dismissed, Date.now()) : null
  if (!nudge) return null

  const run = async (n: Nudge): Promise<void> => {
    try {
      if ('url' in n.action) await call('pages', 'open', n.action.url)
      else if (n.action.kind === 'companion') {
        if (active) await call('pages', 'open', companionUrl(active.id, 'general'))
      } else {
        setView(await call('firstWeek', 'makeDefaultBrowser'))
      }
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }
  const dismiss = (id: string): void => {
    setDismissed((d) => [...(d ?? []), id])
    void call('guidance', 'dismissNudge', id).catch(() => undefined)
  }

  return (
    <div className="gd-nudge" role="note" aria-label={t('firstRun.nudges.label')}>
      <Sparkles className="gd-nudge__icon" aria-hidden />
      <span className="gd-nudge__text">{nudge.text}</span>
      <button type="button" className="gd-nudge__action" onClick={() => void run(nudge)}>
        {nudge.action.label}
      </button>
      <IconButton label={t('firstRun.nudges.dismiss')} icon={<X />} variant="subtle" size="sm" onClick={() => dismiss(nudge.id)} />
    </div>
  )
}
