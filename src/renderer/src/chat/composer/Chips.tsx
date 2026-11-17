/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement, ReactNode } from 'react'
import { AudioLines, ExternalLink, FileCog, ImageIcon, RotateCw, TriangleAlert, X } from 'lucide-react'
import type { AttachmentRef } from '@shared/attachments'
import { UNSETTLED_STATUSES } from '@shared/meetings'
import { t } from '@shared/i18n/core'
import { atelier } from '../../api'
import { Button, Spinner, cx } from '../../ui'
import { cancelHold, useHeldSend } from '../attachments/holds'
import { removeFromDraft, useDraftAttachments } from '../attachments/drafts'
import { meetingStatus, meetingTitle, useMeetingStatusVersion } from '../../meetings/status'
import { CompanionAvatar } from '../CompanionAvatar'
import { useChatList, useCompanionList, useTabs } from '../hooks'
import { chipView, hostLabel, type ChipView, type Gate } from '../logic/intake'
import { Favicon, KindIcon } from './icons'
import { dismissRejected, removeAttachment, retryAttachment, useDraftIntake } from './store'

// The chips row above the composer's text (CH-22): one chip per attachment
// with its glyph or thumbnail, name and sublabel, in preparing, ready or
// failed (with Retry), each removable. The meeting and screenshot
// chips share the row, a meeting waiting on its transcript shows it, and a
// held send shows here with Cancel (MV-14). Files turned away before they
// were read keep a chip with the reason until dismissed.

function Lead({ view, children }: { view: ChipView; children?: ReactNode }): ReactElement {
  if (view.thumbnail) return <img className="cmp-chip__thumb" src={view.thumbnail} alt="" draggable={false} />
  return <>{children ?? <KindIcon kind={view.kind} />}</>
}

/** The tab's favicon, or the chat's companion, beside a tab or chat chip. */
function useLeadFor(): (ref: AttachmentRef) => ReactNode | undefined {
  const tabs = useTabs()
  const chats = useChatList()
  const companions = useCompanionList()
  return (ref) => {
    if (ref.kind === 'tab' && ref.source?.tabId) {
      const tab = tabs.tabs.find((tb) => tb.id === ref.source?.tabId)
      return tab ? <Favicon src={tab.favicon} /> : undefined
    }
    if (ref.kind === 'chat' && ref.sourceId) {
      const chat = chats?.find((c) => c.id === ref.sourceId)
      const companion = chat ? companions.items.find((c) => c.id === chat.companionId) : undefined
      return companion ? <CompanionAvatar companion={companion} size={18} label="" /> : undefined
    }
    return undefined
  }
}

export interface ChipProps {
  view: ChipView
  lead?: ReactNode
  onRemove?(): void
  onRetry?(): void
  onOpen?(el: HTMLElement): void
}

export function Chip({ view, lead, onRemove, onRetry, onOpen }: ChipProps): ReactElement {
  const body = (
    <>
      <span className="cmp-chip__lead" aria-hidden="true">
        {view.state === 'preparing' ? <Spinner size={14} /> : view.state === 'failed' ? <TriangleAlert /> : <Lead view={view}>{lead}</Lead>}
      </span>
      <span className="cmp-chip__text">
        <span className="cmp-chip__name">{view.name}</span>
        {view.sublabel && <span className="cmp-chip__sub">{view.sublabel}</span>}
      </span>
    </>
  )
  return (
    <li className={cx('cmp-chip', `cmp-chip--${view.state}`)} title={view.sourceUrl ?? undefined}>
      {onOpen ? (
        <button type="button" className="cmp-chip__main" aria-label={t('composer.chip.openNamed', { name: view.name })} onClick={(e) => onOpen(e.currentTarget)}>
          {body}
        </button>
      ) : (
        <span className="cmp-chip__main">{body}</span>
      )}
      {view.sourceUrl && view.state === 'ready' && (view.kind === 'selection' || view.kind === 'tab') && (
        <button
          type="button"
          className="cmp-chip__source"
          aria-label={t('composer.chip.openSource', { host: hostLabel(view.sourceUrl) })}
          onClick={() => void atelier.tabs.create(view.sourceUrl ?? undefined)}
        >
          <ExternalLink aria-hidden="true" />
        </button>
      )}
      {view.state === 'failed' && onRetry && (
        <button type="button" className="cmp-chip__retry" onClick={onRetry} aria-label={t('composer.chip.retryNamed', { name: view.name })}>
          <RotateCw aria-hidden="true" />
          <span>{t('composer.chip.retry')}</span>
        </button>
      )}
      {onRemove && (
        <button type="button" className="cmp-chip__remove" onClick={onRemove} aria-label={t('composer.chip.removeNamed', { name: view.name })}>
          <X aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

export interface IntakeChipsProps {
  chatId: string
  gate: Gate
  /** A paste chip opens its preview. */
  onOpenPaste(id: string, el: HTMLElement): void
  /** Cancelling a held send also puts the text back in the composer's field. */
  onCancelHold?(): void
}

/** The composer's chip row; nothing renders while the message carries nothing. */
export function IntakeChips({ chatId, gate, onOpenPaste, onCancelHold }: IntakeChipsProps): ReactElement | null {
  const intake = useDraftIntake(chatId)
  const b = useDraftAttachments(chatId)
  const hold = useHeldSend(chatId)
  useMeetingStatusVersion()
  const leadFor = useLeadFor()
  if (intake.items.length === 0 && intake.rejected.length === 0 && b.length === 0 && !hold) return null
  return (
    <div className="cmp-chips">
      <ul className="cmp-chips__list" aria-label={t('composer.chips.label')}>
        {/* While a send waits on a meeting (MV-14), the held attachments stay in view, named. */}
        {(hold ? [...b, ...hold.extra] : b).map((d, index) => {
          const meetingId = d.attachment.kind === 'meeting' ? d.attachment.meetingId : null
          const status = meetingId ? meetingStatus(meetingId) : null
          const waiting = status !== null && UNSETTLED_STATUSES.includes(status)
          const name = (meetingId ? meetingTitle(meetingId) : null) ?? d.label
          const view: ChipView = {
            id: meetingId ?? `b-${index}`,
            kind: meetingId ? 'meeting' : 'image',
            name: name || (meetingId ? t('composer.mention.untitled') : t('composer.paste.imageName')),
            sublabel: waiting ? t('composer.chip.waiting') : null,
            state: waiting ? 'preparing' : 'ready',
            thumbnail: d.thumbnail ?? null,
            sourceUrl: null,
            previewable: false,
            tabId: null,
          }
          return <Chip key={`b:${view.id}`} view={view} lead={meetingId ? <AudioLines /> : <ImageIcon />} onRemove={hold ? undefined : () => removeFromDraft(chatId, index)} />
        })}
        {intake.items.map((ref) => {
          const view = chipView(ref)
          return (
            <Chip
              key={ref.id}
              view={view}
              lead={leadFor(ref)}
              onRemove={() => removeAttachment(chatId, ref.id)}
              onRetry={() => void retryAttachment(chatId, ref.id)}
              {...(view.previewable ? { onOpen: (el: HTMLElement) => onOpenPaste(ref.id, el) } : {})}
            />
          )
        })}
        {intake.rejected.map((r) => (
          <Chip
            key={r.id}
            view={{ id: r.id, kind: 'text', name: r.name, sublabel: r.reason, state: 'failed', thumbnail: null, sourceUrl: null, previewable: false, tabId: null }}
            onRemove={() => dismissRejected(chatId, r.id)}
          />
        ))}
      </ul>
      {hold && (
        <div className="cmp-chips__held" role="status">
          <Spinner size={12} />
          <span>{t('composer.chip.held')}</span>
          <Button size="sm" variant="ghost" onClick={() => (onCancelHold ? onCancelHold() : cancelHold(chatId))}>{t('composer.chip.cancelHold')}</Button>
        </div>
      )}
      {!hold && gate.hint && (
        <p className="cmp-chips__hint" role="status">{gate.hint}</p>
      )}
    </div>
  )
}

/** What a sent message carried, read-only. Images and meetings draw their own chips beside these. */
export function SentChips({ items }: { items: readonly AttachmentRef[] }): ReactElement | null {
  const leadFor = useLeadFor()
  const shown = items.filter((a) => a.kind !== 'image' && a.kind !== 'meeting')
  if (shown.length === 0) return null
  return (
    <ul className="cmp-chips__list cmp-chips__list--sent" aria-label={t('composer.chips.label')}>
      {shown.map((ref) => (
        <Chip key={ref.id} view={{ ...chipView(ref), state: 'ready', sublabel: chipView({ ...ref, state: 'ready' }).sublabel }} lead={leadFor(ref)} />
      ))}
    </ul>
  )
}

/** The inline editor's chips (CH-09): the message's attachments, each removable, plus any added while editing. */
export function EditChips({ items, onRemove, onRetry }: { items: readonly AttachmentRef[]; onRemove(id: string): void; onRetry?(id: string): void }): ReactElement | null {
  const leadFor = useLeadFor()
  if (items.length === 0) return null
  return (
    <ul className="cmp-chips__list" aria-label={t('composer.edit.attachments')}>
      {items.map((ref) => (
        <Chip key={ref.id} view={chipView(ref)} lead={leadFor(ref)} onRemove={() => onRemove(ref.id)} {...(onRetry ? { onRetry: () => onRetry(ref.id) } : {})} />
      ))}
    </ul>
  )
}

/** The quiet badge for a chat with the files-and-documents ability on (CH-22): server-side code execution is enabled. */
export function DocumentsBadge({ on, name }: { on: boolean; name: string }): ReactElement | null {
  if (!on) return null
  const tip = t('composer.documents.tooltip', { name })
  return (
    <span className="cmp-docs" title={tip}>
      <FileCog aria-hidden="true" />
      <span>{t('composer.documents.badge')}</span>
      <span className="ui-sr-only">{tip}</span>
    </span>
  )
}
