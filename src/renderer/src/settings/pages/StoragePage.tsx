/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Storage (ST-53 to ST-55): what Atelier keeps on this computer as
// a total and a stacked bar by category (each feature registers its own), ways
// to free space (the cache, old chat images, chats by size), and Reset Atelier
// in a danger-zone card.
import { useRef, useState, type ReactElement } from 'react'
import { Eraser, ImageMinus, MessageSquare, RotateCcw, Trash2 } from 'lucide-react'
import type { ChatStorageRow } from '@shared/services/settings'
import type { StorageCategoryView } from '@shared/storage'
import { call, formatBytes } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, EmptyState, IconButton, RelativeTime, Skeleton, SkeletonRows, useAsyncAction, useConfirm, useToast } from '../../ui'
import { useTooltip } from '../../ui/Tooltip'
import { useResource } from '../data'
import { Card, ListFrame, PageError, PageHeader, Row, Section } from '../kit'
import { CHAT_LIST_PREVIEW, OLD_IMAGE_DAYS, sortChatRows, storageLegend, storageSegments, totalBytes } from '../logic/storage'
import { ResetDialog } from '../ResetDialog'

/** One stretch of the bar; hovering names it (the legend carries the same words for screen readers). */
function Segment({ tone, share, label }: { tone: number; share: number; label: string }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  useTooltip(ref, { label, side: 'top' })
  return <span ref={ref} className="sp-usage__seg" data-tone={tone} style={{ flexGrow: share }} />
}

/** The total and the stacked bar, with a legend that is also the accessible description. */
function UsageCard({ categories, error, onRetry }: { categories: StorageCategoryView[] | null; error: string | null; onRetry(): Promise<void> }): ReactElement {
  const t = useT()
  if (categories === null) {
    if (error) return <PageError title={t('settings.storagePage.measureFailed')} message={error} onRetry={onRetry} />
    return (
      <Card className="sp-usage">
        <div className="sp-usage__body" aria-busy="true">
          <span className="sp-usage__total">
            <Skeleton width={160} height={22} />
          </span>
          <Skeleton height={14} className="sp-usage__bar-skeleton" />
          <span className="sp-usage__measuring" role="status">
            {t('settings.storagePage.measuring')}
          </span>
        </div>
      </Card>
    )
  }
  const segments = storageSegments(categories)
  const legend = storageLegend(categories)
  return (
    <Card className="sp-usage">
      <div className="sp-usage__body" data-settings-anchor="storage-usage">
        <p className="sp-usage__total">{t('settings.storagePage.total', { size: formatBytes(totalBytes(categories)) })}</p>
        <div className="sp-usage__bar" aria-hidden>
          {segments.map((s) => (
            <Segment key={s.id} tone={s.tone} share={s.share} label={t('settings.storagePage.legendItem', { label: s.label, size: formatBytes(s.bytes) })} />
          ))}
        </div>
        <ul className="sp-usage__legend" aria-label={t('settings.storagePage.legend')}>
          {legend.map((c) => (
            <li key={c.id} className="sp-usage__key">
              <span className="sp-usage__swatch" data-tone={c.tone} aria-hidden />
              <span className="sp-usage__label">{c.label}</span>
              <span className="sp-usage__size">{formatBytes(c.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

function ChatSizes({ rows, error, onRetry, onChanged }: { rows: ChatStorageRow[] | null; error: string | null; onRetry(): Promise<void>; onChanged(): void }): ReactElement {
  const t = useT()
  const ask = useConfirm()
  const toast = useToast()
  const [all, setAll] = useState(false)
  const act = useAsyncAction(
    async (row: ChatStorageRow, kind: 'images' | 'chat') => {
      const title = row.title || t('settings.storagePage.chats.untitled')
      if (kind === 'images') {
        const ok = await ask({ title: t('settings.storagePage.chats.deleteImages.title', { title }), message: t('settings.storagePage.chats.deleteImages.message'), confirmLabel: t('settings.storagePage.chats.deleteImages'), destructive: true })
        if (!ok) return
        const res = await call('storage', 'removeImages', { chatIds: [row.chatId], olderThanDays: 0 })
        toast.show({ tone: 'success', message: t('settings.storagePage.images.done', { count: res.removed }) })
      } else {
        const ok = await ask({ title: t('settings.storagePage.chats.deleteChat.title', { title }), message: t('settings.storagePage.chats.deleteChat.message'), confirmLabel: t('settings.storagePage.chats.deleteChat'), destructive: true })
        if (!ok) return
        await call('chats', 'remove', row.chatId)
        toast.show({ tone: 'success', message: t('settings.storagePage.chats.deleted') })
      }
      onChanged()
    },
    { toastErrors: true },
  )

  if (rows === null) {
    return <ListFrame>{error ? <PageError title={t('settings.loadFailed')} message={error} onRetry={onRetry} /> : <SkeletonRows rows={4} label={t('settings.kit.loading')} />}</ListFrame>
  }
  if (rows.length === 0) {
    return (
      <ListFrame>
        <EmptyState icon={<MessageSquare />} title={t('settings.storagePage.chats.empty')} description={t('settings.storagePage.chats.empty.description')} compact />
      </ListFrame>
    )
  }
  const sorted = sortChatRows(rows)
  const shown = all ? sorted : sorted.slice(0, CHAT_LIST_PREVIEW)
  return (
    <>
      <Card>
        <ul className="sp-chat-sizes" aria-label={t('settings.storagePage.chats')}>
          {shown.map((row) => {
            const title = row.title || t('settings.storagePage.chats.untitled')
            return (
              <li key={row.chatId} className="sp-row sp-chat-size">
                <span className="sp-row__icon" aria-hidden>
                  <MessageSquare />
                </span>
                <div className="sp-row__text">
                  <span className="sp-row__title">{title}</span>
                  <span className="sp-row__description">
                    {row.imageBytes > 0 ? t('settings.storagePage.chats.rowImages', { size: formatBytes(row.bytes), images: formatBytes(row.imageBytes) }) : t('settings.storagePage.chats.row', { size: formatBytes(row.bytes) })}
                    {' · '}
                    <RelativeTime value={row.updatedAt} />
                  </span>
                </div>
                <div className="sp-row__control">
                  {row.imageBytes > 0 && (
                    <IconButton size="sm" label={`${t('settings.storagePage.chats.deleteImages')}: ${title}`} icon={<ImageMinus />} disabled={act.busy} onClick={() => void act.run(row, 'images')} />
                  )}
                  <IconButton size="sm" label={`${t('settings.storagePage.chats.deleteChat')}: ${title}`} icon={<Trash2 />} disabled={act.busy} onClick={() => void act.run(row, 'chat')} />
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
      {!all && sorted.length > CHAT_LIST_PREVIEW && (
        <button type="button" className="sp-link sp-more" onClick={() => setAll(true)}>
          {t('settings.storagePage.chats.more', { count: sorted.length })}
        </button>
      )}
    </>
  )
}

export function StoragePage(): ReactElement {
  const t = useT()
  const ask = useConfirm()
  const toast = useToast()
  const categories = useResource(() => call('storage', 'categories'))
  const chats = useResource(() => call('storage', 'chats'))
  const [resetOpen, setResetOpen] = useState(false)
  const refresh = (): void => {
    void categories.reload()
    void chats.reload()
  }

  const cache = useAsyncAction(
    async () => {
      const ok = await ask({ title: t('settings.privacy.cache.confirm.title'), message: t('settings.privacy.cache.confirm.message'), confirmLabel: t('settings.privacy.cache.button'), destructive: true })
      if (!ok) return
      await call('storage', 'clear', 'cache')
      toast.show({ tone: 'success', message: t('settings.privacy.cache.done') })
      refresh()
    },
    { toastErrors: true },
  )
  const images = useAsyncAction(
    async () => {
      const ok = await ask({ title: t('settings.storagePage.images.confirm.title'), message: t('settings.storagePage.images.confirm.message', { days: OLD_IMAGE_DAYS }), confirmLabel: t('settings.storagePage.images.button'), destructive: true })
      if (!ok) return
      const res = await call('storage', 'removeImages', { olderThanDays: OLD_IMAGE_DAYS })
      toast.show({ tone: 'success', message: t('settings.storagePage.images.done', { count: res.removed }) })
      refresh()
    },
    { toastErrors: true },
  )

  return (
    <>
      <PageHeader title={t('settings.storagePage.title')} description={t('settings.storagePage.description')} />
      <Section title={t('settings.storagePage.used')}>
        <UsageCard categories={categories.data} error={categories.error} onRetry={categories.reload} />
      </Section>

      <Section title={t('settings.storagePage.free')}>
        <Card>
          <Row anchor="storage-cache" icon={<Eraser />} title={t('settings.storagePage.cache')} description={t('settings.storagePage.cache.description')}>
            <Button size="sm" variant="secondary" loading={cache.busy} onClick={() => void cache.run()}>
              {t('settings.privacy.cache.button')}
            </Button>
          </Row>
          <Row anchor="storage-images" icon={<ImageMinus />} title={t('settings.storagePage.images')} description={t('settings.storagePage.images.description', { days: OLD_IMAGE_DAYS })}>
            <Button size="sm" variant="secondary" loading={images.busy} onClick={() => void images.run()}>
              {t('settings.storagePage.images.button')}
            </Button>
          </Row>
        </Card>
      </Section>

      <Section title={t('settings.storagePage.chats')} note={t('settings.storagePage.chats.note')}>
        <ChatSizes rows={chats.data} error={chats.error} onRetry={chats.reload} onChanged={refresh} />
      </Section>

      <Section title={t('settings.storagePage.reset')}>
        <Card className="sp-card--danger">
          <Row anchor="reset" icon={<RotateCcw />} title={t('settings.storagePage.reset.row')} description={t('settings.storagePage.reset.description')}>
            <Button size="sm" variant="danger" onClick={() => setResetOpen(true)} aria-haspopup="dialog">
              {t('settings.storagePage.reset.button')}
            </Button>
          </Row>
        </Card>
      </Section>
      <ResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </>
  )
}
