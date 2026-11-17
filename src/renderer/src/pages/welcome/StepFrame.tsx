/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The step template's two halves (stage.ts): StepFrame lays out a
// step's words, content card and actions in the step column, and StepScene
// draws the step's illustration around the live companion in its own slot
// (portalled into the stage WelcomeFlow keeps), as Apex's small tiles with
// soft lines to the figure. Decorative: screen readers get the words.
import { Children, createContext, useContext, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Pin } from 'lucide-react'
import { cx } from '../../ui'
import { orbit, ORBIT_MAX, type WelcomeSlot } from './stage'

export interface StageValue {
  /** The scene's tile layer, under the figure. */
  target: HTMLElement | null
  slot: WelcomeSlot
}

export const StageContext = createContext<StageValue | null>(null)

export interface SceneTile {
  id: string
  /** A lucide icon. */
  icon?: ReactNode
  /** A site's own icon; `mark` shows until (or unless) it loads. */
  image?: string | null
  /** A one- or two-letter mark (a site's initial). */
  mark?: string
  /** A name tag: the tile widens to fit (ellipsised to its room). */
  text?: string
  /** A colour swatch (#rrggbb). */
  swatch?: string
  /** Lit: connected, picked, answered, chosen. */
  on?: boolean
  /** The one being asked about or shown now. */
  current?: boolean
  badge?: 'check' | 'pin'
}

export interface StepSceneProps {
  tiles: readonly SceneTile[]
  /** Lines from the figure to each tile; 'in' sends a slow dash along them toward the figure (an import). */
  lines?: 'still' | 'in' | false
}

/** A step's illustration, drawn around the companion in the stage. */
export function StepScene({ tiles, lines = 'still' }: StepSceneProps): ReactElement | null {
  const stage = useContext(StageContext)
  if (!stage?.target) return null
  const shown = tiles.slice(0, ORBIT_MAX)
  const { hub, points } = orbit(shown.length, stage.slot)
  const { sceneW, sceneH } = stage.slot
  return createPortal(
    <div className="wls" data-lines={lines || undefined}>
      {lines && (
        <svg className="wls__lines" viewBox={`0 0 ${sceneW} ${sceneH}`} width={sceneW} height={sceneH} aria-hidden="true" focusable="false">
          {points.map((p, i) => (
            <path key={shown[i]!.id} d={curve(hub, p)} data-on={shown[i]!.on || undefined} style={{ '--i': i } as CSSProperties} />
          ))}
        </svg>
      )}
      {points.map((p, i) => {
        const tile = shown[i]!
        return (
          <span
            key={tile.id}
            className={cx('wls__tile', tile.text !== undefined && 'wls__tile--tag', tile.swatch && 'wls__tile--swatch')}
            data-on={tile.on || undefined}
            data-current={tile.current || undefined}
            style={{ left: p.x, top: p.y, '--i': i, '--room': `${p.room * 2}px` } as CSSProperties}
          >
            <span className="wls__float">
              {tile.swatch ? (
                <i className="wls__swatch" style={{ background: tile.swatch }} />
              ) : tile.image ? (
                <img src={tile.image} alt="" draggable={false} />
              ) : tile.icon ? (
                tile.icon
              ) : tile.mark ? (
                <b className="wls__mark">{tile.mark}</b>
              ) : null}
              {tile.text !== undefined && <span className="wls__text">{tile.text}</span>}
            </span>
            {tile.badge && <i className="wls__badge">{tile.badge === 'pin' ? <Pin /> : <Check />}</i>}
          </span>
        )
      })}
    </div>,
    stage.target,
  )
}

/** A soft curve from the figure's chest out to a tile: level at the figure, rising or falling toward the tile. */
function curve(hub: { x: number; y: number }, p: { x: number; y: number }): string {
  const mx = (hub.x + p.x) / 2
  return `M${hub.x} ${hub.y} C${mx} ${hub.y} ${mx} ${p.y} ${p.x} ${p.y}`
}

/** The first letter of a name or host, for a tile without an icon. */
export function initial(text: string): string {
  const clean = text.replace(/^www\./, '').trim()
  return (clean.match(/\p{L}|\p{N}/u)?.[0] ?? '·').toUpperCase()
}

export interface StepFrameProps {
  /** A small line above the title (a question's count). */
  eyebrow?: ReactNode
  title: ReactNode
  titleClassName?: string
  subtitle?: ReactNode
  /** The step's content; left out (or nothing but empty branches), the step is only words and actions. Put StepScene outside when the card can be empty. */
  children?: ReactNode
  /** 'panel': the bordered card (default); 'bare': no frame, for content made of cards (the layouts, the showcase). */
  card?: 'panel' | 'bare'
  cardClassName?: string
  /** The card is waiting (the questions' thinking pause). */
  busy?: boolean
  /** On the start side of the actions (Back). */
  back?: ReactNode
  /** On the end side: Skip and the main action. */
  actions: ReactNode
  /** A line under the actions (the intro's "or press Enter"). */
  after?: ReactNode
}

/** One step's words, card and actions, the same on every step. */
export function StepFrame({ eyebrow, title, titleClassName, subtitle, children, card = 'panel', cardClassName, busy, back, actions, after }: StepFrameProps): ReactElement {
  // Only real content makes a card (a `false &&` branch alone never draws an empty one).
  const hasCard = Children.toArray(children).length > 0
  return (
    <>
      <header className="wlt__head">
        {eyebrow && (
          <p className="wlt__eyebrow wlx__count" aria-live="polite">
            {eyebrow}
          </p>
        )}
        <h1 className={cx('wlt__title', titleClassName)}>{title}</h1>
        {subtitle && <p className="wlt__subtitle">{subtitle}</p>}
      </header>
      {hasCard && (
        <div className={cx('wlt__card', card === 'panel' ? 'welcome__panel' : 'wlt__card--bare', cardClassName)} aria-busy={busy || undefined}>
          {children}
        </div>
      )}
      <div className="welcome__actions wlt__actions" data-solo={back ? undefined : ''}>
        {back}
        <div className="wlt__actions-end">
          {actions}
          {after}
        </div>
      </div>
    </>
  )
}
