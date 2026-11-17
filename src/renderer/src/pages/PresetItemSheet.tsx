/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A preset's detail views, one per starter. From the profile
// (atelier://presets/<id>) a skill or routine row opens a sheet with all of it:
// a skill's description, steps and instructions and the routines that run
// it; a routine's schedule, what it asks, the skill it runs (a link to that
// skill's view) and where it reports. Previous and next walk the profile's
// order (skills, then routines) without closing the sheet.
import type { ReactElement } from 'react'
import { CalendarClock, ChevronLeft, ChevronRight, WandSparkles } from 'lucide-react'
import type { PresetDetail } from '@shared/onboarding'
import { scheduleText } from '../chat/cards/AgentToolCards'
import { adjacentPresetItem, presetItem, routineStarterSkill, routinesUsingSkill, skillDetailBody, type PresetItemRef } from '../companion-card/logic/presetProfile'
import { useT } from '../i18n/useT'
import { Button, EmptyState, Sheet } from '../ui'

export interface PresetItemSheetProps {
  detail: PresetDetail
  /** The preset's name, for the notes. */
  presetName: string
  /** The starter shown; null closes the sheet. */
  open: PresetItemRef | null
  onOpen(ref: PresetItemRef | null): void
}

export function PresetItemSheet({ detail, presetName, open, onOpen }: PresetItemSheetProps): ReactElement | null {
  const td = useT()
  if (!open) return null
  const item = presetItem(detail, open)
  const prev = adjacentPresetItem(detail, open, -1)
  const next = adjacentPresetItem(detail, open, 1)
  const close = (): void => onOpen(null)

  const footer = (
    <div className="ps-item__footer">
      <Button variant="ghost" size="sm" icon={<ChevronLeft />} disabled={!prev} onClick={() => prev && onOpen(prev)}>
        {td('galleries.presets.item.prev')}
      </Button>
      {item && (
        <span className="ps-item__position" aria-live="polite">
          {td('galleries.presets.item.position', { n: item.position, total: item.total })}
        </span>
      )}
      <Button variant="ghost" size="sm" disabled={!next} onClick={() => next && onOpen(next)}>
        {td('galleries.presets.item.next')}
        <ChevronRight aria-hidden />
      </Button>
      <Button variant="secondary" size="sm" onClick={close}>
        {td('galleries.presets.item.close')}
      </Button>
    </div>
  )

  if (!item) {
    return (
      <Sheet open onClose={close} title={open.kind === 'skill' ? `/${open.name}` : open.name} footer={footer} className="ps-item">
        <EmptyState title={td('galleries.presets.item.gone')} />
      </Sheet>
    )
  }

  if (item.kind === 'skill') {
    const { skill } = item
    const body = skillDetailBody(skill)
    const usedBy = routinesUsingSkill(detail, skill.name)
    return (
      <Sheet open onClose={close} title={`/${skill.name}`} description={skill.description} footer={footer} className="ps-item ps-item--skill">
        <p className="ps-item__kind">
          <WandSparkles aria-hidden />
          {td('galleries.presets.item.skillKind')}
        </p>
        {body.steps.length > 0 && (
          <section className="ps-item__section" aria-labelledby="ps-item-steps">
            <h3 id="ps-item-steps" className="ps-item__label">
              {td('galleries.presets.item.steps')}
            </h3>
            <ol className="ps-item__steps">
              {body.steps.map((s) => (
                <li key={s.id} className="ps-item__step">
                  <span className="ps-item__step-n" aria-hidden>
                    {s.n}
                  </span>
                  <span className="ps-item__step-text">
                    {s.title && <span className="ps-item__step-title">{s.title}</span>}
                    {s.text && <span className="ps-item__prose">{s.text}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="ps-item__section" aria-labelledby="ps-item-instructions">
          <h3 id="ps-item-instructions" className="ps-item__label">
            {td('galleries.presets.item.instructions')}
          </h3>
          {body.paragraphs.length === 0 ? (
            <p className="ps-item__muted">{td('galleries.presets.item.noInstructions')}</p>
          ) : (
            body.paragraphs.map((p, i) => (
              <p key={i} className="ps-item__prose">
                {p}
              </p>
            ))
          )}
        </section>
        {usedBy.length > 0 && (
          <section className="ps-item__section" aria-labelledby="ps-item-used">
            <h3 id="ps-item-used" className="ps-item__label">
              {td('galleries.presets.item.usedBy')}
            </h3>
            <ul className="ps-item__links">
              {usedBy.map((name) => (
                <li key={name}>
                  <button type="button" className="ps-item__link" onClick={() => onOpen({ kind: 'routine', name })}>
                    <CalendarClock aria-hidden />
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="ps-item__note">{td('galleries.presets.item.skillOwn', { name: presetName })}</p>
      </Sheet>
    )
  }

  const { routine } = item
  const skill = routineStarterSkill(detail, routine)
  return (
    <Sheet open onClose={close} title={routine.name} description={scheduleText(routine.schedule, td)} footer={footer} className="ps-item ps-item--routine">
      <p className="ps-item__kind">
        <CalendarClock aria-hidden />
        {td('galleries.presets.item.routineKind')}
      </p>
      <section className="ps-item__section" aria-labelledby="ps-item-when">
        <h3 id="ps-item-when" className="ps-item__label">
          {td('galleries.presets.item.when')}
        </h3>
        <p className="ps-item__prose">{scheduleText(routine.schedule, td)}</p>
      </section>
      <section className="ps-item__section" aria-labelledby="ps-item-prompt">
        <h3 id="ps-item-prompt" className="ps-item__label">
          {td('galleries.presets.item.prompt')}
        </h3>
        <p className="ps-item__prose ps-item__quote">{routine.prompt}</p>
      </section>
      {skill && (
        <section className="ps-item__section" aria-labelledby="ps-item-skill">
          <h3 id="ps-item-skill" className="ps-item__label">
            {td('galleries.presets.item.runsSkill')}
          </h3>
          <button type="button" className="ps-item__link" onClick={() => onOpen({ kind: 'skill', name: skill })}>
            <WandSparkles aria-hidden />/{skill}
          </button>
        </section>
      )}
      <section className="ps-item__section" aria-labelledby="ps-item-where">
        <h3 id="ps-item-where" className="ps-item__label">
          {td('galleries.presets.item.where')}
        </h3>
        <p className="ps-item__prose">{routine.destination?.kind === 'append' ? td('galleries.presets.item.where.append') : td('galleries.presets.item.where.new')}</p>
      </section>
      <p className="ps-item__note">{td('galleries.presets.item.paused')}</p>
    </Sheet>
  )
}
