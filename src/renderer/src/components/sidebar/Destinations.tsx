/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import type { SidebarOptions } from '@shared/ipc'
import type { Routine } from '@shared/services'
import { DESTINATIONS, type Destination } from '@shared/url'
import { AudioLines, CalendarClock, Ellipsis, MessagesSquare, Plug, SlidersHorizontal, WandSparkles, type LucideIcon } from 'lucide-react'
import { call } from '../../api'
import { useLanguageVersion } from '../../i18n/useT'
import { BookOpen, FolderOpen, LayoutGrid, Package } from 'lucide-react'
import { currentLocale, t, type MessageKey } from '@shared/i18n/core'
import { StatusDot, cx, formatDuration, showContextMenu, showPopoverMenu, useNow, useReducedMotion, type PopoverItem } from '../../ui'
import { CompanionAvatarById } from './CompanionAvatar'
import { nextRoutineRun } from './logic/order'
import { routinesCard } from './cardContent'
import { ROUTINES_DWELL_MS, closeCard, hoverRow, leaveRow } from './hoverCard'
import { routineUrl } from '@shared/url'
import { RoutineRunningDot } from '../RoutineRunningDot'
import { useMeetingLive } from '../../meetings/status'
import { ConnectorsBadge } from '../../connectors/SidebarBadge'

// The sidebar's destination rows. Each opens its atelier:// page on the
// window-level destination surface (DS-99), never as a tab; clicking the
// active one again takes it back to its root view. They activate on
// pointer-down so they feel instant. Status is only ever a dot or a faint
// countdown, never a number. The overflow row always closes the block.

/** A row's label is read when it is shown, so it follows the app language. */
const info = (key: MessageKey, icon: LucideIcon): { readonly label: string; icon: LucideIcon } => ({
  get label() {
    return t(key)
  },
  icon,
})

export const DESTINATION_INFO: Record<Destination, { readonly label: string; icon: LucideIcon }> = {
  chats: info('tabs.destination.chats', MessagesSquare),
  routines: info('tabs.destination.routines', CalendarClock),
  connectors: info('tabs.destination.connectors', Plug),
  skills: info('tabs.destination.skills', WandSparkles),
  // The meetings page, with its live dot.
  meetings: info('meetings.destination', AudioLines),
  // SH-07
  workspace: info('workspace.title', LayoutGrid),
  // SH-07
  guides: info('firstRun.guides.title', BookOpen),
  // Library › Files, in the overflow by default.
  files: info('files.page.title', FolderOpen),
  // AP-02: the packs you added (atelier://packs), in the overflow by default.
  packs: info('packs.page.title', Package),
}

// SH-07: a dot, never a count, while a recording runs
function MeetingsBadge(): ReactElement | null {
  const live = useMeetingLive()
  return live ? <StatusDot status="error" size={6} label={t('meetings.destination.recording')} pulse={false} /> : null
}

/** A chat that arrived in the background: its companion's face drops into the All chats icon. */
export interface Arrival {
  companionId: string
  /** Changes for every arrival, so the sequence plays again. */
  key: number
}

interface DestinationsProps {
  options: SidebarOptions
  /** The destination the active tab shows, if any. */
  current: Destination | null
  activeTabId: string | null
  unread: number
  needsInput: number
  routines: Routine[]
  /** A routine result arrived that you haven't opened. */
  routineUnread: boolean
  arrival: Arrival | null
  focusId: string | null
  onOpenOptions(): void
  /** Remounts the page, clearing its search (a click on the active destination). */
  onReset(tabId: string): void
}

function RoutineCountdown({ routines }: { routines: Routine[] }): ReactElement | null {
  const now = useNow()
  const next = nextRoutineRun(routines)
  if (next === null) return null
  const label = next <= now ? t('tabs.destination.due') : t('tabs.destination.in', { time: formatDuration(next - now, 'short') })
  return (
    <span className="side-row__time side-row__time--rest" title={t('tabs.destination.nextRoutine', { when: new Date(next).toLocaleString(currentLocale(), { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })}>
      {label}
    </span>
  )
}

/**
 * The All chats icon. On an arrival the icon shrinks away, the arriving
 * companion's mini face drops in with a small squash and settles, holds, and
 * the icon springs back. Reduce Motion skips the whole sequence.
 */
function ChatsIcon({ arrival }: { arrival: Arrival | null }): ReactElement {
  const reduced = useReducedMotion()
  const playing = arrival !== null && !reduced
  return (
    <span className={cx('side-row__icon dest-row__icon', playing && 'dest-row__icon--arrival')} key={playing ? arrival.key : 'rest'}>
      <MessagesSquare size={16} aria-hidden className="dest-row__glyph" />
      {playing && (
        <span className="dest-row__arrival" aria-hidden>
          <CompanionAvatarById id={arrival.companionId} size={16} label="" mood="happy" mark={null} />
        </span>
      )}
    </span>
  )
}

export function Destinations({ options, current, activeTabId, unread, needsInput, routines, routineUnread, arrival, focusId, onOpenOptions, onReset }: DestinationsProps): ReactElement {
  useLanguageVersion() // relabels the rows when the app language changes
  const shown = DESTINATIONS.filter((d) => options.destinations[d])
  const hidden = DESTINATIONS.filter((d) => !options.destinations[d])
  // A press already opened it; the click that follows must not open it twice.
  const pressed = useRef<string | null>(null)

  const open = (dest: Destination): void => {
    if (current === dest && activeTabId) onReset(activeTabId)
    void call('pages', 'open', `atelier://${dest}`)
  }

  // DS-89: an in-window dropdown 4 px under the row: the hidden destinations, a hairline, then the options.
  const overflow = async (anchor: HTMLElement): Promise<void> => {
    const items: PopoverItem[] = [
      ...hidden.map((d) => {
        const Icon = DESTINATION_INFO[d].icon
        return { id: d, label: DESTINATION_INFO[d].label, icon: <Icon /> }
      }),
      ...(hidden.length > 0 ? [{ id: 'sep', label: '', kind: 'separator' as const }] : []),
      { id: 'options', label: t('tabs.destination.options'), icon: <SlidersHorizontal /> },
    ]
    const id = await showPopoverMenu(items, anchor, { label: t('tabs.destination.overflow'), width: 272, gap: 4, muted: true })
    if (id === 'options') onOpenOptions()
    else if (id && (DESTINATIONS as readonly string[]).includes(id)) open(id as Destination)
  }
  // A destination opened from the dropdown gives the overflow row the chip.
  const overflowActive = current !== null && hidden.includes(current)

  const onPress = (e: PointerEvent, dest: Destination): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    pressed.current = dest
    open(dest)
  }

  return (
    <nav className="destinations" aria-label={t('tabs.destination.nav')}>
      {shown.map((dest) => {
        const { label, icon: Icon } = DESTINATION_INFO[dest]
        return (
          <button
            key={dest}
            type="button"
            data-sidebar-row
            tabIndex={focusId === `dest:${dest}` ? 0 : -1}
            className={cx('side-row dest-row', current === dest && 'side-row--active')}
            aria-current={current === dest ? 'page' : undefined}
            onPointerDown={(e) => {
              closeCard()
              onPress(e, dest)
            }}
            // SH-07: the Routines row lists the upcoming runs, each one clickable.
            onPointerEnter={(e) => {
              if (dest !== 'routines' || e.pointerType === 'touch') return
              hoverRow(e.currentTarget, {
                key: 'dest:routines',
                side: 'right',
                dwellMs: ROUTINES_DWELL_MS,
                build: async () => routinesCard(routines),
                onChoose: (value) => {
                  const id = (value as { routineId?: unknown } | null)?.routineId
                  if (typeof id === 'string') void call('pages', 'open', routineUrl(id))
                },
              })
            }}
            onPointerLeave={() => leaveRow(`dest:${dest}`)}
            onClick={(e) => {
              if (pressed.current === dest) {
                pressed.current = null
                return
              }
              if (e.metaKey || e.ctrlKey) void call('pages', 'open', `atelier://${dest}`, { newTab: true, background: true })
              else open(dest)
            }}
            onKeyDown={(e: KeyboardEvent) => {
              // Keyboard activation goes through click; drop any stale press.
              if (e.key === 'Enter' || e.key === ' ') pressed.current = null
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void call('pages', 'open', `atelier://${dest}`, { newTab: true, background: true })
            }}
            onContextMenu={
              dest === 'chats'
                ? (e) => {
                    void showContextMenu(e, [
                      { id: 'read', label: t('tabs.destination.markAllRead'), enabled: unread > 0 },
                      { id: 'new-tab', label: t('tabs.destination.openInNewTab') },
                    ]).then((id) => {
                      if (id === 'read') void call('chats', 'markAllRead')
                      else if (id === 'new-tab') void call('pages', 'open', 'atelier://chats', { newTab: true })
                    })
                  }
                : (e) => {
                    void showContextMenu(e, [{ id: 'new-tab', label: t('tabs.destination.openInNewTab') }]).then((id) => {
                      if (id === 'new-tab') void call('pages', 'open', `atelier://${dest}`, { newTab: true })
                    })
                  }
            }
          >
            {dest === 'chats' ? (
              <ChatsIcon arrival={arrival} />
            ) : (
              <span className="side-row__icon">
                <Icon size={16} aria-hidden />
              </span>
            )}
            <span className="side-row__title">{label}</span>
            <span className="side-row__badges">
              {dest === 'chats' && (
                <>
                  {needsInput > 0 && <StatusDot status="needs-input" size={6} label={needsInput === 1 ? t('tabs.destination.waitingOne') : t('tabs.destination.waitingMany')} pulse={false} />}
                  {unread > 0 && <StatusDot status="unread" size={6} label={t('tabs.destination.unread')} pulse={false} />}
                </>
              )}
              {dest === 'routines' && (
                <>
                  <RoutineCountdown routines={routines} />
                  <RoutineRunningDot />
                  {routineUnread && <StatusDot status="unread" size={6} label={t('tabs.destination.routineUnread')} pulse={false} />}
                </>
              )}
              {/* SH-07: a recording dot while a meeting is being recorded. */}
              {dest === 'meetings' && <MeetingsBadge />}
              {/* A dot while a connector needs reconnecting. */}
              {dest === 'connectors' && <ConnectorsBadge />}
            </span>
          </button>
        )
      })}
      {/* DS-89: always the last row of the fixed block, even when nothing is hidden. */}
      <button
        type="button"
        data-sidebar-row
        tabIndex={focusId === 'dest:more' ? 0 : -1}
        className={cx('side-row dest-row dest-row--more', overflowActive && 'side-row--active')}
        aria-haspopup="menu"
        aria-expanded={false}
        aria-current={overflowActive ? 'page' : undefined}
        onClick={(e) => void overflow(e.currentTarget)}
      >
        <span className="side-row__icon">
          <Ellipsis size={16} aria-hidden />
        </span>
        <span className="side-row__title">{overflowActive && current ? DESTINATION_INFO[current].label : t('tabs.destination.more')}</span>
      </button>
    </nav>
  )
}
