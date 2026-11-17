/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { t } from '../i18n/useT'
import { ChatPage } from '../pages/ChatPage'
import { MOTION, Seam, cx, followFrames, useLatest, useLayerPresence } from '../ui'
import { PAGE_SHARE } from './logic/inTab'
import { savePageShare, usePageShare } from './surfaces'
import './chatInTab.css'

// DS-65 (CH-03): what a tab's pane holds. A website tab shows its page, as
// before. While it holds a chat expanded from the side panel, the same tab
// shows the chat page with its web page as the side pane: the native page
// view moves into the pane on the right, the chat takes the rest, and the
// change runs on the layout timeline with the native view following it.

interface TabPaneBodyProps {
  tabId: string
  /** The chat this tab holds beside its page, or null for the page alone. */
  chatId: string | null
  /** Where the tab's native page view goes; App measures it and reports it to main. */
  slotRef(el: HTMLDivElement | null): void
  /** Re-measures the panes so the native views follow. */
  onLayout(): void
  /** What the chrome draws over the page (an error page, say). */
  children?: ReactNode
}

export function TabPaneBody({ tabId, chatId, slotRef, onLayout, children }: TabPaneBodyProps): ReactElement {
  const presence = useLayerPresence(chatId !== null, MOTION.layout)
  const last = useRef(chatId)
  if (chatId) last.current = chatId
  const shown = chatId ?? last.current
  const inTab = presence !== 'closed' && shown !== null
  // Only a hand-over seen here animates; a tab that held its chat when it came forward shows it at once.
  const sawPageAlone = useRef(chatId === null)
  if (presence === 'closed') sawPageAlone.current = true
  const layout = useLatest(onLayout)
  const box = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement | null>(null)
  const share = usePageShare()
  const [live, setLive] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const [usable, setUsable] = useState(0)
  const value = live ?? share

  // The native view follows the pane frame by frame while it opens or closes.
  useEffect(() => followFrames(MOTION.layout + 80, () => layout.current?.()), [presence, layout])

  // The slot is a new element in each mode, and it moves with the seam and the window.
  useLayoutEffect(() => {
    const els = [slot.current, box.current].filter((el): el is HTMLDivElement => el !== null)
    if (els.length === 0) return
    const measure = (): void => {
      if (box.current) setUsable(Math.max(0, box.current.clientWidth))
      layout.current?.()
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [inTab, layout])

  const setSlot = (el: HTMLDivElement | null): void => {
    slot.current = el
    slotRef(el)
  }

  if (!inTab) {
    return (
      <>
        <div className="pane__view" ref={setSlot} />
        {children}
      </>
    )
  }

  const change = (next: number): void => {
    setLive(next)
    requestAnimationFrame(() => layout.current?.())
  }
  return (
    <div
      ref={box}
      className={cx('chat-in-tab', resizing && 'chat-in-tab--resizing')}
      data-state={presence}
      data-enter={sawPageAlone.current || undefined}
      style={{ '--chat-in-tab-page': value } as CSSProperties}
    >
      <div className="chat-in-tab__chat" inert={presence === 'closing' || undefined}>
        <ErrorBoundary what={t('core.app.thisPage')} resetKey={shown}>
          <ChatPage chatId={shown} tabId={tabId} held />
        </ErrorBoundary>
      </div>
      <div className="chat-in-tab__seam">
        <Seam
          value={value}
          min={PAGE_SHARE.min}
          max={PAGE_SHARE.max}
          reverse
          pixelsPerUnit={Math.max(1, usable)}
          step={usable > 0 ? 8 / usable : 0.01}
          resetTo={PAGE_SHARE.default}
          label={t('chat.inTab.seam')}
          valueText={(v) => `${100 - Math.round(v * 100)} / ${Math.round(v * 100)}`}
          disabled={presence === 'closing'}
          onChange={change}
          onCommit={(v) => {
            savePageShare(v)
            setLive(null)
          }}
          onDragChange={(dragging) => {
            setResizing(dragging)
            if (!dragging) setLive(null)
          }}
        />
      </div>
      <div className="chat-in-tab__page" role="region" aria-label={t('chat.inTab.page')}>
        <div className="pane__view" ref={setSlot} />
        {children}
      </div>
    </div>
  )
}
