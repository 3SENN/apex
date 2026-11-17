/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { CalendarClock, Check, ChevronDown, ChevronRight, FileDown, Info, Palette, Smile, WandSparkles } from 'lucide-react'
import { COMPANION_INSTRUCTIONS_MAX, COMPANION_NAME_MAX, type Companion, type CompanionLook } from '@shared/companion'
import { call } from '../api'
import { Companion as CompanionFigure } from '../companion'
import { useCompanionPresence } from '../companion/presence'
import { usePresets } from '../components/companionData'
import { t } from '../i18n/useT'
import { MOTION, cx, showMenu, useAutosave } from '../ui'
import { useReportSave } from './CardSaves'
import { primaryPillColors, heroTint } from './logic/cardColors'
import { heroMetrics } from './logic/cardLayout'
import type { CardSection } from './logic/sections'
import { LookInPlace } from './LookInPlace'
import { lessMotion } from './motion'
import { ShapeField } from './ShapeField'
import { useSaveTracker } from './useSaveTracker'

/** 'leaving' plays the look editor's exit before it unmounts. */
export type LookPhase = 'off' | 'on' | 'leaving'

interface GeneralTabProps {
  companion: Companion
  skillCount: number | null
  routineCount: number | null
  /** The card's width, which the hero's proportions follow. */
  cardWidth: number
  look: LookPhase
  onLook(open: boolean): void
  onExport(): void
  onSection(section: CardSection): void
}

/**
 * The figure pops in one step a beat after the card is opaque (DS-31, DS-40):
 * the card's fade (--motion-enter) plus about 180 ms.
 */
const ARRIVE_MS = MOTION.enter + 180

export function GeneralTab({ companion, skillCount, routineCount, cardWidth, look, onLook, onExport, onSection }: GeneralTabProps) {
  const looking = look === 'on'
  return (
    <div className={cx('co-general', looking && 'co-general--looking')}>
      <Hero companion={companion} cardWidth={cardWidth} look={look} onLook={onLook} onExport={onExport} />
      <div className="co-general__rest" inert={look !== 'off' || undefined}>
        <Summary companion={companion} skillCount={skillCount} routineCount={routineCount} onSection={onSection} />
        <Instructions companion={companion} />
      </div>
    </div>
  )
}

// ---- the hero ----

function Hero({ companion, cardWidth, look, onLook, onExport }: { companion: Companion; cardWidth: number; look: LookPhase; onLook(open: boolean): void; onExport(): void }) {
  const m = heroMetrics(cardWidth)
  const [arrived, setArrived] = useState(false)
  const [pulse, setPulse] = useState(0)
  const [preview, setPreview] = useState<CompanionLook | null>(null)
  const presence = useCompanionPresence(companion.id)
  const looking = look === 'on'
  const shownLook = preview ?? companion.look
  const tint = heroTint(shownLook)
  const pill = primaryPillColors(shownLook)

  useEffect(() => {
    const timer = setTimeout(() => {
      setArrived(true)
      setPulse((n) => n + 1)
    }, lessMotion() ? 0 : ARRIVE_MS)
    return () => clearTimeout(timer)
  }, [])
  // A finished task sends one ripple through the field.
  const wasHappy = useRef(false)
  useEffect(() => {
    const happy = presence.mood === 'happy'
    if (happy && !wasHappy.current) setPulse((n) => n + 1)
    wasHappy.current = happy
  }, [presence.mood])

  const vars = {
    '--hero-tint': tint,
    '--hero-h': `${m.height}px`,
    '--fig-size': `${m.figureSize}px`,
    '--fig-top': `${m.figureTop}px`,
    '--head-y': `${m.headY}px`,
    '--feet-y': `${m.feetY}px`,
    '--name-y': `${m.nameY}px`,
    '--field-top': `${m.fieldTop}px`,
    '--field-h': `${m.fieldHeight}px`,
    '--hero-scale': m.scale,
    '--co-pill': pill.rest,
    '--co-pill-hover': pill.hover,
    '--co-pill-press': pill.press,
    '--co-pill-text': pill.text,
  } as CSSProperties
  // The band sits on its own (DS-39); its swells still start at the feet.
  const { fieldTop, fieldHeight } = m

  return (
    <section className={cx('co-hero', looking && 'co-hero--looking', look === 'leaving' && 'co-hero--unlooking')} style={vars} aria-label={t('coCard.hero.label', { name: companion.name })}>
      <ShapeField
        tint={tint}
        density="card"
        className="co-hero__field"
        origin={{ x: 0.5, y: (m.feetY - fieldTop) / fieldHeight }}
        pulse={pulse}
      />
      <div className="co-hero__floor" aria-hidden="true" />
      <div className="co-hero__figure">
        {arrived && (
          <CompanionFigure
            profile={{ ...companion, look: shownLook }}
            size={m.figureSize}
            framing="full"
            shadow={false}
            priority={10}
            className="co-hero__companion"
            title={companion.name}
          />
        )}
      </div>
      <button type="button" className={cx('co-pill', 'co-pill--solid', 'co-hero__look')} aria-expanded={looking} onClick={() => onLook(!looking)}>
        {looking ? <Check aria-hidden /> : <Palette aria-hidden />}
        {looking ? t('coCard.hero.done') : t('coCard.hero.customize')}
      </button>
      <div className="co-hero__name-row" inert={look !== 'off' || undefined}>
        <BigName companion={companion} />
        <button type="button" className="co-pill co-pill--primary co-hero__export" onClick={onExport}>
          <FileDown aria-hidden />
          <span className="co-pill__label">{t('coCard.hero.export')}</span>
        </button>
      </div>
      {look !== 'off' && <LookInPlace companion={companion} leaving={look === 'leaving'} onPreview={setPreview} />}
    </section>
  )
}

/** The big name: plain text until hovered or focused, then a field. Empty restores the last name. */
function BigName({ companion }: { companion: Companion }) {
  const [text, setText] = useState(companion.name)
  const input = useRef<HTMLInputElement>(null)
  const trimmed = text.trim()
  // A rename elsewhere (the switcher, a reset) shows here unless you're typing.
  useEffect(() => {
    if (document.activeElement !== input.current) setText(companion.name)
  }, [companion.name])
  const autosave = useAutosave(trimmed, (value) => call('companions', 'update', companion.id, { name: value.slice(0, COMPANION_NAME_MAX) }), { delay: 700, enabled: trimmed !== '' })
  useReportSave(autosave.state, autosave.retry, autosave.flush)
  return (
    <span className="co-bigname" data-value={text || ' '}>
      <input
        ref={input}
        className="co-bigname__input"
        value={text}
        size={1}
        maxLength={COMPANION_NAME_MAX}
        spellCheck={false}
        aria-label={t('coCard.hero.name')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!trimmed) setText(companion.name)
          else {
            setText(trimmed)
            void autosave.flush()
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            // Esc puts the name back instead of closing the card.
            e.preventDefault()
            setText(companion.name)
            requestAnimationFrame(() => input.current?.blur())
          }
        }}
      />
    </span>
  )
}

// ---- the summary group ----

function SummaryRow({ icon, label, value, onClick, popup = false }: { icon: ReactNode; label: string; value: string; onClick(anchor: HTMLElement): void; popup?: boolean }): ReactElement {
  return (
    <li>
      <button type="button" className="co-summary__row" aria-haspopup={popup ? 'menu' : undefined} onClick={(e) => onClick(e.currentTarget)}>
        <span className="co-summary__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="co-summary__label">{label}</span>
        <span className="co-summary__value">{value}</span>
        <ChevronRight className="co-summary__chevron" aria-hidden />
      </button>
    </li>
  )
}

/** Exactly two rows (DS-44, DS-46). */
function Summary({ companion, skillCount, routineCount, onSection }: { companion: Companion; skillCount: number | null; routineCount: number | null; onSection(section: CardSection): void }) {
  return (
    <ul className="co-summary" aria-label={t('coCard.summary.label', { name: companion.name })}>
      <SummaryRow icon={<WandSparkles />} label={t('coCard.summary.skills')} value={skillCount === null ? '…' : t('coCard.summary.skillCount', { count: skillCount })} onClick={() => onSection('skills')} />
      <SummaryRow icon={<CalendarClock />} label={t('coCard.summary.routines')} value={routineCount === null ? '…' : t('coCard.summary.routineCount', { count: routineCount })} onClick={() => onSection('routines')} />
    </ul>
  )
}

/** DS-46: the personality preset as a small ghost select at the end of the instructions label row. */
function PersonalityPill({ companion }: { companion: Companion }): ReactElement {
  const presets = usePresets()
  const preset = presets.find((p) => p.id === companion.persona)
  const saving = useSaveTracker()
  useReportSave(saving.state, saving.retry)
  const pick = async (anchor: HTMLElement): Promise<void> => {
    const current = preset ? preset.id : 'custom'
    const choice = await showMenu(
      [{ id: 'custom', label: t('coCard.persona.none') }, ...presets.map((p) => ({ id: p.id, label: `${p.name}: ${p.tagline}` }))].map((item) => ({ ...item, type: 'radio' as const, checked: item.id === current })),
      anchor,
    )
    if (!choice || choice === current) return
    saving.run(() => call('companions', 'update', companion.id, { persona: choice }))
  }
  const value = preset ? preset.name : t('coCard.persona.none')
  return (
    <button type="button" className="co-persona-pill" aria-haspopup="menu" aria-label={t('coCard.persona.label', { value })} title={t('coCard.persona.title')} onClick={(e) => void pick(e.currentTarget)}>
      {/* The glyph marks it as a personality, so it doesn't read as a second companion switcher. */}
      <Smile aria-hidden />
      <span>{value}</span>
      <ChevronDown aria-hidden />
    </button>
  )
}

// ---- standing instructions ----

/** Plain paragraphs: blank lines split them, single line breaks stay. */
function Prose({ text }: { text: string }): ReactElement {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim())
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i}>{p.trim()}</p>
      ))}
    </>
  )
}

/** Added to the system prompt of this companion's new chats; read as prose, edited in place. */
function Instructions({ companion }: { companion: Companion }) {
  const [text, setText] = useState(companion.instructions)
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const labelId = useId()
  const hintId = useId()
  const autosave = useAutosave(text, (value) => call('companions', 'update', companion.id, { instructions: value }), { delay: 800 })
  useReportSave(autosave.state, autosave.retry, autosave.flush)
  const left = COMPANION_INSTRUCTIONS_MAX - text.length
  const hint = t('coCard.instructions.hint', { name: companion.name })

  // The field grows with its text, so editing looks like the prose it replaces.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text, editing])

  const edit = (): void => {
    setEditing(true)
    requestAnimationFrame(() => {
      const el = field.current
      if (!el) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  return (
    <section className="co-instructions" aria-labelledby={labelId}>
      <div className="co-instructions__head">
        <h3 id={labelId} className="co-instructions__label">{t('coCard.instructions.label')}</h3>
        <button type="button" className="co-info" title={hint} aria-label={t('coCard.instructions.about')} aria-describedby={hintId}>
          <Info aria-hidden />
        </button>
        <PersonalityPill companion={companion} />
      </div>
      <span id={hintId} hidden>
        {hint}
      </span>
      {editing ? (
        <textarea
          ref={field}
          className="co-prose co-prose--editing"
          value={text}
          maxLength={COMPANION_INSTRUCTIONS_MAX}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          placeholder={t('coCard.instructions.placeholder', { name: companion.name })}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            void autosave.flush()
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            // Esc finishes editing; a second Esc closes the card.
            e.preventDefault()
            e.currentTarget.blur()
          }}
        />
      ) : (
        <div
          className={cx('co-prose', !text.trim() && 'co-prose--empty')}
          role="button"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          onClick={() => {
            // Selecting text to copy shouldn't start editing.
            if (!window.getSelection()?.toString()) edit()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              edit()
            }
          }}
        >
          {text.trim() ? <Prose text={text} /> : <p>{t('coCard.instructions.placeholder', { name: companion.name })}</p>}
        </div>
      )}
      {left < 300 && (
        <p className={cx('co-counter', left < 60 && 'co-counter--low')} aria-live="polite">
          {t('coCard.instructions.left', { count: left })}
        </p>
      )}
    </section>
  )
}
