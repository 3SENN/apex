/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import { X } from 'lucide-react'
import { apex, call, errorText } from '../../api'
import { t } from '../../i18n/useT'
import { toast } from '../../ui'
import { cardHost } from '../sidebar/cardContent'
import { TabIcon } from '../sidebar/util'
import { chooserTabs } from './logic'

// The empty pane's chooser (SH-42): a split side showing a blank page lists
// this window's tabs that aren't already showing, most recent first, plus
// Close pane. Choosing one shows it there and the blank tab goes.

export function SplitChooser({ snapshot, paneTabId }: { snapshot: TabsSnapshot; paneTabId: string }): ReactElement {
  const tabs = chooserTabs(snapshot)
  const choose = (tab: TabInfo): void => void call('split', 'choose', tab.id).catch((err: unknown) => toast.show({ message: t('tabs.error.action', { what: t('tabs.error.split'), reason: errorText(err) }), tone: 'error' }))
  const closePane = (): void => {
    const split = snapshot.split
    if (!split) return
    void call('split', 'closeSide', split.primaryId === paneTabId ? 'left' : 'right').catch(() => apex.tabs.close(paneTabId))
  }
  return (
    <div className="split-chooser" role="dialog" aria-labelledby="split-chooser-title">
      <h2 id="split-chooser-title" className="split-chooser__title">
        {t('tabs.split.chooser.title')}
      </h2>
      {tabs.length === 0 ? (
        <p className="split-chooser__empty">{t('tabs.split.chooser.allVisible')}</p>
      ) : (
        <ul className="split-chooser__list" role="listbox" aria-labelledby="split-chooser-title">
          {tabs.map((tab, i) => (
            <li key={tab.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="split-chooser__row"
                autoFocus={i === 0}
                onClick={() => choose(tab)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                  e.preventDefault()
                  const row = e.currentTarget.closest('li')
                  const next = (e.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling)?.querySelector<HTMLButtonElement>('button')
                  next?.focus()
                }}
              >
                <span className="split-chooser__icon">
                  <TabIcon tab={tab} />
                </span>
                <span className="split-chooser__name">{tab.title || t('tabs.card.newTab')}</span>
                <span className="split-chooser__host">{cardHost(tab.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="split-chooser__close" onClick={closePane}>
        <X size={14} aria-hidden />
        {t('tabs.split.chooser.closePane')}
      </button>
    </div>
  )
}
