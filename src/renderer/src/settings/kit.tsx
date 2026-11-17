/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Building blocks for settings and destination pages: headers, cards of
// rows, fields, search and notices. Interactive controls come from ../ui.
import { createContext, useContext, useId, useLayoutEffect, useRef, type ReactElement, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type Ref } from 'react'
import { ArrowUpRight, CircleAlert, Info, ListFilter, Search, TriangleAlert, UserRound, X } from 'lucide-react'
import { ErrorState, IconButton, SegmentedControl, Skeleton, SkeletonRows, Switch, cx, type SegmentOption, type SwitchProps } from '../ui'
import { initialOf } from './logic/avatar'
import { SETTINGS_GUIDES, guideUrl } from '@shared/guides'
import { t } from '@shared/i18n/core'
import './settings.css'

/**
 * The page title and subtitle (DS-100, DS-130): no icon tile, actions level
 * with the title. `help` is the slot for the guide link (ST-04): a text link
 * with an outward arrow, right-aligned.
 */
/** ST-04: the settings or destination page being shown, so its header can link the matching guide (SETTINGS_GUIDES). */
export const GuidePageContext = createContext<string | null>(null)

export function PageHeader({ title, description, actions, help: helpLink, guide: guideProp, aside }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; help?: { label: string; onOpen(): void }; /* ST-04 */ guide?: string; /** DS-105: a selector pill beside the title (Library's companion pill). */ aside?: ReactNode }): ReactElement {
  // ST-04: a long page links to its matching guide, atelier://guides/<id>
  const pageId = useContext(GuidePageContext)
  const guide = guideProp ?? (pageId ? SETTINGS_GUIDES[pageId] : undefined)
  const help = helpLink ?? (guide ? { label: t('firstRun.guides.readGuide'), onOpen: () => void window.atelier.invoke('pages', 'open', guideUrl(guide)) } : undefined)
  const ref = useRef<HTMLElement>(null)
  useStickyHeaderHeight(ref)
  // DS-100: the text docs link comes before the primary pill.
  return (
    <header className="sp-header" ref={ref}>
      <div className="sp-header__text">
        {aside ? (
          <div className="sp-header__title-row">
            <h1 className="sp-header__title">{title}</h1>
            {aside}
          </div>
        ) : (
          <h1 className="sp-header__title">{title}</h1>
        )}
        {description && <p className="sp-header__description">{description}</p>}
      </div>
      {(actions || help) && (
        <div className="sp-header__actions">
          {help && (
            <button type="button" className="sp-link sp-header__help" onClick={help.onOpen}>
              {help.label}
              <ArrowUpRight aria-hidden />
            </button>
          )}
          {actions}
        </div>
      )}
    </header>
  )
}

/**
 * DS-100: on a destination page the header and row 2 both stick. The header
 * is sticky in CSS (when row 2 follows it); this publishes its height as
 * `--sp-dest-head-h` on the column so row 2 sticks right under it.
 */
function useStickyHeaderHeight(ref: { current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    const el = ref.current
    const column = el?.parentElement
    if (!el || !column || typeof ResizeObserver === 'undefined') return
    const sync = (): void => {
      if (getComputedStyle(el).position === 'sticky') column.style.setProperty('--sp-dest-head-h', `${el.offsetHeight}px`)
      else column.style.removeProperty('--sp-dest-head-h')
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      observer.disconnect()
      column.style.removeProperty('--sp-dest-head-h')
    }
  }, [ref])
}

/** A titled block of the page, usually holding one card. */
export function Section({ title, actions, note, children, labelledBy }: { title?: ReactNode; actions?: ReactNode; note?: ReactNode; children: ReactNode; labelledBy?: string }): ReactElement {
  const auto = useId()
  const headingId = labelledBy ?? `${auto}-title`
  return (
    <section className="sp-section" aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className="sp-section__head">
          {title && (
            <h2 id={headingId} className="sp-section__title">
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
      {note && <p className="sp-section__note">{note}</p>}
    </section>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={cx('sp-card', className)}>{children}</div>
}

/**
 * A settings row: title and description on the left, the control on the
 * right (DS-131). An optional 20 px glyph leads; `anchor` is the row's
 * SETTINGS_INDEX anchor, which ?highlight= scrolls to (ST-05).
 */
export function Row({ title, description, children, stack = false, htmlFor, id, icon, anchor }: { title: ReactNode; description?: ReactNode; children?: ReactNode; stack?: boolean; htmlFor?: string; id?: string; icon?: ReactNode; anchor?: string }): ReactElement {
  return (
    <div className={cx('sp-row', stack && 'sp-row--stack', icon !== undefined && 'sp-row--icon')} id={id} data-settings-anchor={anchor}>
      {icon !== undefined && (
        <span className="sp-row__icon" aria-hidden>
          {icon}
        </span>
      )}
      <div className="sp-row__text">
        {htmlFor ? (
          <label className="sp-row__title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <span className="sp-row__title">{title}</span>
        )}
        {description && <span className="sp-row__description">{description}</span>}
      </div>
      {children && <div className="sp-row__control">{children}</div>}
    </div>
  )
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }): ReactElement {
  return (
    <div className="sp-field">
      {htmlFor ? (
        <label className="sp-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="sp-field__label">{label}</span>
      )}
      {children}
      {error ? (
        <p className="sp-field__error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="sp-field__hint">{hint}</p>
      )}
    </div>
  )
}

export function TextInput({ invalid, className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }): ReactElement {
  return <input ref={ref} {...rest} aria-invalid={invalid || undefined} className={cx('sp-input', className)} />
}

export function TextArea({ invalid, className, code = false, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; code?: boolean }): ReactElement {
  return <textarea {...rest} aria-invalid={invalid || undefined} className={cx('sp-textarea', code && 'sp-textarea--code', className)} />
}

export function SearchField({ value, onChange, placeholder, label, pill = false, autoFocus }: { value: string; onChange(value: string): void; placeholder: string; label?: string; pill?: boolean; autoFocus?: boolean }): ReactElement {
  return (
    <div className={cx('sp-search', pill && 'sp-search--pill')} role="search">
      <Search aria-hidden />
      <input
        className="sp-input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Esc clears first; a second Esc can reach whatever is behind.
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            onChange('')
          }
        }}
      />
      {value && <IconButton className="sp-search__clear" size="sm" label={t('settings.kit.clearSearch')} icon={<X />} onClick={() => onChange('')} />}
    </div>
  )
}

export type NoticeTone = 'info' | 'warning' | 'error'

const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  info: <Info aria-hidden />,
  warning: <TriangleAlert aria-hidden />,
  error: <CircleAlert aria-hidden />,
}

/** An inline message at the top of a page or card, with an optional action or dismiss. */
export function Notice({ tone = 'info', children, action, onDismiss }: { tone?: NoticeTone; children: ReactNode; action?: ReactNode; onDismiss?(): void }): ReactElement {
  return (
    <div className={cx('sp-notice', `sp-notice--${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
      {NOTICE_ICON[tone]}
      <div className="sp-notice__text">{children}</div>
      {action}
      {onDismiss && <IconButton size="sm" label={t('settings.kit.dismiss')} icon={<X />} onClick={onDismiss} />}
    </div>
  )
}

/** A round picture, or the name's first letter on an accent wash (a person icon before there is a name). */
export function Avatar({ src, name, size = 40, companion = false, dimmed = false }: { src?: string | null; name: string; size?: number; companion?: boolean; dimmed?: boolean }): ReactElement {
  return (
    <span
      className={cx('sp-avatar', companion && 'sp-avatar--companion', dimmed && 'sp-avatar--dimmed')}
      style={{ ['--avatar-size' as string]: `${size}px` }}
      aria-hidden
    >
      {src ? <img src={src} alt="" draggable={false} /> : initialOf(name) || <UserRound size={Math.round(size * 0.5)} />}
    </span>
  )
}

/** A list frame whose body is a loading, error, empty or filled state. */
export function ListFrame({ children, label }: { children: ReactNode; label?: string }): ReactElement {
  return (
    <div className="sp-list" role={label ? 'region' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

/** A whole-row switch that a ?highlight= anchor can find (ST-04, ST-05). */
export function SwitchRow({ anchor, ...props }: SwitchProps & { anchor?: string }): ReactElement {
  return (
    <div className="sp-switch-anchor" data-settings-anchor={anchor}>
      <Switch {...props} />
    </div>
  )
}

/** A page still loading (SS-01, ST-04): the header's place and a card of skeleton rows. */
export function PageSkeleton({ label, rows = 4 }: { label: string; rows?: number }): ReactElement {
  return (
    <div className="sp-page-skeleton" aria-busy="true">
      <Skeleton width={180} height={20} />
      <Skeleton width="62%" height={13} />
      <div className="sp-card">
        <SkeletonRows rows={rows} label={label} />
      </div>
    </div>
  )
}

/** A failed load: the reason inline and Try again (ST-04). */
export function PageError({ title, message, onRetry }: { title: string; message: string; onRetry(): void | Promise<unknown> }): ReactElement {
  return (
    <div className="sp-card sp-card--state">
      <ErrorState title={title} message={message} onRetry={onRetry} compact />
    </div>
  )
}

export interface ChoiceTile<T extends string> {
  value: T
  title: ReactNode
  description?: ReactNode
  /** The illustration: Atelier's own drawing, from tokens. */
  art: ReactNode
}

/**
 * Selection tiles (DS-132): a radio group of illustrated cards with a radio
 * at the top right; the chosen tile has a 2 px strong border. Arrows move and
 * select, like any radio group.
 */
export function ChoiceTiles<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly ChoiceTile<T>[]; onChange(value: T): void }): ReactElement {
  const selected = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className="sp-tiles" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={i === selected}
          tabIndex={i === selected ? 0 : -1}
          className="sp-tile"
          onClick={() => onChange(option.value)}
          onKeyDown={(e) => {
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
            if (!dir) return
            e.preventDefault()
            const next = options[(i + dir + options.length) % options.length]
            if (!next) return
            onChange(next.value)
            const group = e.currentTarget.parentElement
            requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
          }}
        >
          <span className="sp-tile__head">
            <span className="sp-tile__title">{option.title}</span>
            <span className="sp-tile__radio" aria-hidden />
          </span>
          {option.description && <span className="sp-tile__description">{option.description}</span>}
          <span className="sp-tile__art" aria-hidden>
            {option.art}
          </span>
        </button>
      ))}
    </div>
  )
}

/** The 36 px round filter button beside a destination's search (DS-100); `active` when any filter is on. */
export function FilterButton({ label, active = false, onOpen, expanded }: { label: string; active?: boolean; onOpen(anchor: HTMLElement): void; expanded?: boolean }): ReactElement {
  return (
    <button type="button" className={cx('sp-filter-btn', active && 'sp-filter-btn--active')} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={expanded} onClick={(e) => onOpen(e.currentTarget)}>
      <ListFilter aria-hidden />
      {active && <span className="sp-filter-btn__dot" aria-hidden />}
    </button>
  )
}

/**
 * Row 2 of a destination page (DS-100): segments on the left; the pill
 * search and the round filter button on the right. Sticks under the header
 * with a short fade.
 */
export function DestinationToolbar<T extends string>({ segments, search, filter, children, fullWidth = !segments }: {
  segments?: { label: string; value: T; options: readonly SegmentOption<T>[]; onChange(value: T): void }
  search?: { value: string; onChange(value: string): void; placeholder: string; autoFocus?: boolean }
  filter?: { label: string; active?: boolean; onOpen(anchor: HTMLElement): void }
  children?: ReactNode
  /** DS-103: the search fills the row (then the filter button); the default when there are no segments. */
  fullWidth?: boolean
}): ReactElement {
  return (
    <div className={cx('sp-dest-toolbar', fullWidth && 'sp-dest-toolbar--full')}>
      {segments && <SegmentedControl size="lg" label={segments.label} value={segments.value} options={segments.options} onChange={segments.onChange} />}
      <div className="sp-dest-toolbar__end">
        {children}
        {search && <SearchField pill value={search.value} onChange={search.onChange} placeholder={search.placeholder} autoFocus={search.autoFocus} />}
        {filter && <FilterButton label={filter.label} active={filter.active} onOpen={filter.onOpen} />}
      </div>
    </div>
  )
}

/** A grid of tiles (DS-102 suggestion cards, DS-103 connector tiles); `columns` is the widest layout. */
export function TileGrid({ children, columns = 3, label }: { children: ReactNode; columns?: 2 | 3; label?: string }): ReactElement {
  return (
    <div className={cx('sp-tile-grid', `sp-tile-grid--${columns}`)} role={label ? 'list' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

/** A 28 px chip in a filter row (DS-101): a toggle, or a dropdown with a chevron when `menu` is set. */
export function FilterChip({ label, pressed, onClick, menu = false }: { label: ReactNode; pressed?: boolean; onClick(anchor: HTMLElement): void; menu?: boolean }): ReactElement {
  return (
    <button
      type="button"
      className={cx('sp-chip', pressed && 'sp-chip--on', menu && 'sp-chip--menu')}
      aria-pressed={menu ? undefined : pressed === true}
      aria-haspopup={menu ? 'menu' : undefined}
      onClick={(e) => onClick(e.currentTarget)}
    >
      {label}
    </button>
  )
}
