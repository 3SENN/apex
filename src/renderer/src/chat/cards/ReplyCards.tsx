/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState, type ReactElement } from 'react'
import { AppWindow, ArrowRightLeft, BookmarkCheck, BookmarkMinus, ChevronDown, Eye, FileText, FolderOpen, Layers, RotateCw, Sparkles, TriangleAlert } from 'lucide-react'
import { formatSize } from '@shared/downloads'
import { fileViewerUrl } from '@shared/files'
import { t } from '@shared/i18n/core'
import type { MemoryChange } from '@shared/ipc'
import { apex, call, errorText } from '../../api'
import { anchorFromElement, openSurface } from '../../overlay/useSurface'
import { Button, Spinner, cx, toast } from '../../ui'
import { NextSteps } from '../RequestBlocks'
import { useCompanion, useTabs } from '../hooks'
import { hostLabel } from '../logic/intake'
import { useComposerHandle } from '../composer/DropZone'
import { Favicon } from '../composer/icons'
import { useChat } from '../store'
import { artifactFormat, compactionLines, memoryOpLabel, partialKey, suggestionsLocked, tabCardState } from '../logic/replyCards'
import type { LogCardProps } from './registry'
import './cards.css'

// Reply cards (CH-26, CH-27, part of DS-63), registered by kind through
// registry.ts: the compaction divider, next steps, memory changes, a tab the
// agent opened, files and artifacts it made, and the partial notice. The
// pure wording and state rules live in replyCards.ts.

/** The chat's companion name, for card wording. */
function useChatName(chatId: string): string {
  const state = useChat(chatId)
  const companion = useCompanion(state.summary?.companionId ?? null)
  return companion?.name ?? t('composer.mention.kind.companion')
}

// ---- the compaction divider (CH-26) ----

export function CompactionCard({ item, chatId }: LogCardProps<'compaction'>): ReactElement {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const bodyId = useId()
  const name = useChatName(chatId)
  if (item.state === 'running') {
    return (
      <div className="cc-divider cc-divider--running" role="status">
        <span className="cc-divider__line" aria-hidden="true" />
        <span className="cc-divider__label">
          <Spinner size={12} />
          {t('composer.card.compaction.running')}
        </span>
        <span className="cc-divider__line" aria-hidden="true" />
      </div>
    )
  }
  if (item.state === 'failed') {
    return (
      <div className="cc-divider cc-divider--failed" role="alert">
        <span className="cc-divider__line" aria-hidden="true" />
        <span className="cc-divider__label">
          <TriangleAlert aria-hidden="true" />
          {t('composer.card.compaction.failed')}
          <Button
            size="sm"
            variant="ghost"
            loading={busy}
            onClick={() => {
              setBusy(true)
              void call('chats', 'compact', chatId)
                .catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
                .finally(() => setBusy(false))
            }}
          >
            {t('composer.card.compaction.retry')}
          </Button>
        </span>
        <span className="cc-divider__line" aria-hidden="true" />
      </div>
    )
  }
  const lines = compactionLines(item)
  return (
    <div className="cc-divider cc-divider--done">
      <div className="cc-divider__row">
        <span className="cc-divider__line" aria-hidden="true" />
        <button type="button" className="cc-divider__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <Layers aria-hidden="true" />
          <span>{t('composer.card.compaction.done')}</span>
          <span className="ui-sr-only">{open ? t('composer.card.compaction.hide') : t('composer.card.compaction.show')}</span>
          <ChevronDown aria-hidden="true" className={cx('cc-divider__chevron', open && 'cc-divider__chevron--open')} />
        </button>
        <span className="cc-divider__line" aria-hidden="true" />
      </div>
      <div id={bodyId} className="cc-divider__body" hidden={!open}>
        <p className="cc-divider__why">{lines.why}</p>
        {lines.replaced && <p className="cc-divider__why">{lines.replaced}</p>}
        {item.summary?.trim() ? <p className="cc-divider__summary">{item.summary}</p> : <p className="cc-divider__why">{t('composer.card.compaction.noSummary', { name })}</p>}
      </div>
    </div>
  )
}

// ---- next steps (CH-27, part of DS-63) ----

export function SuggestionsCard({ item, chatId }: LogCardProps<'suggestions'>): ReactElement | null {
  const composer = useComposerHandle()
  const state = useChat(chatId)
  if (item.items.length === 0) return null
  const locked = suggestionsLocked(state.log.items, item.id, state.log.status !== 'idle')
  return <NextSteps heading={item.heading} steps={item.items} composer={composer} locked={locked} />
}

// ---- memory saved or forgotten (CH-27) ----

const OP_ICON: Record<MemoryChange['op'], ReactElement> = {
  saved: <BookmarkCheck aria-hidden="true" />,
  updated: <BookmarkCheck aria-hidden="true" />,
  renamed: <ArrowRightLeft aria-hidden="true" />,
  forgotten: <BookmarkMinus aria-hidden="true" />,
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function MemoryCard({ item }: LogCardProps<'memory-change'>): ReactElement | null {
  if (item.changes.length === 0) return null
  return (
    <section className="cc-card cc-memory" aria-label={t('composer.card.memory.title', { count: item.changes.length })}>
      <p className="cc-card__title">
        <Sparkles aria-hidden="true" />
        {t('composer.card.memory.title', { count: item.changes.length })}
      </p>
      <ul className="cc-memory__list">
        {item.changes.map((change, i) => {
          const path = change.op === 'renamed' && change.to ? change.to : change.path
          const name = fileName(path)
          return (
            <li key={`${change.path}:${i}`} className={cx('cc-memory__row', change.op === 'forgotten' && 'cc-memory__row--gone')}>
              <span className="cc-memory__icon">{OP_ICON[change.op]}</span>
              <span className="cc-memory__text">
                <span className="cc-memory__op">{memoryOpLabel(change.op)}</span>
                <span className="cc-memory__name">{change.op === 'renamed' && change.to ? t('composer.card.memory.renamedTo', { from: fileName(change.path), to: name }) : name}</span>
              </span>
              {change.op !== 'forgotten' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('composer.card.memory.openNamed', { name })}
                  onClick={() => void call('pages', 'open', fileViewerUrl({ kind: 'memory', owner: change.owner, path }, { name })).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))}
                >
                  {t('composer.card.memory.open')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---- a tab the agent opened (CH-27) ----

export function TabOpenedCard({ item }: LogCardProps<'tab-opened'>): ReactElement {
  const tabs = useTabs()
  const tab = tabs.tabs.find((x) => x.id === item.tabId)
  const state = tabCardState(item.tabId, tabs.tabs.map((x) => x.id), tabs.activeId)
  const title = tab?.title || item.title || hostLabel(item.url)
  return (
    <section className="cc-card cc-tab" aria-label={t('composer.card.tab.opened')}>
      <span className="cc-tab__icon">{tab?.favicon ? <Favicon src={tab.favicon} /> : <AppWindow aria-hidden="true" />}</span>
      <span className="cc-tab__text">
        <span className="cc-tab__title">{title}</span>
        <span className="cc-tab__detail">{state === 'closed' ? t('composer.card.tab.closed') : `${t('composer.card.tab.opened')} · ${hostLabel(item.url)}`}</span>
      </span>
      {state === 'open' && (
        <Button size="sm" onClick={() => void apex.tabs.activate(item.tabId)}>
          {t('composer.card.tab.switch')}
        </Button>
      )}
      {state === 'active' && <span className="cc-tab__current">{t('composer.card.tab.current')}</span>}
      {state === 'closed' && /^https?:/.test(item.url) && (
        <Button size="sm" variant="ghost" onClick={() => void apex.tabs.create(item.url)}>
          {t('composer.card.tab.reopen')}
        </Button>
      )}
    </section>
  )
}

// ---- files and artifacts it made (CH-27) ----

export function FileCard({ item }: LogCardProps<'file-produced'>): ReactElement {
  const file = item.file
  const fail = (err: unknown): void => {
    toast.show({ message: errorText(err), tone: 'error' })
  }
  if (file.artifact) {
    const format = artifactFormat(file.name, file.mediaType)
    return (
      <section className="cc-card cc-artifact" aria-label={t('composer.card.artifact.label')}>
        <span className={cx('cc-artifact__thumb', `cc-artifact__thumb--${format.toLowerCase()}`)} aria-hidden="true">
          <span className="cc-artifact__sheet" />
          <span className="cc-artifact__format">{format}</span>
        </span>
        <span className="cc-file__text">
          <span className="cc-file__name">{file.name}</span>
          <span className="cc-file__detail">{file.state === 'writing' ? t('composer.card.file.writing') : file.state === 'failed' ? t('composer.card.file.failed') : `${t('composer.card.artifact.label')} · ${formatSize(file.size)}`}</span>
        </span>
        {file.state === 'writing' && <Spinner size={14} />}
        {file.state === 'ready' && (
          <Button size="sm" aria-label={t('composer.card.artifact.openNamed', { name: file.name })} onClick={() => void call('files', 'openArtifact', file.id).catch(fail)}>
            {t('composer.card.artifact.open')}
          </Button>
        )}
      </section>
    )
  }
  return (
    <section className={cx('cc-card cc-file', file.state === 'failed' && 'cc-file--failed')} aria-label={t('composer.card.file.made')}>
      <span className="cc-file__icon">{file.state === 'failed' ? <TriangleAlert aria-hidden="true" /> : <FileText aria-hidden="true" />}</span>
      <span className="cc-file__text">
        <span className="cc-file__name">{file.name}</span>
        <span className="cc-file__detail">{file.state === 'writing' ? t('composer.card.file.writing') : file.state === 'failed' ? t('composer.card.file.failed') : formatSize(file.size)}</span>
      </span>
      {file.state === 'writing' && <Spinner size={14} />}
      {file.state === 'ready' && (
        <span className="cc-file__actions">
          <Button size="sm" onClick={() => void call('pages', 'open', fileViewerUrl({ kind: 'library', id: file.id }, { name: file.name })).catch(fail)}>
            {t('composer.card.file.open')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Eye size={14} />}
            onClick={(e) => void openSurface('quick-look', anchorFromElement(e.currentTarget), { target: { kind: 'library', id: file.id } }).catch(fail)}
          >
            {t('composer.card.file.quickLook')}
          </Button>
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void call('files', 'reveal', file.id).catch(fail)}>
            {t('composer.card.file.reveal')}
          </Button>
        </span>
      )}
    </section>
  )
}

// ---- the partial notice (CH-27) ----

export function PartialCard({ item, chatId }: LogCardProps<'partial'>): ReactElement {
  const name = useChatName(chatId)
  return (
    <p className="cc-partial" role="note">
      <TriangleAlert aria-hidden="true" />
      <span>{t(partialKey(item.reason), { name })}</span>
    </p>
  )
}

// ---- Compact and continue (part of SS-03) ----

/** On the chat-too-long error: summarizes the earlier part so the chat can go on. */
export function CompactAction({ chatId, onAct }: { chatId: string; onAct?(): void }): ReactElement {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="primary"
      icon={<RotateCw size={14} />}
      loading={busy}
      title={t('composer.card.compact.help')}
      onClick={() => {
        onAct?.()
        setBusy(true)
        void call('chats', 'compact', chatId)
          .catch((err: unknown) => toast.show({ message: t('composer.card.compact.failed', { reason: errorText(err) }), tone: 'error' }))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? t('composer.card.compact.working') : t('composer.card.compact.action')}
    </Button>
  )
}

