/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { Ban, Check, Pipette, X } from 'lucide-react'
import { TINTS, type CompanionLook, type Tint } from '@shared/companion'
import { CompanionStill, type CompanionAssets } from '../companion'
import { FaceSwatch, faceLabel, partLabel, rigLabel, type LookBinding } from '../pages/CompanionEditor'
import { cx, ErrorState, IconButton } from '../ui'
import { AdjustSliders } from './AdjustSliders'
import {
  isCurrent,
  isCurrentPalette,
  panelSections,
  partNote,
  RIG_OPTIONS,
  RING_CATEGORIES,
  ringKeyTarget,
  ringOffset,
  tintSwatches,
  withOption,
  type PanelSection,
  type RingCategory,
  type RingCategoryId,
} from './logic/lookRing'
import './lookRing.css'
import { useT, t } from '../i18n/useT'

// The look editor's stage (DS-118, DS-119): eight bubbles on a ring around
// the figure, each previewing its category in the look's colours, and the
// floating option card a bubble opens at the hero's edge on its side. Every
// pick goes through the binding, so it saves live and feeds undo and redo.

const TINT_LABELS: Record<Tint, string> = { get skin() { return t('coCard.lookRing.skin') }, get hair() { return t('coCard.lookRing.hair') }, get accent() { return t('coCard.lookRing.accent') }, get outfit() { return t('coCard.lookRing.outfit') } }
const TILE = 37

interface LookRingProps {
  binding: LookBinding
  assets: CompanionAssets | null
  loadError: Error | null
  onRetry(): void
}

export function LookRing({ binding, assets, loadError, onRetry }: LookRingProps): ReactElement {
  const t = useT()
  const base = useId()
  const [open, setOpen] = useState<RingCategoryId | null>(null)
  const [focusAt, setFocusAt] = useState(0)
  const bubbles = useRef<Array<HTMLButtonElement | null>>([])
  const { look } = binding
  const category = RING_CATEGORIES.find((c) => c.id === open) ?? null

  const tabId = (c: RingCategory): string => `${base}-tab-${c.id}`
  const panelId = `${base}-panel`

  const choose = (index: number): void => {
    const next = RING_CATEGORIES[index]
    if (!next) return
    setFocusAt(index)
    setOpen(next.id)
    bubbles.current[index]?.focus()
  }

  const onRingKey = (e: KeyboardEvent<HTMLElement>, index: number): void => {
    if (e.key === 'Escape' && open) {
      // Esc closes the open card first; the next one leaves look editing.
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
      return
    }
    const target = ringKeyTarget(index, e.key)
    if (target === null) return
    e.preventDefault()
    // Selection follows focus, as in any tab list.
    choose(target)
  }

  const close = (): void => {
    const at = RING_CATEGORIES.findIndex((c) => c.id === open)
    setOpen(null)
    if (at >= 0) bubbles.current[at]?.focus()
  }

  const colours = {
    '--ring-skin': look.colors.skin,
    '--ring-hair': look.colors.hair,
    '--ring-accent': look.colors.accent,
    '--ring-outfit': look.colors.outfit,
  } as CSSProperties

  return (
    <>
      <div className="co-ring" role="tablist" aria-label={t('coCard.lookRing.lookCategories')} style={colours}>
        {RING_CATEGORIES.map((c, i) => {
          const { x, y } = ringOffset(c)
          const selected = open === c.id
          return (
            <button
              key={c.id}
              ref={(el) => {
                bubbles.current[i] = el
              }}
              id={tabId(c)}
              type="button"
              role="tab"
              aria-label={c.label}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={(open ? selected : i === focusAt) ? 0 : -1}
              className={cx('co-ring__bubble', `co-ring__bubble--${c.side}`, selected && 'co-ring__bubble--selected')}
              style={{ '--dx': `${x}px`, '--dy': `${y}px`, '--i': i } as CSSProperties}
              onFocus={() => setFocusAt(i)}
              onClick={() => (selected ? setOpen(null) : choose(i))}
              onKeyDown={(e) => onRingKey(e, i)}
            >
              <BubbleArt id={c.id} look={look} assets={assets} />
              <span className="co-ring__chip" aria-hidden="true">
                {c.label}
              </span>
            </button>
          )
        })}
      </div>
      {category && (
        <div key={category.id} className={cx('co-ring-panel', `co-ring-panel--${category.side}`)}>
          <section
            id={panelId}
            role="tabpanel"
            aria-labelledby={tabId(category)}
            className="co-ring-card"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              close()
            }}
          >
            <header className="co-ring-card__head">
              <h4>{category.label}</h4>
              <IconButton label={t('coCard.lookRing.close', { value: category.label.toLowerCase() })} icon={<X />} size="sm" className="co-ring-card__close" onClick={close} />
            </header>
            <div className="co-ring-card__body">
              {loadError ? (
                <ErrorState compact title={t('coCard.lookRing.theCompanionPartsDidn')} message={loadError.message} onRetry={onRetry} />
              ) : (
                panelSections(category.id).map((section, _, all) => (
                  <PanelSectionView key={section.title} section={section} headed={all.length > 1} binding={binding} assets={assets} />
                ))
              )}
            </div>
          </section>
          {category.adjust && !loadError && (
            <div className="co-ring-sliders">
              <AdjustSliders look={look} groups={[category.adjust]} onChange={(next, merge) => binding.set(next, merge)} onSeal={binding.seal} />
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ---- the bubbles' previews, in the look's colours ----

function BubbleArt({ id, look, assets }: { id: RingCategoryId; look: CompanionLook; assets: CompanionAssets | null }): ReactElement {
  if (assets && (id === 'eyes' || id === 'mouth' || id === 'brows')) {
    return (
      <span className="co-ring__art co-ring__art--face">
        <FaceSwatch assets={assets} layer={id} id={look.face[id]} skin={look.colors.skin} />
      </span>
    )
  }
  return (
    <svg className="co-ring__art" viewBox="0 0 24 24" aria-hidden="true">
      {GLYPHS[id]}
    </svg>
  )
}

// Atelier's own small glyphs, filled from the --ring-* colours on the ring.
const head = <circle cx="12" cy="11" r="6.5" fill="var(--ring-skin)" />
const GLYPHS: Record<RingCategoryId, ReactElement> = {
  colours: (
    <g>
      <path d="M12 12V3.5A8.5 8.5 0 0 1 20.5 12z" fill="var(--ring-skin)" />
      <path d="M12 12h8.5A8.5 8.5 0 0 1 12 20.5z" fill="var(--ring-hair)" />
      <path d="M12 12v8.5A8.5 8.5 0 0 1 3.5 12z" fill="var(--ring-accent)" />
      <path d="M12 12H3.5A8.5 8.5 0 0 1 12 3.5z" fill="var(--ring-outfit)" />
    </g>
  ),
  shape: (
    <g>
      <path d="M4.5 22c0-4.2 3.4-6.8 7.5-6.8s7.5 2.6 7.5 6.8z" fill="var(--ring-outfit)" />
      <circle cx="12" cy="9" r="5.5" fill="var(--ring-skin)" />
    </g>
  ),
  eyes: (
    <g>
      {head}
      <circle cx="9.6" cy="11" r="1.3" fill="currentColor" />
      <circle cx="14.4" cy="11" r="1.3" fill="currentColor" />
    </g>
  ),
  mouth: (
    <g>
      {head}
      <path d="M9.4 12.6q2.6 2.6 5.2 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </g>
  ),
  brows: (
    <g>
      {head}
      <path d="M8.4 9.2l2.4-.6M13.2 8.6l2.4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </g>
  ),
  hat: (
    <g>
      <circle cx="12" cy="15" r="5.5" fill="var(--ring-skin)" />
      <path d="M5.5 13a6.5 6.5 0 0 1 13 0z" fill="var(--ring-outfit)" />
      <rect x="5" y="12" width="14" height="2.6" rx="1.3" fill="var(--ring-accent)" />
      <circle cx="12" cy="5.2" r="1.7" fill="var(--ring-accent)" />
    </g>
  ),
  hair: (
    <g>
      {head}
      <path d="M5.6 11.2a6.5 6.5 0 0 1 12.8 0c-2.3-1.4-4.6-1.8-7-1-2-.2-3.9.2-5.8 1z" fill="var(--ring-hair)" />
      <path d="M11 4.9c.4-1.8 1.8-2.8 3.4-2.9-.9 1-1.2 1.9-.9 3" stroke="var(--ring-hair)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </g>
  ),
  accessories: (
    <g>
      {head}
      <circle cx="9.3" cy="11" r="2.2" stroke="var(--ring-hair)" strokeWidth="1.3" fill="none" />
      <circle cx="14.7" cy="11" r="2.2" stroke="var(--ring-hair)" strokeWidth="1.3" fill="none" />
      <path d="M11.5 11h1" stroke="var(--ring-hair)" strokeWidth="1.3" />
    </g>
  ),
}

// ---- the option card's sections ----

interface SectionProps {
  section: PanelSection
  headed: boolean
  binding: LookBinding
  assets: CompanionAssets | null
}

function PanelSectionView({ section, headed, binding, assets }: SectionProps): ReactElement {
  const t = useT()
  if (section.kind === 'colours') return <ColoursSection binding={binding} assets={assets} />
  const { look } = binding
  const compat = assets?.compatibility ?? null
  const options: ReadonlyArray<string | null> = section.kind === 'rig' ? RIG_OPTIONS : section.options
  const label = (option: string | null): string => {
    if (option === null) return t('coCard.lookRing.none')
    if (section.kind === 'rig') return rigLabel(assets, option as CompanionLook['rig'])
    if (section.kind === 'face') return faceLabel(assets, section.layer, option)
    return partLabel(assets, option)
  }
  return (
    <div className="co-ring-section" role="group" aria-label={section.title}>
      {headed && <h5>{section.title}</h5>}
      <div className="co-ring-grid">
        {options.map((option) => {
          const current = isCurrent(look, section, option)
          const { allowed, note } = section.kind === 'part' ? partNote(look, section.slot, option, compat, (id) => partLabel(assets, id)) : { allowed: true, note: null }
          const name = label(option)
          return (
            <button
              key={option ?? 'none'}
              type="button"
              className={cx('co-ring-tile', current && 'co-ring-tile--current')}
              aria-pressed={current}
              aria-label={note ? `${name}: ${note}` : name}
              title={note ? `${name}. ${note}` : name}
              disabled={!allowed}
              onClick={() => binding.set(withOption(look, section, option, compat))}
            >
              <TileArt section={section} option={option} look={look} assets={assets} />
              {current && (
                <span className="co-ring-tile__check" aria-hidden="true">
                  <Check />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TileArt({ section, option, look, assets }: { section: Exclude<PanelSection, { kind: 'colours' }>; option: string | null; look: CompanionLook; assets: CompanionAssets | null }): ReactElement {
  if (option === null) return <Ban className="co-ring-tile__none" aria-hidden />
  if (section.kind === 'face') {
    return assets ? (
      <span className="co-ring-tile__face">
        <FaceSwatch assets={assets} layer={section.layer} id={option} skin={look.colors.skin} />
      </span>
    ) : (
      <span className="co-ring-tile__initial">{faceLabel(null, section.layer, option).charAt(0)}</span>
    )
  }
  // A small still of the look wearing the option: the body and props need the whole figure.
  const framing = section.kind === 'rig' || (section.kind === 'part' && section.slot === 'prop') ? 'full' : 'bust'
  return <CompanionStill look={withOption(look, section, option, assets?.compatibility ?? null)} mood="idle" size={TILE} framing={framing} className="co-ring-tile__still" />
}

function ColoursSection({ binding, assets }: { binding: LookBinding; assets: CompanionAssets | null }): ReactElement {
  const t = useT()
  const { look } = binding
  const [tint, setTint] = useState<Tint>('skin')
  const palettes = assets?.randomization.palettes ?? []
  const own = look.colors[tint].toLowerCase()
  const swatches = tintSwatches(palettes, tint)
  // A colour no palette has shows on the last tile, the free colour picker.
  const custom = !swatches.includes(own)
  const setColour = (value: string, group?: string): void => binding.set({ ...look, colors: { ...look.colors, [tint]: value } }, group)
  // A colour drag in progress ends when the tint changes.
  useEffect(() => binding.seal, [tint]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="co-ring-tints" role="group" aria-label={t('coCard.lookRing.colourToChange')}>
        {TINTS.map((t) => (
          <button key={t} type="button" className="co-ring-tints__tint" aria-pressed={tint === t} onClick={() => setTint(t)}>
            <i style={{ '--dot': look.colors[t] } as CSSProperties} aria-hidden="true" />
            {TINT_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="co-ring-section" role="group" aria-label={t('coCard.lookRing.colour', { value: TINT_LABELS[tint] })}>
        <div className="co-ring-grid">
          {swatches.map((colour) => {
            const current = colour === own
            return (
              <button
                key={colour}
                type="button"
                className={cx('co-ring-tile', 'co-ring-tile--swatch', current && 'co-ring-tile--current')}
                style={{ '--swatch': colour } as CSSProperties}
                aria-pressed={current}
                aria-label={colour}
                title={colour}
                onClick={() => setColour(colour)}
              >
                {current && (
                  <span className="co-ring-tile__check" aria-hidden="true">
                    <Check />
                  </span>
                )}
              </button>
            )
          })}
          <label className={cx('co-ring-tile', 'co-ring-tile--custom', custom && 'co-ring-tile--current')} title={t('coCard.lookRing.anyColour')} style={custom ? ({ '--swatch': look.colors[tint] } as CSSProperties) : undefined}>
            <input
              type="color"
              value={look.colors[tint]}
              aria-label={t('coCard.lookRing.anyColour2', { value: TINT_LABELS[tint].toLowerCase() })}
              onChange={(e) => setColour(e.target.value, `color:${tint}`)}
              onBlur={binding.seal}
              onPointerUp={binding.seal}
            />
            {custom ? (
              <span className="co-ring-tile__check" aria-hidden="true">
                <Check />
              </span>
            ) : (
              <Pipette aria-hidden />
            )}
          </label>
        </div>
      </div>
      {palettes.length > 0 && (
        <div className="co-ring-section" role="group" aria-label={t('coCard.lookRing.palettes')}>
          <h5>{t('coCard.lookRing.palettes')}</h5>
          <div className="co-ring-palettes">
            {palettes.map((palette) => {
              const current = isCurrentPalette(look, palette.colors)
              const quarters = TINTS.map((t, i) => `${palette.colors[t]} ${i * 25}% ${(i + 1) * 25}%`).join(', ')
              return (
                <button
                  key={palette.name}
                  type="button"
                  className={cx('co-ring-tile', 'co-ring-tile--palette', current && 'co-ring-tile--current')}
                  style={{ '--palette': `conic-gradient(${quarters})` } as CSSProperties}
                  aria-pressed={current}
                  aria-label={palette.name}
                  title={palette.name}
                  onClick={() => binding.set({ ...look, colors: { ...palette.colors } })}
                >
                  {current && (
                    <span className="co-ring-tile__check" aria-hidden="true">
                      <Check />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
