/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { AppWindow, Brain, CalendarClock, Copy, Cpu, Eye, EyeOff, Folder, MessageSquarePlus, RotateCcw, Trash2, UserRound, UserRoundX, WandSparkles, X } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { COMPANION_LOOK_ITEM, chatUrl, companionUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { companionsSnapshot, reloadCompanions, useCompanions, type CompanionsState } from '../components/companionData'
import { usePageStills } from '../companion-card/Backdrop'
import { tabsSnapshot } from '../companion-card/liveTabs'
import { CardHeader } from '../companion-card/CardHeader'
import { CardLayer, useCardPlacement } from '../companion-card/CardLayer'
import { CardSavesProvider, FloatingSave, useCardSaveRegistry, useReportSave } from '../companion-card/CardSaves'
import { CardTabs, type CardTab } from '../companion-card/CardTabs'
import { ExportDialog } from '../companion-card/ExportDialog'
import { FilesTab } from '../companion-card/FilesTab'
import { GeneralTab, type LookPhase } from '../companion-card/GeneralTab'
import { cardFrame, shareForWidth } from '../companion-card/logic/cardLayout'
import { isLastVisible, successorAfterRemoval } from '../companion-card/logic/cycle'
import { itemToPath } from '../companion-card/logic/notes'
import type { SaveRegistry } from '../companion-card/logic/saves'
import { SECTION_LABELS, normalizeSection, type CardSection } from '../companion-card/logic/sections'
import { MemoryTab } from '../companion-card/MemoryTab'
import { ModelsTab } from '../companion-card/ModelsTab'
import { motionMs } from '../companion-card/motion'
import { Nested } from '../companion-card/Nested'
import { RoutinesTab } from '../companion-card/RoutinesTab'
import { CompanionSheets } from '../companion-card/sheets'
import { SkillsTab } from '../companion-card/SkillsTab'
import { useLoaded } from '../companion-card/useLoaded'
import { useSaveTracker } from '../companion-card/useSaveTracker'
import { Button, cx, EmptyState, ErrorState, IconButton, ModalScope, Seam, Skeleton, SkeletonRows, TabPanel, confirm, showPopoverMenu, toast, type PopoverItem } from '../ui'
import '../companion-card/card.css'
import { useT } from '../i18n/useT'

export interface CompanionCardProps {
  companionId: string
  /** A tab: general, skills, routines, files, memory or models. Unknown values open General. */
  section: string | null
  /** One skill or routine id, or an encoded file or note path, from apex://companion/<id>/<section>/<item>. */
  item?: string | null
  /** An apex://companion tab: the card fills the content area as a page, and close closes the tab (DS-121). */
  asPage?: boolean
  onClose(): void
}

const SECTIONS: CardSection[] = ['general', 'skills', 'routines', 'files', 'memory', 'models']
const SECTION_ICONS: Record<CardSection, ReactElement> = {
  general: <UserRound />,
  skills: <WandSparkles />,
  routines: <CalendarClock />,
  files: <Folder />,
  memory: <Brain />,
  models: <Cpu />,
}

/** The remembered width, as a share of the content area, so it suits any window size. */
const WIDTH_KEY = 'apex.companionCard.share'

function readShare(): number | null {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n > 0 && n < 1 ? n : null
  } catch {
    return null
  }
}

function writeShare(share: number | null): void {
  try {
    if (share === null) localStorage.removeItem(WIDTH_KEY)
    else localStorage.setItem(WIDTH_KEY, String(share))
  } catch {
    // A per-window convenience; losing it only resets the width.
  }
}

/**
 * The companion profile card. It floats over the washed content area (or
 * fills the chat column it was opened from), follows its props when the
 * route changes, and keeps its own place (companion, tab) as you move
 * around inside it. Every way out saves pending edits, then fades.
 */
export function CompanionCard({ companionId, section, item = null, asPage = false, onClose }: CompanionCardProps) {
  const t = useT()
  const placement = useCardPlacement(asPage)
  const stills = usePageStills(placement.mode === 'float')
  const state = useCompanions()
  const registry = useCardSaveRegistry()
  const [currentId, setCurrentId] = useState(companionId)
  // apex://companion/<id>/general/look opens with the look editor on.
  const lookAsked = item === COMPANION_LOOK_ITEM
  const [tab, setTab] = useState<CardSection>(() => normalizeSection(section))
  const [focusItem, setFocusItem] = useState<string | null>(lookAsked ? null : item)
  const [look, setLook] = useState<LookPhase>(lookAsked ? 'on' : 'off')
  const [leaving, setLeaving] = useState(false)
  const [share, setShare] = useState(readShare)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const titleId = useId()
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const later = (fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms))
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => setCurrentId(companionId), [companionId])
  useEffect(() => {
    setTab(normalizeSection(section))
    setFocusItem(lookAsked ? null : item)
    if (lookAsked) setLook('on')
  }, [section, item])

  const setLookOpen = (open: boolean): void => {
    if (open) {
      setLook('on')
      return
    }
    setLook((phase) => (phase === 'on' ? 'leaving' : phase))
    // Done drops /look from the tab's address, so asking for the look editor again opens it again.
    if (lookAsked) followUrl(currentId, tab)
    // The exit is quicker than the entrance.
    later(() => setLook((phase) => (phase === 'leaving' ? 'off' : phase)), motionMs('--motion-exit', 160))
  }

  // Esc pressed twice while edits flush must not close (or go back) twice.
  const closing = useRef(false)
  const close = async (): Promise<void> => {
    if (closing.current) return
    closing.current = true
    if (look !== 'off') setLookOpen(false)
    await registry.flushAll()
    setLeaving(true)
    later(onClose, motionMs('--motion-exit', 160))
  }
  // Esc leaves the look editor, then closes a floating card. As a full tab
  // (DS-121) only the close button closes it: Esc never closes a tab.
  const escape = (): void => {
    if (look === 'on') setLookOpen(false)
    else if (!asPage) void close()
  }
  // DS-121: as a tab, the address, breadcrumb and title follow the card. The
  // tab's internal address is replaced in place, so no history entry piles up.
  const followUrl = (id: string, next: CardSection): void => {
    if (!asPage) return
    const snap = tabsSnapshot()
    const tab = snap.tabs.find((t) => t.id === snap.activeId)
    if (!tab?.url.startsWith('apex://companion')) return
    const url = companionUrl(id, next === 'general' ? null : next)
    if (tab.url !== url) void apex.nav.go(tab.id, url).catch(() => undefined)
  }
  const switchTo = async (id: string): Promise<void> => {
    await registry.flushAll()
    setLook('off')
    setCurrentId(id)
    setFocusItem(null)
    followUrl(id, tab)
  }
  const changeTab = (next: CardSection): void => {
    if (next !== 'general') setLook('off')
    setTab(next)
    setFocusItem(null)
    followUrl(currentId, next)
  }

  // Hold the card until the page stills are in, so it opens over them.
  if (!stills.ready) return null
  const companion = state.items.find((c) => c.id === currentId) ?? null
  const frame = cardFrame({ width: placement.rect.width, height: placement.rect.height }, { share, looking: look === 'on', mode: placement.mode === 'float' ? 'float' : 'column' })
  const width = dragWidth ?? frame.width
  const cardVars: Record<string, string | number> = { '--co-card-w': `${width}px` }
  const style = (placement.mode === 'float' ? { ...cardVars, top: frame.top, right: frame.right, bottom: frame.bottom, width } : cardVars) as CSSProperties

  return (
    <CardSavesProvider value={registry}>
      <CardLayer placement={placement} shots={stills.shots} leaving={leaving} labelledBy={titleId} onEscape={escape} onDismiss={() => void close()} style={style} className={cx(dragWidth !== null && 'co-card--resizing', look === 'leaving' && 'co-card--look-closing')}>
        {placement.mode === 'float' && (
          <Seam
            className="co-card__seam ui-seam--bare"
            value={width}
            min={frame.min}
            max={frame.max}
            reverse
            disabled={look !== 'off'}
            label={t('coCard.companionCard.resizeTheCompanionCard')}
            valueText={(v) => t('coCard.companionCard.pixelsWide', { value: Math.round(v) })}
            resetTo={() => cardFrame(placement.rect, { share: null, looking: false, mode: 'float' }).width}
            onChange={setDragWidth}
            onCommit={(w) => {
              const next = shareForWidth(w, placement.rect.width)
              setShare(next)
              writeShare(next)
              setDragWidth(null)
            }}
            onDragChange={(dragging) => {
              if (!dragging) setDragWidth(null)
            }}
          />
        )}
        {companion ? (
          <CardBody
            key={companion.id}
            companion={companion}
            state={state}
            registry={registry}
            titleId={titleId}
            tab={tab}
            focusItem={focusItem}
            width={width}
            look={look}
            onLook={setLookOpen}
            onTab={changeTab}
            onSwitch={(id) => void switchTo(id)}
            onLeave={(url) => {
              void call('pages', 'open', url)
              void close()
            }}
            onClose={() => void close()}
          />
        ) : (
          <CardFallback state={state} titleId={titleId} onSwitch={(id) => void switchTo(id)} onClose={() => void close()} />
        )}
      </CardLayer>
      <ModalScope scope="content">
        <CompanionSheets />
      </ModalScope>
    </CardSavesProvider>
  )
}

/** Loading, failed, or a companion that no longer exists. */
function CardFallback({ state, titleId, onSwitch, onClose }: { state: CompanionsState; titleId: string; onSwitch(id: string): void; onClose(): void }) {
  const t = useT()
  const closeButton = (
    <div className="co-card__actions co-card__actions--alone">
      <IconButton label={t('coCard.companionCard.close')} shortcut="Escape" icon={<X />} size="md" className="co-round" onClick={onClose} />
    </div>
  )
  if (state.status === 'loading') {
    return (
      <div className="co-card__inner" aria-busy="true">
        <h2 id={titleId} className="ui-sr-only">{t('coCard.companionCard.loadingTheCompanion')}</h2>
        <div className="co-card__header">
          <Skeleton circle width={24} height={24} />
          <Skeleton width={120} height={16} />
          {closeButton}
        </div>
        <div className="co-card__loading">
          <SkeletonRows rows={5} label={t('coCard.companionCard.loadingTheCompanion')} />
        </div>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="co-card__inner">
        <h2 id={titleId} className="ui-sr-only">{t('coCard.companionCard.companion')}</h2>
        <div className="co-card__header">{closeButton}</div>
        <ErrorState title={t('coCard.companionCard.yourCompanionsDidnT')} message={state.error ?? undefined} onRetry={() => reloadCompanions()} action={<Button variant="ghost" onClick={onClose}>{t('coCard.companionCard.close')}</Button>} />
      </div>
    )
  }
  const fallback = state.items.find((c) => c.id === state.activeId) ?? state.items.find((c) => !c.hidden)
  return (
    <div className="co-card__inner">
      <h2 id={titleId} className="ui-sr-only">{t('coCard.companionCard.companionNotFound')}</h2>
      <div className="co-card__header">{closeButton}</div>
      <EmptyState
        icon={<UserRoundX />}
        title={t('coCard.companionCard.thisCompanionIsnT')}
        description={t('coCard.companionCard.itMayHaveBeen')}
        action={
          <>
            {fallback && <Button variant="primary" onClick={() => onSwitch(fallback.id)}>{t('coCard.companionCard.show', { name: fallback.name })}</Button>}
            <Button variant="ghost" onClick={onClose}>{t('coCard.companionCard.close')}</Button>
          </>
        }
      />
    </div>
  )
}

interface CardBodyProps {
  companion: Companion
  state: CompanionsState
  registry: SaveRegistry
  titleId: string
  tab: CardSection
  focusItem: string | null
  width: number
  look: LookPhase
  onLook(open: boolean): void
  onTab(tab: CardSection): void
  onSwitch(id: string): void
  /** Opens an Apex page in a tab and closes the card. */
  onLeave(url: string): void
  onClose(): void
}

function CardBody({ companion, state, registry, titleId, tab, focusItem, width, look, onLook, onTab, onSwitch, onLeave, onClose }: CardBodyProps) {
  const t = useT()
  const [exporting, setExporting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const [bodyHeight, setBodyHeight] = useState(0)
  // Bumped after a reset, so fields holding drafts start again from the saved values.
  const [generation, setGeneration] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const dock = useSaveTracker()
  useReportSave(dock.state, dock.retry)
  const counts = useLoaded(
    async () => {
      const [skills, routines] = await Promise.all([call('skills', 'list'), call('routines', 'list')])
      return { skills: skills.filter((s) => s.owner === companion.id).length, routines: routines.filter((r) => r.owner === companion.id).length }
    },
    [companion.id],
    (e) => e.type === 'skills' || e.type === 'routines',
  )
  const isActive = state.activeId === companion.id
  const lastVisible = isLastVisible(state.items, companion.id)
  const isMac = apex.platform === 'darwin'
  const idPrefix = `co-${companion.id}`

  useEffect(() => registry.setBusy(busy), [busy, registry])
  useEffect(() => () => registry.setBusy(null), [registry])

  // Each tab, and the look editor, starts at the top.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    setScrolled(false)
  }, [tab, look === 'on'])
  useEffect(() => {
    const el = body.current
    if (!el) return
    const observer = new ResizeObserver(() => setBodyHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })
  const activate = (): void => {
    call('companions', 'setActive', companion.id).then(() => toast.show({ message: t('coCard.companionCard.takesYourNewChats', { name: companion.name }), tone: 'success' }), fail)
  }
  const unhide = (): void => void call('companions', 'unhide', companion.id).catch(fail)
  const toggleDock = (): void => {
    const on = !companion.dockIcon
    dock.run(() =>
      call('companions', 'update', companion.id, { dockIcon: on }).then(() => {
        if (on && !isActive) toast.show({ message: t('coCard.companionCard.showsInTheDock', { name: companion.name }) })
      }),
    )
  }

  const duplicate = async (): Promise<void> => {
    const id = `duplicate-${companion.id}`
    setBusy(t('coCard.companionCard.duplicating'))
    try {
      const copy = await call('companions', 'duplicate', companion.id)
      toast.show({ id, message: t('coCard.companionCard.madeACopyWith', { name: copy.name, name2: companion.name }), tone: 'success', action: { label: t('coCard.companionCard.show2'), onAction: () => onSwitch(copy.id) } })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  const hide = (): void => {
    call('companions', 'hide', companion.id).then(
      () =>
        toast.show({
          message: t('coCard.companionCard.isHiddenFromThe', { name: companion.name }),
          undo: () => void call('companions', 'unhide', companion.id).catch(fail),
        }),
      fail,
    )
  }
  const reset = async (): Promise<void> => {
    const ok = await confirm({
      title: t('coCard.companionCard.reset', { name: companion.name }),
      message: t('coCard.companionCard.itsNamePersonalityAnd'),
      confirmLabel: t('coCard.companionCard.reset2'),
    })
    if (!ok) return
    try {
      await call('companions', 'reset', companion.id)
      setGeneration((n) => n + 1)
      toast.show({ message: t('coCard.companionCard.isBackToHow', { name: companion.name }), tone: 'success' })
    } catch (err) {
      fail(err)
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('coCard.companionCard.delete', { name: companion.name }),
      message: t('coCard.companionCard.sOwnSkillsRoutines', { name: companion.name }),
      confirmLabel: t('coCard.companionCard.delete2', { name: companion.name }),
      destructive: true,
    })
    if (!ok) return
    // Move to a neighbour first, so the card never shows the companion vanishing.
    const next = successorAfterRemoval(companionsSnapshot().items, companion.id)
    const { id, name } = companion
    if (next) onSwitch(next)
    try {
      await call('companions', 'remove', id)
      toast.show({ message: t('coCard.companionCard.deleted', { name }), tone: 'success' })
      if (!next) onClose()
    } catch (err) {
      if (next) onSwitch(id)
      fail(err)
    }
  }

  // The rarer actions; Export… and Customize look live in the hero.
  // DS-35: an in-card menu 240 wide, right-aligned 4 px under the button, with 36 px rows.
  const openMenu = async (anchor: HTMLElement): Promise<void> => {
    const lastReason = t('coCard.companionCard.addAnotherCompanionTo')
    const items: PopoverItem[] = [
      { id: 'activate', label: isActive ? t('coCard.companionCard.takesYourNewChats2') : t('coCard.companionCard.useForNewChats'), icon: <MessageSquarePlus />, trailing: 'check', checked: isActive, disabled: isActive || companion.hidden },
      { id: 'duplicate', label: busy ?? t('coCard.companionCard.duplicate'), icon: <Copy />, disabled: busy !== null },
      companion.hidden
        ? { id: 'unhide', label: t('coCard.companionCard.showInTheSwitcher'), icon: <Eye /> }
        : { id: 'hide', label: t('coCard.companionCard.hideFromTheSwitcher'), icon: <EyeOff />, disabled: lastVisible, title: lastVisible ? lastReason : undefined },
      { id: 'reset', label: t('coCard.companionCard.reset3'), icon: <RotateCcw /> },
      ...(isMac ? [{ id: 'dock', label: t('coCard.companionCard.showInTheDock'), kind: 'switch' as const, checked: companion.dockIcon, icon: <AppWindow /> }] : []),
      { id: 'sep', label: '', kind: 'separator' },
      { id: 'delete', label: t('coCard.companionCard.delete3'), icon: <Trash2 />, danger: true, disabled: lastVisible || busy !== null, title: lastVisible ? lastReason : undefined, description: lastVisible ? lastReason : undefined },
    ]
    const choice = await showPopoverMenu(items, anchor, { label: t('coCard.companionCard.moreFor', { name: companion.name }), width: 240, gap: 4, align: 'end', onToggle: (id) => id === 'dock' && toggleDock() })
    if (choice === 'activate') activate()
    else if (choice === 'duplicate') await duplicate()
    else if (choice === 'hide') hide()
    else if (choice === 'unhide') unhide()
    else if (choice === 'reset') await reset()
    else if (choice === 'delete') await remove()
  }

  const tabs: CardTab[] = SECTIONS.map((id) => ({ id, label: SECTION_LABELS[id], icon: SECTION_ICONS[id] }))

  return (
    <div className={cx('co-card__inner', scrolled && 'co-card__inner--scrolled')}>
      <CardHeader companion={companion} companions={state.items} titleId={titleId} onSwitch={onSwitch} onMenu={(anchor) => void openMenu(anchor)} onClose={onClose} />
      <FloatingSave />
      <CardTabs tabs={tabs} value={tab} onChange={(id) => onTab(id as CardSection)} label={t('coCard.tabs.sectionsOf', { name: companion.name })} idPrefix={idPrefix} className="co-card__tabs" />
      <div
        ref={body}
        className={cx('co-card__body', tab === 'general' && 'co-card__body--flush')}
        style={{ '--co-body-h': `${bodyHeight}px` } as CSSProperties}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <TabPanel idPrefix={idPrefix} tabId={tab} key={`${tab}-${generation}`}>
          {tab === 'general' && (
            <GeneralTab
              companion={companion}
              skillCount={counts.data?.skills ?? null}
              routineCount={counts.data?.routines ?? null}
              cardWidth={width}
              look={look}
              onLook={onLook}
              onExport={() => setExporting(true)}
              onSection={onTab}
            />
          )}
          {tab === 'skills' && <SkillsTab companion={companion} focusId={focusItem} onOpenChat={(chatId) => onLeave(chatUrl(chatId))} />}
          {tab === 'routines' && <RoutinesTab companion={companion} focusId={focusItem} onOpenPage={onLeave} />}
          {tab === 'files' && <FilesTab companion={companion} focusPath={itemToPath(focusItem)} onOpenPage={onLeave} />}
          {tab === 'memory' && <MemoryTab companion={companion} focusItem={focusItem} />}
          {tab === 'models' && <ModelsTab companion={companion} onOpenPage={onLeave} />}
        </TabPanel>
      </div>
      {exporting && (
        <Nested>
          <ExportDialog companion={companion} open onClose={() => setExporting(false)} />
        </Nested>
      )}
    </div>
  )
}
