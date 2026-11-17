/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ComponentType, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { CalendarClock, ChevronRight, Circle, CircleCheck, CircleDot, FileText, Globe, KeyRound, Plug, Settings2, Sparkles, Wallet } from 'lucide-react'
import type { Companion } from '@shared/services'
import { formatUsd } from '@shared/pricing'
import { call } from '../api'
import { t } from '../i18n/useT'
import { engineCanSend } from '../settings/logic/engine'
import { IconButton, cx, useMediaQuery } from '../ui'
import { CompanionAvatar } from './CompanionAvatar'
import { useShell } from '../components/shellContext'
import { setDetailsOpen, setSectionCollapsed, useDetailsStore } from './detailsStore'
import { useRoutines, useSettingsView, useSpend } from './hooks'
import { useFileCount } from './holdings/ChatFilesButton'
import { DETAILS_OVERLAY_BELOW, detailsModel, detailsPrompt, isCollapsed, sectionCount, visibleSections, type DetailsModel, type DetailsSectionId } from './logic/details'
import { formatTokens } from './logic/view'
import type { ChatState } from './store'
import { TabsUsedSection } from './TabsUsed'

// The chat's details panel (DS-123, DS-124; CH-33). It draws the section
// model of logic/details.ts in DS-124's order: each section a 32 px header
// (collapse remembered) and its rows. A section's body can be replaced with
// registerDetailsSection (the CH-35 sections), so this file needs no edit
// for it. Its own section is "routine and tabs used" (context): the routine pill and the tabs list with Switch, Close and
// Close all.

export interface DetailsSectionProps {
  chatId: string
  state: ChatState
  model: DetailsModel
  companion: Companion | null | undefined
  /** What the chat holds (CH-28), for the files section; null while it loads. */
  heldFiles?: number | null
}

const sections = new Map<DetailsSectionId, ComponentType<DetailsSectionProps>>()

/** Replaces a section's body; returns the removal. */
export function registerDetailsSection(id: DetailsSectionId, Component: ComponentType<DetailsSectionProps>): () => void {
  sections.set(id, Component)
  return () => {
    if (sections.get(id) === Component) sections.delete(id)
  }
}

const TITLES: Record<DetailsSectionId, string> = {
  get companion() { return t('chat.detailsPanel.companion') },
  get plan() { return t('chat.detailsPanel.plan') },
  get connectors() { return t('chat.detailsPanel.connectors') },
  get skills() { return t('chat.detailsPanel.skillsUsed') },
  get files() { return t('chat.detailsPanel.files') },
  get context() { return t('chat.detailsPanel.routineAndTabsUsed') },
  subtasks: 'Sub-tasks',
  get sources() { return t('chat.detailsPanel.sources') },
  get usage() { return t('chat.detailsPanel.tokens') },
}

export interface DetailsPanelProps {
  chatId: string
  state: ChatState
  companion: Companion | null | undefined
  /** DS-123: closing; the panel fades and slides out while the column glides back. */
  leaving?: boolean
}

/** The column beside a chat page (an overlay in a narrow window): no fill or divider, a floating card, and a slot below it. */
export function DetailsPanel({ chatId, state, companion, leaving = false }: DetailsPanelProps): ReactElement {
  const store = useDetailsStore()
  const held = useFileCount(chatId)
  const overlay = useMediaQuery(`(max-width: ${DETAILS_OVERLAY_BELOW - 1}px)`)
  const model = useMemo(
    () =>
      detailsModel({
        items: state.log.items,
        details: state.details,
        connectorIds: state.setup?.connectorIds ?? [],
        connectorNames: {},
        routineId: state.summary?.routineId ?? null,
        usedTabIds: state.usedTabIds,
      }),
    [state.log.items, state.details, state.setup?.connectorIds, state.summary?.routineId, state.usedTabIds],
  )
  const ids = visibleSections(model, held ?? 0)
  // The header's toggle sits above the card; Escape also closes the panel from inside it.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    setDetailsOpen(false, chatId)
  }
  return (
    <aside className={cx('chat-details', overlay && 'chat-details--overlay', leaving && 'chat-details--leaving')} aria-label={t('chat.detailsPanel.chatDetails')} inert={leaving} onKeyDown={onKeyDown}>
      <div className="chat-details__card">
        <div className="chat-details__scroll">
          {ids.map((id) => {
            const collapsed = isCollapsed(id, store.collapsed)
            const count = sectionCount(model, id, held ?? 0)
            const Body = sections.get(id) ?? DEFAULT_BODIES[id]
            return (
              <section key={id} className={cx('chat-details__section', collapsed && 'chat-details__section--collapsed')} aria-label={TITLES[id]}>
                {id !== 'companion' && (
                  // DS-124: the count sits inline after the label; a 12 px chevron shows only when collapsed.
                  <button type="button" className="chat-details__head" aria-expanded={!collapsed} onClick={() => setSectionCollapsed(id, !collapsed)}>
                    <span className="chat-details__title">{TITLES[id]}</span>
                    {count !== null && collapsed && <span className="chat-details__count">{count}</span>}
                    {collapsed && <ChevronRight size={12} aria-hidden="true" className="chat-details__chevron" />}
                  </button>
                )}
                {(!collapsed || id === 'companion') && <Body chatId={chatId} state={state} model={model} companion={companion} heldFiles={held} />}
              </section>
            )
          })}
        </div>
      </div>
      <DetailsBelow state={state} companion={companion} />
    </aside>
  )
}

/** DS-123: the slot below the card: a full-width 32 px action pill and a two-line centred muted caption, for an API key or usage, never an upsell. */
function DetailsBelow({ state, companion }: { state: ChatState; companion: Companion | null | undefined }): ReactElement | null {
  const settings = useSettingsView()
  const spend = useSpend()
  const engine = state.setup?.engine ?? companion?.engine ?? settings.engine
  const prompt = detailsPrompt({ canSend: engineCanSend(engine, settings.hasApiKey), engine, spend })
  if (!prompt) return null
  const name = companion?.name ?? t('chat.details.below.yourCompanion')
  return (
    <div className="chat-details__below">
      <button type="button" className="chat-details__pill" onClick={() => void call('pages', 'open', prompt.url)}>
        {prompt.kind === 'api-key' ? <KeyRound size={14} aria-hidden="true" /> : <Wallet size={14} aria-hidden="true" />}
        {prompt.kind === 'api-key' ? t('chat.details.below.keyAction') : t('chat.details.below.budgetAction')}
      </button>
      <p className="chat-details__caption">
        {prompt.kind === 'api-key'
          ? t('chat.details.below.keyCaption', { name })
          : t('chat.details.below.budgetCaption', { spent: formatUsd(prompt.usd), budget: formatUsd(prompt.budgetUsd) })}
      </p>
    </div>
  )
}

function Row({ icon, label, trailing, onClick, title }: { icon: ReactNode; label: ReactNode; trailing?: ReactNode; onClick?(): void; title?: string }): ReactElement {
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

function CompanionSection({ companion }: DetailsSectionProps): ReactElement {
  const shell = useShell()
  const name = companion?.name ?? t('chat.detailsPanel.yourCompanion')
  return (
    <Row
      icon={<CompanionAvatar companion={companion} size={20} label="" />}
      label={name}
      trailing={<Settings2 size={14} />}
      title={t('chat.detailsPanel.sCard', { name })}
      // DS-122/DS-48: the card opens over the chat column it came from (the row is its opener).
      onClick={() => companion && shell.openCompanionCard(companion.id, 'general')}
    />
  )
}

function PlanSection({ model }: DetailsSectionProps): ReactElement {
  return (
    <ul className="chat-details__list">
      {model.plan.map((item) => (
        <li key={item.id}>
          <Row icon={item.status === 'done' ? <CircleCheck size={14} /> : item.status === 'active' ? <CircleDot size={14} /> : <Circle size={14} />} label={<span className={cx(item.status === 'skipped' && 'chat-details__struck')}>{item.title}</span>} />
        </li>
      ))}
    </ul>
  )
}

function ConnectorsSection({ model }: DetailsSectionProps): ReactElement {
  return <ul className="chat-details__list">{model.connectors.map((c) => <li key={c.id}><Row icon={<Plug size={14} />} label={c.name} /></li>)}</ul>
}

function SkillsSection({ model }: DetailsSectionProps): ReactElement {
  return <ul className="chat-details__list">{model.skills.map((s) => <li key={s.id}><Row icon={<Sparkles size={14} />} label={s.name} /></li>)}</ul>
}

function FilesSection({ model }: DetailsSectionProps): ReactElement {
  return <ul className="chat-details__list">{model.files.map((f) => <li key={f.id}><Row icon={<FileText size={14} />} label={f.name} /></li>)}</ul>
}

/** CH-33: the routine this chat belongs to, and the tabs it used. */
function ContextSection({ chatId, state }: DetailsSectionProps): ReactElement {
  const routines = useRoutines()
  const routineId = state.summary?.routineId ?? null
  const routine = routineId ? routines?.find((r) => r.id === routineId) : null
  return (
    <div className="chat-details__context">
      {routineId && <Row icon={<CalendarClock size={14} />} label={routine?.name ?? t('chat.detailsPanel.routine')} onClick={() => void call('pages', 'open', `atelier://routines/${routineId}`)} />}
      <TabsUsedSection chatId={chatId} state={state} />
    </div>
  )
}

function SubtasksSection({ model }: DetailsSectionProps): ReactElement {
  return (
    <ul className="chat-details__list">
      {model.subtasks.map((s) => (
        <li key={s.id}>
          <Row icon={s.status === 'done' ? <CircleCheck size={14} /> : <CircleDot size={14} />} label={s.title} onClick={() => void call('pages', 'open', `atelier://chat/${s.childChatId}`)} />
        </li>
      ))}
    </ul>
  )
}

function SourcesSection({ model }: DetailsSectionProps): ReactElement {
  return <ul className="chat-details__list">{model.sources.map((s) => <li key={s.url}><Row icon={<Globe size={14} />} label={s.title || s.url} title={s.url} /></li>)}</ul>
}

function UsageSection({ model }: DetailsSectionProps): ReactElement {
  const total = model.tokens.inputTokens + model.tokens.outputTokens + model.tokens.cacheReadTokens + model.tokens.cacheWriteTokens
  return <Row icon={<Sparkles size={14} />} label={t('chat.detailsPanel.tokenCount', { value: formatTokens(total) })} trailing={t('chat.detailsPanel.replyCount', { count: model.tokens.turns })} />
}

const DEFAULT_BODIES: Record<DetailsSectionId, ComponentType<DetailsSectionProps>> = {
  companion: CompanionSection,
  plan: PlanSection,
  connectors: ConnectorsSection,
  skills: SkillsSection,
  files: FilesSection,
  context: ContextSection,
  subtasks: SubtasksSection,
  sources: SourcesSection,
  usage: UsageSection,
}

/** The header's toggle for the panel (chat pages only). */
export function DetailsToggle({ chatId }: { chatId: string }): ReactElement {
  const { open } = useDetailsStore()
  return <IconButton label={open ? t('chat.detailsPanel.hideDetails') : t('chat.detailsPanel.showDetails')} aria-pressed={open} icon={<Settings2 />} onClick={() => setDetailsOpen(!open, chatId)} />
}

