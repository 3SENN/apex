/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reviewing a preset that changed in an update (CO-17): each field the new
// version changed, yours beside the preset's. Fields you edited yourself are
// marked and never pre-selected, so your edits stay unless you choose
// otherwise; "Keep mine" marks the update reviewed without taking anything.
import { useEffect, useState, type ReactElement } from 'react'
import { PRESET_UPDATE_ACKNOWLEDGE, type PresetDiffRow } from '@shared/onboarding'
import type { Companion } from '@shared/companion'
import { call, errorText } from '../api'
import { Button, CheckRow, toast } from '../ui'
import '../guidance/presets.css'
import { useT, t } from '../i18n/useT'

const FIELD_LABEL: Record<string, string> = { get name() { return t('coCard.presetReview.name') }, get colors() { return t('coCard.presetReview.colours') }, get parts() { return t('coCard.presetReview.parts') }, get face() { return t('coCard.presetReview.face') } }

export function PresetReview({ companionId, onDone }: { companionId: string; onDone?(companion: Companion | null): void }): ReactElement | null {
  const t = useT()
  const [rows, setRows] = useState<PresetDiffRow[] | null>(null)
  const [take, setTake] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    call('companions', 'presetDiff', companionId).then(
      (diff) => {
        if (!live) return
        setRows(diff)
        setTake(new Set((diff ?? []).filter((r) => !r.edited).map((r) => r.field)))
      },
      () => live && setRows(null),
    )
    return () => {
      live = false
    }
  }, [companionId])

  if (!rows || rows.length === 0) return null
  const apply = async (fields: string[]): Promise<void> => {
    setBusy(true)
    try {
      const updated = await call('companions', 'applyPresetUpdate', companionId, fields.length ? fields : [PRESET_UPDATE_ACKNOWLEDGE])
      toast.show({ message: fields.length ? t('coCard.presetReview.updatedFromTheNew') : t('coCard.presetReview.keptYourVersion'), tone: 'success' })
      setRows(null)
      onDone?.(updated)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      setBusy(false)
    }
  }
  return (
    <section className="co-preset-review" aria-labelledby="co-preset-review-title">
      <h3 id="co-preset-review-title">{t('coCard.presetReview.thisPresetWasUpdated')}</h3>
      <p className="co-hint">{t('coCard.presetReview.chooseWhatToTake')}</p>
      <ul className="co-preset-review__rows">
        {rows.map((r) => (
          <li key={r.field} className="co-preset-review__row">
            <CheckRow
              label={`${FIELD_LABEL[r.field] ?? r.field}${r.edited ? t('coCard.presetReview.youChangedThis') : ''}`}
              checked={take.has(r.field)}
              onChange={(on) =>
                setTake((t) => {
                  const n = new Set(t)
                  if (on) n.add(r.field)
                  else n.delete(r.field)
                  return n
                })
              }
            />
            <dl className="co-preset-review__values">
              <dt>{t('coCard.presetReview.yours')}</dt>
              <dd>{r.yours}</dd>
              <dt>{t('coCard.presetReview.newPreset')}</dt>
              <dd>{r.preset}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="co-preset-review__actions">
        <Button variant="ghost" disabled={busy} onClick={() => void apply([])}>{t('coCard.presetReview.keepMine')}</Button>
        <Button variant="primary" loading={busy} disabled={take.size === 0} onClick={() => void apply([...take])}>{t('coCard.presetReview.updateFields', { count: take.size })}</Button>
      </div>
    </section>
  )
}
