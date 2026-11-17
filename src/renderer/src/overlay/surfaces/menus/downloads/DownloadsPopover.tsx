/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowUpRight, Download, FolderOpen, RotateCw, TriangleAlert, X } from 'lucide-react'
import { downloadActions, downloadPercent, downloadPhase, downloadStatus, fileKind, isClearable, type DownloadRow, type DownloadsPopoverProps } from '@shared/downloads'
import { EDGE_MARGIN } from '@shared/overlayLayout'
import { call, errorText } from '../../../../api'
import { useT } from '../../../../i18n/useT'
import { Button, EmptyState, IconButton, SkeletonRows, cx } from '../../../../ui'
import type { SurfaceComponentProps } from '../../../types'
import { FileKindIcon } from './FileKindIcon'
import './downloads.css'

// The downloads popover (OV-17): about 300 px, under the sidebar header's
// downloads button (or the toolbar's in the horizontal layout). Rows show a
// file-type icon, name, progress (amount, percent, speed, time left) or what
// went wrong; running ones cancel, finished ones open on click, reveal or drag
// out as a file, and flagged ones wait for Keep or Discard.

const WIDTH = 300
/** The frame's gap to the button (the module sets no other). */
const GAP = 6

/** Arrow keys move between rows; the popover is one stop in the Tab order per control. */
function moveFocus(root: HTMLElement, direction: 1 | -1 | 'first' | 'last'): void {
  const stops = [...root.querySelectorAll<HTMLElement>('[data-dl-row-focus]')]
  if (stops.length === 0) return
  const at = stops.indexOf(document.activeElement as HTMLElement)
  const next = direction === 'first' ? 0 : direction === 'last' ? stops.length - 1 : at < 0 ? 0 : (at + direction + stops.length) % stops.length
  stops[next]?.focus()
}

export function DownloadsPopover({ props, anchorRect, viewport, close, exiting }: SurfaceComponentProps<DownloadsPopoverProps>): ReactElement {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  const [folderMissing, setFolderMissing] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const items = props.items
  const rows = items ?? []
  const clearable = rows.some(isClearable)

  // The overlay frame places it under the button (above it when there is no room) and sizes the view to it,
  // so it scrolls within the taller side of the window. (Placing itself, it drew outside that view.)
  const room = anchorRect && viewport ? Math.max(viewport.y + viewport.height - (anchorRect.y + anchorRect.height), anchorRect.y - viewport.y) - GAP - EDGE_MARGIN : undefined

  useEffect(() => {
    call('downloads', 'folder')
      .then((folder) => setFolderMissing(folder.missing))
      .catch(() => undefined)
    // Keyboard users land on the newest row.
    const el = root.current
    if (el) (el.querySelector<HTMLElement>('[data-dl-row-focus]') ?? el.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
  }, [])

  const run = async (id: string, action: () => Promise<unknown>, after?: () => void): Promise<void> => {
    if (busy.has(id)) return
    setBusy((prev) => new Set(prev).add(id))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await action()
      after?.()
    } catch (err) {
      setErrors((prev) => ({ ...prev, [id]: errorText(err) }))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const openPage = (url: string): void => {
    void call('pages', 'open', url)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = root.current
    if (!el) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(el, e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      moveFocus(el, e.key === 'Home' ? 'first' : 'last')
    }
  }

  return (
    <div
      ref={root}
      className={cx('ui-pop', 'ui-popover', 'dl-pop')}
      role="dialog"
      aria-label={t('downloads.popover.title')}
      data-placed=""
      data-state={exiting ? 'closing' : 'open'}
      style={{ width: WIDTH, maxHeight: room }}
      onKeyDown={onKeyDown}
    >
      <header className="dl-pop__head">
        <h2 className="dl-pop__title">{t('downloads.popover.title')}</h2>
        <Button variant="ghost" size="sm" disabled={!clearable} onClick={() => void call('downloads', 'clear')}>
          {t('downloads.popover.clear')}
        </Button>
        <IconButton size="sm" label={t('downloads.popover.showAllLabel')} icon={<ArrowUpRight />} onClick={() => openPage('apex://downloads')} />
      </header>
      {folderMissing && (
        <p className="dl-pop__notice" role="status">
          <TriangleAlert aria-hidden />
          <span>{t('downloads.popover.folderMissing')}</span>
          <button type="button" className="dl-link" onClick={() => openPage('apex://settings/downloads')}>
            {t('downloads.popover.folderSettings')}
          </button>
        </p>
      )}
      {items === null ? (
        <SkeletonRows rows={3} label={t('downloads.popover.loading')} className="dl-pop__loading" />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Download />}
          title={t('downloads.popover.empty')}
          description={t('downloads.popover.emptyDetail')}
          action={
            <Button size="sm" onClick={() => openPage('apex://downloads')}>
              {t('downloads.popover.showAll')}
            </Button>
          }
        />
      ) : (
        <ul className="dl-pop__list" aria-label={t('downloads.popover.label')}>
          {rows.map((d) => (
            <DownloadRowView key={d.id} d={d} busy={busy.has(d.id)} error={errors[d.id] ?? null} run={run} onOpened={close} />
          ))}
        </ul>
      )}
      {props.total > rows.length && (
        <button type="button" className="dl-pop__more dl-link" onClick={() => openPage('apex://downloads')}>
          {t('downloads.popover.more', { count: props.total - rows.length })}
        </button>
      )}
    </div>
  )
}

function DownloadRowView({ d, busy, error, run, onOpened }: { d: DownloadRow; busy: boolean; error: string | null; run(id: string, action: () => Promise<unknown>, after?: () => void): Promise<void>; onOpened(): void }): ReactElement {
  const t = useT()
  const phase = downloadPhase(d)
  const actions = downloadActions(phase)
  const percent = downloadPercent(d)
  const canDrag = actions.includes('drag')
  const status = error ?? downloadStatus(d)

  // The native drag starts in main; the page's own drag image is not used.
  const onDragStart = (e: DragEvent<HTMLLIElement>): void => {
    e.preventDefault()
    void run(d.id, () => call('downloads', 'startDrag', d.id))
  }

  return (
    <li className={cx('dl-row', `dl-row--${phase}`, d.danger !== 'none' && `dl-row--${d.danger}`)} draggable={canDrag || undefined} onDragStart={canDrag ? onDragStart : undefined}>
      <FileKindIcon kind={fileKind(d.filename, d.mime)} />
      <div className="dl-row__body">
        <button
          type="button"
          className="dl-row__main"
          data-dl-row-focus=""
          aria-disabled={actions.includes('open') ? undefined : true}
          title={canDrag ? t('downloads.action.dragHint') : undefined}
          onClick={() => actions.includes('open') && void run(d.id, () => call('downloads', 'open', d.id), onOpened)}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && actions.includes('remove')) {
              e.preventDefault()
              void run(d.id, () => call('downloads', 'remove', d.id))
            }
          }}
          aria-label={actions.includes('open') ? `${t('downloads.action.open', { name: d.filename })}. ${status}` : `${d.filename}. ${status}`}
        >
          <span className="dl-row__name">{d.filename}</span>
          <span className={cx('dl-row__status', error && 'dl-row__status--error')} aria-hidden>
            {status}
          </span>
        </button>
        {phase === 'running' && (
          <span className={cx('dl-bar', percent === null && 'dl-bar--unknown')} role="progressbar" aria-label={t('downloads.progressLabel', { name: d.filename })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <i style={percent === null ? undefined : { width: `${percent}%` }} />
          </span>
        )}
        {phase === 'review' && (
          <div className="dl-row__review">
            <Button size="sm" variant="secondary" loading={busy} aria-label={t('downloads.action.keepLabel', { name: d.filename })} onClick={() => void run(d.id, () => call('downloads', 'keep', d.id))}>
              {t('downloads.action.keep')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} aria-label={t('downloads.action.discardLabel', { name: d.filename })} onClick={() => void run(d.id, () => call('downloads', 'discard', d.id))}>
              {t('downloads.action.discard')}
            </Button>
          </div>
        )}
      </div>
      <div className="dl-row__actions">
        {actions.includes('cancel') && <IconButton size="sm" label={t('downloads.action.cancelLabel', { name: d.filename })} icon={<X />} onClick={() => void run(d.id, () => call('downloads', 'cancel', d.id))} />}
        {actions.includes('reveal') && <IconButton size="sm" label={t('downloads.action.reveal')} icon={<FolderOpen />} onClick={() => void run(d.id, () => call('downloads', 'showInFolder', d.id))} />}
        {actions.includes('retry') && <IconButton size="sm" label={t('downloads.action.retry')} icon={<RotateCw />} disabled={busy} onClick={() => void run(d.id, () => call('downloads', 'retry', d.id))} />}
        {actions.includes('remove') && phase !== 'done' && <IconButton size="sm" label={t('downloads.action.remove')} icon={<X />} onClick={() => void run(d.id, () => call('downloads', 'remove', d.id))} />}
      </div>
    </li>
  )
}
