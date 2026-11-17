/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, Circle, CircleCheck, CircleDashed, CircleDot, ExternalLink, FileText, FolderOpen, Globe, Plug, RotateCw, ScrollText, Sparkles } from 'lucide-react'
import type { SystemPromptView } from '@shared/agentTools'
import type { Connector } from '@shared/services'
import type { UsageTotals } from '@shared/usage'
import { chatUrl, skillUrl, workspaceUrl } from '@shared/url'
import type { LogItem } from '../agentLog'
import { call, errorText, useAppEvent, useLiveList } from '../api'
import { useT } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { Button, Dialog, SkeletonRows, cx, formatCount, toast } from '../ui'
import { copyText } from './actions'
import { ChatView } from './ChatView'
import { registerDetailsSection, type DetailsSectionProps } from './DetailsPanel'
import { showChatFiles } from './holdings/ChatFilesButton'
import { ConnectorLogo } from '../connectors/ConnectorLogo'
import { autoOpenDetails, dockSubtask, useDetailsStore } from './detailsStore'
import { delegationTone, shouldAutoOpen, usageRows, viewerTargetFor, type DetailsFile } from './logic/details'
import { formatTokens } from './logic/view'
import './chatTools.css'

// Richer sections of the details panel (CH-35), registered over the
// plain bodies: the plan checklist, files that open, web sources, skills
// used, connectors by name, sub-tasks docked with their own composer, token
// usage from usage.chat, and View system prompt. The pure fold is
// logic/details.ts.

const fail = (err: unknown): void => {
  toast.show({ message: errorText(err), tone: 'error' })
}

function Row({ icon, label, trailing, onClick, title }: { icon: ReactNode; label: ReactNode; trailing?: ReactNode; onClick?(e: MouseEvent<HTMLButtonElement>): void; title?: string }): ReactElement {
  const inner = (
    <>
      <span className="chat-details__lead" aria-hidden="true">{icon}</span>
      <span className="chat-details__label">{label}</span>
      {trailing && <span className="chat-details__trail">{trailing}</span>}
    </>
  )
  return onClick ? (
    <button type="button" className="chat-details__row" title={title} onClick={onClick}>{inner}</button>
  ) : (
    <div className="chat-details__row" title={title}>{inner}</div>
  )
}

const PLAN_ICON = {
  pending: <Circle size={14} />,
  active: <CircleDot size={14} className="cd-details-plan__icon--active" />,
  done: <CircleCheck size={14} className="cd-details-plan__icon--done" />,
  skipped: <CircleDashed size={14} />,
} as const

function PlanSection({ model }: DetailsSectionProps): ReactElement {
  const t = useT()
  return (
    <ul className="chat-details__list" aria-label={`${t('chatTools.details.section.plan')}: ${model.planDone}/${model.plan.length}`}>
      {model.plan.map((item) => (
        <li key={item.id} aria-current={item.status === 'active' ? 'step' : undefined}>
          <Row
            icon={PLAN_ICON[item.status]}
            label={
              <span className={cx(`cd-details-plan__item--${item.status}`, item.status === 'skipped' && 'chat-details__struck')}>
                {item.title}
                <span className="ui-sr-only">, {t(`chatTools.details.plan.${item.status}`)}</span>
              </span>
            }
          />
        </li>
      ))}
    </ul>
  )
}

function openFile(file: DetailsFile, el: HTMLElement): void {
  const target = viewerTargetFor(file)
  if (target) void openSurface('quick-look', anchorFromElement(el), { target }).catch(fail)
  else void call('pages', 'open', workspaceUrl('files')).catch(fail)
}

function FilesSection({ chatId, model, heldFiles }: DetailsSectionProps): ReactElement {
  const t = useT()
  return (
    <ul className="chat-details__list">
      {model.files.map((f) => (
        <li key={f.id}>
          <Row icon={<FileText size={14} />} label={f.name} title={f.name} onClick={(e) => openFile(f, e.currentTarget)} />
        </li>
      ))}
      {/* DS-49/DS-124: the chat's files (CH-28) moved here from the header. */}
      <li>
        <Row icon={<FolderOpen size={14} />} label={t('files.chat.button')} trailing={heldFiles ? formatCount(heldFiles) : undefined} onClick={(e) => showChatFiles(chatId, e.currentTarget)} />
      </li>
    </ul>
  )
}

function SourcesSection({ model }: DetailsSectionProps): ReactElement {
  const host = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }
  return (
    <ul className="chat-details__list">
      {model.sources.map((s) => (
        <li key={s.url}>
          <Row icon={<Globe size={14} />} label={s.title || host(s.url)} trailing={<ExternalLink size={12} />} title={s.url} onClick={() => void call('pages', 'open', s.url, { newTab: true }).catch(fail)} />
        </li>
      ))}
    </ul>
  )
}

function SkillsSection({ model }: DetailsSectionProps): ReactElement {
  const t = useT()
  return (
    <ul className="chat-details__list">
      {model.skills.map((s) => (
        <li key={s.id}>
          <Row icon={<Sparkles size={14} />} label={`/${s.name}`} trailing={s.builtin ? <span className="cd-skill-chip__badge">{t('chatTools.skill.builtin')}</span> : undefined} onClick={() => void call('pages', 'open', skillUrl(s.id)).catch(fail)} />
        </li>
      ))}
    </ul>
  )
}

/** DS-124: how many logos the connectors row stacks. */
const LOGOS_SHOWN = 4

/** DS-124: one row for the chat's connectors: their names, and their logos stacked at the right. */
function ConnectorsSection({ model }: DetailsSectionProps): ReactElement {
  const [connectors] = useLiveList<Connector, 'connectors'>(() => call('connectors', 'list').catch(() => []), 'connectors', (e) => e.items)
  const rows = model.connectors.map((c) => ({ id: c.id, known: connectors.find((k) => k.id === c.id) ?? null, name: connectors.find((k) => k.id === c.id)?.name ?? c.name }))
  const names = rows.map((r) => r.name).join(', ')
  const only = rows.length === 1 ? rows[0] : null
  const stack = (
    <span className="chat-details__logos">
      {rows.slice(0, LOGOS_SHOWN).map((r) => (
        <ConnectorLogo key={r.id} name={r.name} logo={r.known?.logo ?? null} site={r.known?.url ?? null} size="sm" />
      ))}
    </span>
  )
  return (
    <ul className="chat-details__list">
      <li>
        <Row icon={<Plug size={14} />} label={names} title={names} trailing={stack} onClick={() => void call('pages', 'open', only ? `atelier://connectors/${only.id}` : 'atelier://connectors').catch(fail)} />
      </li>
    </ul>
  )
}

/** CH-32: sub-tasks; one can be docked here with its own composer, its header linking back. */
function SubtasksSection({ chatId, model }: DetailsSectionProps): ReactElement {
  const t = useT()
  const docked = useDetailsStore().docked[chatId] ?? null
  const child = docked ? model.subtasks.find((s) => s.childChatId === docked) : undefined
  if (docked && child) {
    return (
      <div className="cd-details-dock">
        <div className="cd-details-dock__head">
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} />} onClick={() => dockSubtask(chatId, null)}>{t('chatTools.details.subtask.back')}</Button>
          <span className="cd-details-dock__title" title={child.title}>{child.title}</span>
          <span className={`cd-pill cd-pill--${delegationTone(child.status)}`}>{t(`chatTools.delegation.status.${child.status}`)}</span>
        </div>
        <div className="cd-details-dock__chat">
          <ChatView chatId={child.childChatId} surfaceId={`details:${chatId}`} variant="panel" onChangeChat={(id) => void call('pages', 'open', chatUrl(id)).catch(fail)} />
        </div>
      </div>
    )
  }
  return (
    <ul className="chat-details__list">
      {model.subtasks.map((s) => (
        <li key={s.id}>
          <Row
            icon={s.status === 'done' ? <CircleCheck size={14} /> : <CircleDot size={14} />}
            label={s.title}
            trailing={<span className={`cd-pill cd-pill--${delegationTone(s.status)}`}>{t(`chatTools.delegation.status.${s.status}`)}</span>}
            onClick={() => dockSubtask(chatId, s.childChatId)}
          />
        </li>
      ))}
    </ul>
  )
}

type UsageLoad = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; totals: UsageTotals }

function UsageSection({ chatId, model }: DetailsSectionProps): ReactElement {
  const t = useT()
  const [load, setLoad] = useState<UsageLoad>({ phase: 'loading' })
  const [prompt, setPrompt] = useState(false)
  const fetchUsage = useCallback(() => {
    call('usage', 'chat', chatId).then(
      (totals) => setLoad({ phase: 'ready', totals }),
      () => setLoad({ phase: 'error' }),
    )
  }, [chatId])
  // Refetch after each turn: the turns' details change as replies finish.
  useEffect(fetchUsage, [fetchUsage, model.tokens.turns])
  useAppEvent('usage', () => fetchUsage())
  const rows = usageRows(model, load.phase === 'ready' ? load.totals : null)
  return (
    <div>
      {load.phase === 'loading' && model.tokens.turns === 0 ? (
        <SkeletonRows rows={2} />
      ) : (
        <>
          <dl className="cd-details-usage">
            <dt>{t('chatTools.details.usage.input')}</dt>
            <dd>{formatTokens(rows.input)}</dd>
            <dt>{t('chatTools.details.usage.output')}</dt>
            <dd>{formatTokens(rows.output)}</dd>
            <dt>{t('chatTools.details.usage.cacheRead')}</dt>
            <dd>{formatTokens(rows.cacheRead)}</dd>
            <dt>{t('chatTools.details.usage.cacheWrite')}</dt>
            <dd>{formatTokens(rows.cacheWrite)}</dd>
            <dt>{t('chatTools.details.usage.turns')}</dt>
            <dd>{formatCount(rows.turns)}</dd>
            {rows.costUsd !== null && (
              <>
                <dt>{t('chatTools.details.usage.cost')}</dt>
                <dd>${rows.costUsd < 0.01 && rows.costUsd > 0 ? '<0.01' : rows.costUsd.toFixed(2)}</dd>
              </>
            )}
          </dl>
          {load.phase === 'ready' && <p className="cd-details-note">{rows.costUsd !== null ? t('chatTools.details.usage.estimate') : t('chatTools.details.usage.tokensOnly')}</p>}
        </>
      )}
      {load.phase === 'error' && (
        <div className="cd-details-error" role="alert">
          <span>{t('chatTools.details.usage.error')}</span>
          <Button size="sm" variant="ghost" icon={<RotateCw size={12} />} onClick={() => {
            setLoad({ phase: 'loading' })
            fetchUsage()
          }}>{t('chatTools.details.retry')}</Button>
        </div>
      )}
      <Row icon={<ScrollText size={14} />} label={t('chatTools.details.systemPrompt')} onClick={() => setPrompt(true)} />
      {prompt && <SystemPromptDialog chatId={chatId} onClose={() => setPrompt(false)} />}
    </div>
  )
}

type PromptLoad = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; view: SystemPromptView }

/** The prompt viewer: this chat's prompt (fixed at its first message) and its tools. */
export function SystemPromptDialog({ chatId, onClose }: { chatId: string; onClose(): void }): ReactElement {
  const t = useT()
  const [load, setLoad] = useState<PromptLoad>({ phase: 'loading' })
  const [copied, setCopied] = useState(false)
  const fetchPrompt = useCallback(() => {
    setLoad({ phase: 'loading' })
    call('agent', 'systemPrompt', { chatId }).then(
      (view) => setLoad({ phase: 'ready', view }),
      (err: unknown) => setLoad({ phase: 'error', message: errorText(err) }),
    )
  }, [chatId])
  useEffect(fetchPrompt, [fetchPrompt])
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('chatTools.prompt.title')}
      footer={
        <>
          {load.phase === 'ready' && (
            <Button variant="secondary" onClick={() => void copyText(load.view.system).then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1600)))}>
              {copied ? t('chatTools.prompt.copied') : t('chatTools.prompt.copy')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>{t('chatTools.prompt.close')}</Button>
        </>
      }
    >
      {load.phase === 'loading' && <SkeletonRows rows={5} />}
      {load.phase === 'error' && (
        <div className="cd-export__error" role="alert">
          <span>{t('chatTools.prompt.error')}</span>
          <Button size="sm" variant="ghost" icon={<RotateCw size={13} />} onClick={fetchPrompt}>{t('chatTools.details.retry')}</Button>
        </div>
      )}
      {load.phase === 'ready' && (
        <>
          <p className="cd-prompt__meta">{load.view.frozen ? t('chatTools.prompt.frozen') : t('chatTools.prompt.next')}</p>
          <pre className="cd-prompt" tabIndex={0}>{load.view.system}</pre>
          {load.view.tools.length > 0 && (
            <>
              <p className="cd-prompt__meta" style={{ marginTop: 'var(--space-3)' }}>{t('chatTools.prompt.tools')}</p>
              <ul className="cd-prompt__tools">{load.view.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
            </>
          )}
        </>
      )}
    </Dialog>
  )
}

/** CH-35: the panel opens by itself once per chat, on the first plan or produced file. */
export function useDetailsAutoOpen(chatId: string, items: readonly LogItem[]): void {
  const decided = useDetailsStore().decided.has(chatId)
  const want = shouldAutoOpen(items, decided)
  useEffect(() => {
    if (want) autoOpenDetails(chatId)
  }, [want, chatId])
}

let registered = false

/** Puts these section bodies over the plain defaults; idempotent. */
export function registerDetailsSections(): void {
  if (registered) return
  registered = true
  registerDetailsSection('plan', PlanSection)
  registerDetailsSection('files', FilesSection)
  registerDetailsSection('sources', SourcesSection)
  registerDetailsSection('skills', SkillsSection)
  registerDetailsSection('connectors', ConnectorsSection)
  registerDetailsSection('subtasks', SubtasksSection)
  registerDetailsSection('usage', UsageSection)
}

registerDetailsSections()
