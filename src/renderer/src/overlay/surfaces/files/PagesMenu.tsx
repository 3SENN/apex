/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { Globe, Trash2, X } from 'lucide-react'
import type { ChatContextPage } from '@shared/chatContext'
import type { FilesSurfaceProps } from '@shared/overlay/files'
import { clampSelection, orderChatPages, pagesMenuKey, type PagesMenuEffect, type PagesMenuKey, type PagesMenuState } from '@shared/filesLogic'
import { t } from '@shared/i18n/core'
import { atelier, call, errorText, hostOf } from '../../../api'
import { IconButton, cx, toast } from '../../../ui'
import { MenuScrim, Popover, inChromeHost, type Box } from '../../kit'
import type { SurfaceComponentProps } from '../../types'
import './files.css'

// Pages in this chat (CH-34): the pages the chat opened or keeps as
// context, with thumbnails and one row selected at a time. A page the agent
// drives glows in the companion's colour and can't be closed or removed
// until it lets go. ↑ ↓ move, Enter brings the page forward, Delete removes
// it from the chat's context, and Esc closes.

const KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'Home', 'End', 'Delete', 'Backspace', 'Enter', 'Escape'])

function anchorBox(anchor: SurfaceComponentProps<unknown>['anchor'], rect: SurfaceComponentProps<unknown>['anchorRect']): Box {
  if (rect) return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
  if (anchor.kind === 'window') return { left: anchor.rect.x, top: anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height }
  if (anchor.kind === 'point') return { left: anchor.x, top: anchor.y, width: 0, height: 0 }
  return anchor.rect ? { left: anchor.rect.x, top: anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height } : { left: 0, top: 0, width: 0, height: 0 }
}

function Thumb({ page, src }: { page: ChatContextPage; src: string | null | undefined }): ReactElement {
  if (src) return <img className="pm-thumb" src={src} alt="" draggable={false} />
  return <span className="pm-thumb pm-thumb--empty">{page.favicon ? <img src={page.favicon} alt="" draggable={false} /> : <Globe aria-hidden />}</span>
}

export function PagesMenuSurface({ instanceId, props, anchor, anchorRect, resolve, close, reportBounds }: SurfaceComponentProps<FilesSurfaceProps['chat-pages-menu']>): ReactElement {
  const listId = useId()
  const reasonId = useId()
  const list = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<ChatContextPage[] | null>(null)
  const [state, setState] = useState<PagesMenuState>({ selected: 0 })
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const chrome = inChromeHost(instanceId)

  useEffect(() => {
    let alive = true
    void call('chatContext', 'list', props.chatId).then(
      (items) => alive && setPages(orderChatPages(items)),
      (err: unknown) => {
        if (!alive) return
        setPages([])
        setNotice(errorText(err))
      },
    )
    const off = atelier.onAppEvent((e) => {
      if (e.type === 'chat-context' && e.chatId === props.chatId) setPages(orderChatPages(e.pages))
    })
    return () => {
      alive = false
      off()
    }
  }, [props.chatId])

  // Thumbnails of open pages, one capture each.
  useEffect(() => {
    for (const page of pages ?? []) {
      const id = page.tabId
      if (!id || id in thumbs) continue
      setThumbs((m) => ({ ...m, [id]: null }))
      void call('pages', 'snapshot', id).then(
        (src) => setThumbs((m) => ({ ...m, [id]: src })),
        () => undefined,
      )
    }
  }, [pages])

  useEffect(() => {
    list.current?.focus()
  }, [])

  const shown = pages ?? []
  const current = clampSelection(state, shown.length)

  const run = async (effect: PagesMenuEffect): Promise<void> => {
    switch (effect.kind) {
      case 'none':
        return
      case 'close':
        close()
        return
      case 'refused':
        setNotice(t('files.pages.lockedReason'))
        return
      case 'focus': {
        const page = effect.page
        try {
          if (page.tabId) await call('chatContext', 'focus', props.chatId, page.tabId)
          else await atelier.tabs.create(page.url)
          resolve({ focused: page.tabId ?? page.url })
        } catch (err) {
          setNotice(errorText(err))
        }
        return
      }
      case 'remove': {
        const page = effect.page
        if (!page.tabId) return
        try {
          await call('chatContext', 'remove', props.chatId, page.tabId)
          setNotice(null)
          toast.show({ message: t('files.pages.removed', { title: page.title || hostOf(page.url) }) })
        } catch (err) {
          setNotice(errorText(err))
        }
      }
    }
  }

  const closeTab = async (page: ChatContextPage): Promise<void> => {
    if (!page.tabId) return
    if (page.controlled) {
      setNotice(t('files.pages.lockedReason'))
      return
    }
    try {
      await call('chatContext', 'close', props.chatId, page.tabId)
    } catch (err) {
      setNotice(errorText(err))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!KEYS.has(e.key)) return
    e.preventDefault()
    const out = pagesMenuKey(current, shown, e.key as PagesMenuKey)
    setState(out.state)
    if (out.effect.kind !== 'refused') setNotice(null)
    void run(out.effect)
  }

  const rowId = (i: number): string => `${listId}-row-${i}`
  const style = { '--pm-glow': props.accent ?? 'var(--accent)' } as CSSProperties

  return (
    <>
      {!chrome && <MenuScrim onDismiss={close} />}
      <Popover
        anchor={anchorBox(anchor, anchorRect)}
        side="below"
        align="end"
        gap={6}
        width={360}
        label={t('files.pages.title')}
        className="pm"
        onBounds={(box) => {
          if (chrome) reportBounds({ x: box.left, y: box.top, width: box.width, height: box.height })
        }}
      >
        <div className="pm-head">
          <span className="pm-title">{t('files.pages.title')}</span>
          <span className="pm-hint" aria-hidden>
            {t('files.pages.hint')}
          </span>
        </div>
        <div
          ref={list}
          className="pm-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('files.pages.title')}
          aria-activedescendant={current.selected >= 0 ? rowId(current.selected) : undefined}
          aria-describedby={notice ? reasonId : undefined}
          onKeyDown={onKeyDown}
          style={style}
        >
          {pages === null ? (
            <p className="pm-empty">{t('files.viewer.loading')}</p>
          ) : shown.length === 0 ? (
            <p className="pm-empty">{t('files.pages.empty')}</p>
          ) : (
            shown.map((page, i) => {
              const selected = i === current.selected
              const title = page.title || hostOf(page.url)
              return (
                <div
                  key={`${page.tabId ?? 'ctx'}:${page.url}`}
                  id={rowId(i)}
                  role="option"
                  aria-selected={selected}
                  className={cx('pm-row', selected && 'pm-row--selected', page.controlled && 'pm-row--controlled')}
                  onPointerMove={() => !selected && setState({ selected: i })}
                  onClick={() => void run({ kind: 'focus', page })}
                >
                  <Thumb page={page} src={page.tabId ? thumbs[page.tabId] : null} />
                  <span className="pm-row__text">
                    <span className="pm-row__title" title={title}>
                      {title}
                    </span>
                    <span className="pm-row__sub">
                      {page.controlled ? t('files.pages.controlled') : page.tabId === null ? t('files.pages.contextOnly') : hostOf(page.url)}
                    </span>
                  </span>
                  <span className="pm-row__actions" onClick={(e) => e.stopPropagation()}>
                    {page.tabId && (
                      <IconButton
                        size="sm"
                        tabIndex={-1}
                        label={page.controlled ? `${t('files.pages.closeTab')}: ${t('files.pages.lockedReason')}` : t('files.pages.closeTab')}
                        icon={<X />}
                        aria-disabled={page.controlled || undefined}
                        className={cx(page.controlled && 'pm-action--locked')}
                        onClick={() => void closeTab(page)}
                      />
                    )}
                    {page.tabId && (
                      <IconButton
                        size="sm"
                        tabIndex={-1}
                        label={page.controlled ? `${t('files.pages.remove')}: ${t('files.pages.lockedReason')}` : t('files.pages.remove')}
                        icon={<Trash2 />}
                        aria-disabled={page.controlled || undefined}
                        className={cx(page.controlled && 'pm-action--locked')}
                        onClick={() => void run(page.controlled ? { kind: 'refused', page } : { kind: 'remove', page })}
                      />
                    )}
                  </span>
                </div>
              )
            })
          )}
        </div>
        <p id={reasonId} className={cx('pm-notice', notice && 'pm-notice--on')} role="status" aria-live="polite">
          {notice}
        </p>
      </Popover>
    </>
  )
}
