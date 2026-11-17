/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import type { ChatSort, SettingsPatch, SidebarOptions, TabSort } from '@shared/ipc'
import { DESTINATIONS, type Destination } from '@shared/url'
import { Clock, LayoutGrid, MessageCircle } from 'lucide-react'
import { atelier, errorText } from '../../api'
import { CheckRow, SegmentedControl, toast, useLatest } from '../../ui'
import { DESTINATION_INFO } from './Destinations'
import { goWorkspace } from '../../workspace/open'
import { useT, t } from '../../i18n/useT'

// Sidebar options, applied live and stored per profile in settings. SH-09:
// the body draws in the overlay as the `sidebar-options` surface; until the
// overlay host is up it draws inside the sidebar's own bounds, so it never
// needs to hide the page.

interface SidebarOptionsPanelProps {
  options: SidebarOptions
  /** Playing its short exit; it unmounts right after. */
  closing?: boolean
  onClose(): void
}

function save(patch: SettingsPatch['sidebar']): void {
  atelier.settings.set({ sidebar: patch }).catch((err: unknown) => toast.show({ message: t('tabs.sidebarOptions.couldnTSave', { value: errorText(err) }), tone: 'error' }))
}

export function SidebarOptionsPanel({ options, closing = false, onClose }: SidebarOptionsPanelProps): ReactElement {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const close = useLatest(onClose)

  // Mount only: focus moves in, Esc and outside clicks close, focus goes back on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = panel.current
    el?.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        close.current()
      }
    }
    const onPointer = (e: PointerEvent): void => {
      if (panel.current && e.target instanceof Node && !panel.current.contains(e.target) && !(e.target instanceof Element && e.target.closest('[data-sidebar-options-toggle]'))) close.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      // Give focus back only if it was still in here; an outside click keeps its own target.
      const active = document.activeElement
      if (!active || active === document.body || (el && el.contains(active))) opener?.focus()
    }
  }, [])

  return (
    <div ref={panel} className="side-options ui-popover" data-state={closing ? 'closing' : 'open'} inert={closing || undefined} role="dialog" aria-label={t('tabs.sidebarOptions.sidebarOptions')}>
      <SidebarOptionsBody options={options} onClose={onClose} />
    </div>
  )
}

/** The options themselves, shared by the in-sidebar panel and the overlay surface. */
export function SidebarOptionsBody({ options, onClose }: { options: SidebarOptions; onClose(): void }): ReactElement {
  const t = useT()
  const both = options.sections === 'tabs-and-chats'
  return (
    <>
      {/* DS-91: no title or close button; a muted label, then round-check rows. */}
      <div className="side-options__group" role="group" aria-labelledby="side-options-show">
        <span className="side-options__label" id="side-options-show">{t('tabs.sidebarOptions.showInTheSidebar')}</span>
        {DESTINATIONS.map((dest) => {
          const Icon = DESTINATION_INFO[dest].icon
          return (
            <CheckRow
              key={dest}
              label={DESTINATION_INFO[dest].label}
              icon={<Icon />}
              checked={options.destinations[dest]}
              onChange={(on) => save({ destinations: { [dest]: on } as Partial<Record<Destination, boolean>> })}
            />
          )
        })}
        <CheckRow label={t('tabs.sidebarOptions.chatsSection')} icon={<MessageCircle />} checked={both} onChange={(on) => save({ sections: on ? 'tabs-and-chats' : 'tabs-only' })} />
        <CheckRow label={t('tabs.sidebarOptions.whenEachWasLast')} icon={<Clock />} checked={options.showLastUsed} onChange={(showLastUsed) => save({ showLastUsed })} />
      </div>

      {/* AP-01: apps are chosen in Workspace › Apps (or by right-clicking one here), as a row or just their icon. */}
      <div className="side-options__group" role="group" aria-labelledby="side-options-apps">
        <span className="side-options__label" id="side-options-apps">{t('tabs.sidebarOptions.apps')}</span>
        <button
          type="button"
          className="ui-check-row side-options__link"
          onClick={() => {
            goWorkspace('apps')
            onClose()
          }}
        >
          <span className="ui-check-row__icon" aria-hidden="true">
            <LayoutGrid />
          </span>
          <span className="ui-check-row__label">{t('tabs.sidebarOptions.chooseApps')}</span>
        </button>
        <span className="side-options__hint">{t('tabs.sidebarOptions.appsHint')}</span>
      </div>

      <div className="side-options__rule" role="separator" />

      <div className="side-options__row">
        <span className="side-options__label" id="side-options-chat-sort">{t('tabs.sidebarOptions.sortChats')}</span>
        <SegmentedControl<ChatSort>
          size="sm"
          label={t('tabs.sidebarOptions.sortChats')}
          disabled={!both}
          value={!both && options.chatSort === 'progress' ? 'recent' : options.chatSort}
          onChange={(chatSort) => save({ chatSort })}
          options={[
            { value: 'recent', label: t('tabs.sidebarOptions.recent') },
            { value: 'manual', label: t('tabs.sidebarOptions.manual') },
            { value: 'progress', label: t('tabs.sidebarOptions.progress'), disabled: !both, title: t('tabs.sidebarOptions.waitingForYouFirst') },
          ]}
        />
      </div>

      <div className="side-options__row">
        <span className="side-options__label">{t('tabs.sidebarOptions.sortTabs')}</span>
        <SegmentedControl<TabSort>
          size="sm"
          label={t('tabs.sidebarOptions.sortTabs')}
          value={options.tabSort}
          onChange={(tabSort) => save({ tabSort })}
          options={[
            { value: 'manual', label: t('tabs.sidebarOptions.manual') },
            { value: 'recent', label: t('tabs.sidebarOptions.recent') },
          ]}
        />
      </div>
    </>
  )
}
