/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings nav: grouped rows, collapsible to an icon rail, resizable
// through a splitter (ST-02, DS-128). On a narrow content card it is a rail
// that opens as a floating panel.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react'
import {
  Activity,
  Bell,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  CircleUserRound,
  ExternalLink,
  Globe,
  HardDrive,
  Import,
  Info,
  KeyRound,
  Languages,
  Palette,
  Plug,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Download,
  AppWindow,
  UsersRound,
  X,
  AudioLines,
  LockKeyhole,
  Mic,
  // docs/decisions.md
  ZapIcon,
  Puzzle,
  ContactRound,
} from 'lucide-react'
import { t } from '../i18n/useT'
import { IconButton, cx } from '../ui'
import { rovingIndex } from '../ui/logic/keys'
import { clampNavWidth, navWidthForKey, NAV_WIDTH, type NavEntry, type NavGroup, type NavMode, type SettingsPageId } from './logic/nav'

const PAGE_ICONS: Record<SettingsPageId, ReactNode> = {
  you: <CircleUserRound aria-hidden />,
  companions: <UsersRound aria-hidden />,
  model: <KeyRound aria-hidden />,
  decisions: <ZapIcon aria-hidden />,
  permissions: <ShieldCheck aria-hidden />,
  general: <SlidersHorizontal aria-hidden />,
  appearance: <Palette aria-hidden />,
  search: <Search aria-hidden />,
  privacy: <Shield aria-hidden />,
  downloads: <Download aria-hidden />,
  import: <Import aria-hidden />,
  memory: <Brain aria-hidden />,
  'dock-icon': <AppWindow aria-hidden />,
  languages: <Languages aria-hidden />,
  'default-browser': <Globe aria-hidden />,
  notifications: <Bell aria-hidden />,
  storage: <HardDrive aria-hidden />,
  voice: <Mic aria-hidden />,
  transcription: <AudioLines aria-hidden />,
  passwords: <LockKeyhole aria-hidden />,
  extensions: <Puzzle aria-hidden />,
  profiles: <ContactRound aria-hidden />,
  activity: <Activity aria-hidden />,
  about: <Info aria-hidden />,
}

const LINK_ICONS: Record<string, ReactNode> = {
  connectors: <Plug aria-hidden />,
}

interface SettingsNavProps {
  groups: NavGroup[]
  current: SettingsPageId
  mode: NavMode
  /** The expanded width, remembered by the page. */
  width?: number
  onResize?(width: number): void
  onOpen(entry: NavEntry): void
  /** Expands or collapses (wide card), or opens and closes the floating nav (narrow card). */
  onToggle(): void
  /** Closes the floating nav (Esc, a click outside). */
  onDismiss(): void
}

export function SettingsNav({ groups, current, mode, width = NAV_WIDTH.default, onResize, onOpen, onToggle, onDismiss }: SettingsNavProps): ReactElement {
  const rail = mode === 'rail'
  const floating = mode === 'overlay'
  const panel = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [dragging, setDragging] = useState(false)

  // The floating nav closes on Esc and on a press outside it.
  useEffect(() => {
    if (!floating) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onDismiss()
    }
    const onPointer = (e: PointerEvent): void => {
      if (panel.current && !panel.current.contains(e.target as Node)) onDismiss()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    panel.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [floating])

  // Up and down move between rows; Tab leaves the nav.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('.sp-nav__item') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) return
    const next = rovingIndex(e.key, index, items.length, { orientation: 'vertical', loop: false })
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }

  // The splitter: drag within the limits; ←/→ step, Home and End jump (ST-02).
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onResize || e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startWidth = width
    setDragging(true)
    const move = (ev: PointerEvent): void => onResize(clampNavWidth(startWidth + ev.clientX - startX))
    const end = (): void => {
      setDragging(false)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const toggleLabel = floating ? t('settings.nav.close') : rail ? t('settings.nav.expand') : t('settings.nav.collapse')
  const bottom = groups.filter((g) => g.id === 'bottom')
  const main = groups.filter((g) => g.id !== 'bottom')
  const renderGroup = (group: NavGroup): ReactElement => (
    <div key={group.id} className="sp-nav__group" role="group" aria-label={group.label ?? undefined}>
      {group.label && !rail && (
        <p className="sp-nav__group-label" aria-hidden>
          {group.label}
        </p>
      )}
      {group.entries.map((entry) => {
        const active = entry.kind === 'page' && entry.id === current
        const icon = entry.kind === 'page' ? PAGE_ICONS[entry.id] : LINK_ICONS[entry.id]
        return (
          <button
            key={entry.id}
            type="button"
            className="sp-nav__item"
            aria-current={active ? 'page' : undefined}
            aria-label={rail ? entry.title : undefined}
            title={rail ? entry.title : entry.kind === 'link' ? t('settings.nav.opens', { title: entry.title }) : undefined}
            onClick={() => onOpen(entry)}
          >
            {icon}
            {!rail && <span className="sp-nav__label">{entry.title}</span>}
            {!rail && entry.kind === 'link' && <ExternalLink className="sp-nav__external" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
  return (
    <nav
      ref={panel}
      aria-label={t('settings.nav.label')}
      className={cx('sp-nav', rail && 'sp-nav--rail', floating && 'sp-nav-float', dragging && 'sp-nav--dragging')}
      style={!rail && !floating ? { ['--sp-nav-width' as string]: `${width}px` } : undefined}
      onKeyDown={onKeyDown}
    >
      <div className={cx('sp-nav__head', scrolled && 'sp-nav__head--scrolled')}>
        {!rail && <h1 className="sp-nav__title">{t('settings.nav.title')}</h1>}
        <IconButton size="md" label={toggleLabel} icon={floating ? <X /> : rail ? <ChevronsRight /> : <ChevronsLeft />} aria-expanded={!rail} onClick={onToggle} />
      </div>
      <div ref={list} className="sp-nav__list" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
        {main.map(renderGroup)}
      </div>
      {bottom.length > 0 && <div className="sp-nav__foot">{bottom.map(renderGroup)}</div>}
      {!rail && !floating && onResize && (
        <div
          className="sp-nav__splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('settings.nav.resize')}
          aria-valuemin={NAV_WIDTH.min}
          aria-valuemax={NAV_WIDTH.max}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={startDrag}
          onDoubleClick={() => onResize(NAV_WIDTH.default)}
          onKeyDown={(e) => {
            const next = navWidthForKey(e.key, width)
            if (next === null) return
            e.preventDefault()
            e.stopPropagation()
            onResize(next)
          }}
        />
      )}
    </nav>
  )
}
