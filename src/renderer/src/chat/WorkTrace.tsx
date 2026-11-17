/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { AppWindow, Bookmark, Brain, ChevronRight, Globe, MousePointer2, Plug, Search, Wrench } from 'lucide-react'
import { atelier } from '../api'
import { t } from '../i18n/useT'
import { cx } from '../ui'
import { useSettingsView, useTabs } from './hooks'
import { formatTimer } from './logic/view'
import { currentStep, foldConnectors, stepElapsed } from './logic/status'
import { activityLine, foldStack, workSummary, type FoldTile, type ReplyPart, type StepKind, type ToolItem } from './logic/work'
import type { ChatState } from './store'

// DS-55 / CH-19: the work fold. Consecutive steps fold into one line (what is
// happening or what was done, connector and site tiles, a live timer for the
// current step). Expanded, each step opens to its input, result and error.

/** A clock that ticks every second while `active`. */
export function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export interface WorkFoldProps {
  part: Extract<ReplyPart, { kind: 'work' }>
  name: string
  /** The fold is the run's current activity. */
  live: boolean
  startedAt: number | null
  state: ChatState
}

export function WorkFold({ part, name, live, startedAt, state }: WorkFoldProps): ReactElement {
  const [open, setOpen] = useState(false)
  const running = live && part.running
  const line = running ? activityLine(part.steps, name) : workSummary(part.steps)
  const current = running ? currentStep(part.steps) : null
  const now = useSecondTick(running)
  // The timer follows the current step when it has a start time; else the run.
  const stepTime = current ? stepElapsed(current, now) : null
  const elapsed = stepTime ?? (running && startedAt !== null ? now - startedAt : null)
  const stack = foldStack(part.steps, foldConnectors(part.steps))
  return (
    <div className={cx('chat-work', open && 'chat-work--open', running && 'chat-work--running')}>
      <button type="button" className="chat-work__line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {/* DS-55: the disclosure sits in the gutter, a grey circle centred on the tiles. */}
        <span className="chat-work__disclose" aria-hidden="true"><ChevronRight size={14} className="chat-work__chevron" /></span>
        <FoldTiles tiles={stack.tiles} state={state} />
        <span className="chat-work__roll">
          <span className="chat-work__label">
            <span className={cx('chat-work__what', running && 'chat-sweep')} data-text={line}>{line}</span>
            {stack.more > 0 && <span className="chat-work__more"> {t('chat.work.more', { count: stack.more })}</span>}
            {elapsed !== null && <span className="chat-status__timer"> · {formatTimer(elapsed)}</span>}
            {part.failed > 0 && !running && <span className="chat-work__failed"> · {t('chat.workTrace.stepsFailed', { count: part.failed })}</span>}
          </span>
          <span className="chat-work__toggle" aria-hidden="true">{open ? t('chat.workTrace.hideDetails') : t('chat.workTrace.showDetails')}</span>
        </span>
        <span className="ui-sr-only">{open ? t('chat.workTrace.hideDetails2') : t('chat.workTrace.showDetails2')}</span>
      </button>
      <div className="chat-work__trace" inert={!open}>
        <ol className="chat-work__steps">
          {part.items.map((item) =>
            item.kind === 'tool' ? (
              <WorkStep key={item.id} item={item} live={live} now={now} />
            ) : (
              <li key={item.id} className="chat-step chat-step--thought">
                <span className="chat-step__dot" aria-hidden="true" />
                <span className="chat-step__thought">{item.thinking || t('chat.workTrace.thinking')}</span>
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  )
}

/** One step: its label, connector and time, opening to the input, the result summary and any error. */
function WorkStep({ item, live, now }: { item: ToolItem; live: boolean; now: number }): ReactElement {
  const [open, setOpen] = useState(false)
  const step = item.step
  const error = item.state === 'error' ? (item.detail ?? '').replace(/^Error: /, '') : ''
  const input = step?.input?.trim() ?? ''
  const result = item.state !== 'error' ? (step?.result?.trim() || (item.state === 'done' ? item.detail?.trim() : '') || '') : ''
  const expandable = Boolean(input || result || error)
  const elapsed = stepElapsed(item, now)
  const running = item.state === 'running' && live
  const head = (
    <>
      <span className="chat-step__dot" aria-hidden="true" />
      {step?.connector && <Plug size={11} className="chat-step__plug" aria-hidden="true" />}
      <span className={cx('chat-step__label', running && 'chat-sweep')} data-text={item.label}>{item.label}</span>
      {step?.connector && <span className="chat-step__via">{t('chat.work.via', { name: step.connector.name })}</span>}
      {elapsed !== null && (running || elapsed >= 1000) && <span className="chat-step__time">{running ? formatTimer(elapsed) : t('chat.work.took', { time: formatTimer(elapsed) })}</span>}
      {item.state === 'running' && <span className="ui-sr-only">{t('chat.work.running')}</span>}
      {error && !open && <span className="chat-step__detail">{error}</span>}
    </>
  )
  return (
    <li className={cx('chat-step', `chat-step--${item.state}`, open && 'chat-step--open')}>
      {expandable ? (
        <button type="button" className="chat-step__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {head}
          <ChevronRight size={12} className="chat-step__chevron" aria-hidden="true" />
        </button>
      ) : (
        <span className="chat-step__head">{head}</span>
      )}
      {open && (
        <dl className="chat-step__body">
          {input && (
            <>
              <dt>{t('chat.work.input')}</dt>
              <dd><pre>{input}</pre></dd>
            </>
          )}
          {result && (
            <>
              <dt>{t('chat.work.result')}</dt>
              <dd><pre>{result}</pre></dd>
            </>
          )}
          {error && (
            <>
              <dt>{t('chat.work.error')}</dt>
              <dd className="chat-step__error">{error}</dd>
            </>
          )}
        </dl>
      )}
    </li>
  )
}

/** DS-55: Atelier's glyph for a kind of work, on a tile when no site or connector shows. */
const WORK_GLYPH: Record<StepKind, ReactElement> = {
  page: <Globe />,
  search: <Search />,
  act: <MousePointer2 />,
  tabs: <AppWindow />,
  memory: <Bookmark />,
  other: <Wrench />,
}

/** The fold's tiles (foldStack): white cards about 36 px apart, connectors first, then the sites it touched as favicons (open tabs supply them). */
function FoldTiles({ tiles, state }: { tiles: readonly FoldTile[]; state: ChatState }): ReactElement {
  const tabs = useTabs()
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  // Page steps without a URL act on the chat's own tabs, so their tile takes that tab's favicon.
  const own = tabs.tabs.find((tab) => state.tabIds.includes(tab.id) && tab.favicon)?.favicon ?? null
  return (
    <span className="chat-work__icons" aria-hidden="true">
      {tiles.map((tile) => {
        if (tile.kind === 'connector') {
          return (
            <span key={`c:${tile.id}`} className="chat-work__icon chat-work__icon--glyph chat-work__icon--connector" title={tile.name}>
              <Plug />
            </span>
          )
        }
        if (tile.kind === 'site') {
          const src = tabs.tabs.find((tab) => tab.favicon && hostOf(tab.url) === tile.host)?.favicon ?? null
          return (
            <span key={`s:${tile.host}`} className={cx('chat-work__icon', !src && 'chat-work__icon--glyph')} title={tile.host}>
              {src ? <img src={src} alt="" draggable={false} /> : <Globe />}
            </span>
          )
        }
        return (
          <span key={`w:${tile.step}`} className={cx('chat-work__icon', !(tile.step === 'page' && own) && 'chat-work__icon--glyph')}>
            {tile.step === 'page' && own ? <img src={own} alt="" draggable={false} /> : WORK_GLYPH[tile.step]}
          </span>
        )
      })}
    </span>
  )
}

// ---- reasoning (CH-19) ----

/** Per-reply overrides for this session; the default is the remembered setting. */
const reasoningShown = new Map<string, boolean>()

/** A reply's reasoning, shown or hidden. A toggle remembers the choice for the next replies too (showReasoning). */
export function Reasoning({ turnId, text }: { turnId: string; text: string }): ReactElement {
  const settings = useSettingsView()
  const [local, setLocal] = useState<boolean | undefined>(() => reasoningShown.get(turnId))
  const shown = local ?? settings.showReasoning ?? false
  const toggle = (): void => {
    const next = !shown
    reasoningShown.set(turnId, next)
    setLocal(next)
    void atelier.settings.set({ showReasoning: next }).catch(() => undefined)
  }
  return (
    <div className={cx('chat-thinking', shown && 'chat-thinking--open')}>
      <button type="button" className="chat-thinking__toggle" aria-expanded={shown} onClick={toggle}>
        <Brain size={13} aria-hidden="true" />
        <span>{shown ? t('chat.reasoning.hide') : t('chat.reasoning.show')}</span>
        <ChevronRight size={12} className="chat-thinking__chevron" aria-hidden="true" />
      </button>
      {shown && <p className="chat-thinking__text">{text}</p>}
    </div>
  )
}
