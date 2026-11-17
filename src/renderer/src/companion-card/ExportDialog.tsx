/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState } from 'react'
import { FileDown } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { call, errorText } from '../api'
import { Button, Dialog, Switch, toast } from '../ui'
import { renderShareImage } from './shareImage'
import { useLoaded } from './useLoaded'
import { useT } from '../i18n/useT'

const NOTE_MAX = 500

/** Counts of what the companion owns, so the switches say what each one adds. */
function useOwnedCounts(companionId: string): { skills: number; routines: number; notes: number } | null {
  const { data } = useLoaded(
    async () => {
      const [skills, routines, notes] = await Promise.all([call('skills', 'list'), call('routines', 'list'), call('memory', 'list', companionId)])
      return { skills: skills.filter((s) => s.owner === companionId).length, routines: routines.filter((r) => r.owner === companionId).length, notes: notes.length }
    },
    [companionId],
    (e) => e.type === 'skills' || e.type === 'routines' || (e.type === 'memory' && e.owner === companionId),
  )
  return data
}

/**
 * Export…: a .apexcompanion file with the look, name, personality,
 * instructions and model defaults, plus whatever the switches add, and a
 * share image saved beside it.
 */
export function ExportDialog({ companion, open, onClose }: { companion: Companion; open: boolean; onClose(): void }) {
  const t = useT()
  const counts = useOwnedCounts(companion.id)
  const [skills, setSkills] = useState(true)
  const [routines, setRoutines] = useState(true)
  const [memory, setMemory] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noteId = useId()

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    let shareImage: string | undefined
    try {
      shareImage = await renderShareImage(companion)
    } catch (err) {
      // The file is what matters; it still saves without the picture.
      console.warn('The share image could not be drawn:', errorText(err))
    }
    try {
      const path = await call('companions', 'export', companion.id, {
        includeSkills: skills && (counts?.skills ?? 0) > 0,
        includeRoutines: routines && (counts?.routines ?? 0) > 0,
        includeMemory: memory && (counts?.notes ?? 0) > 0,
        ...(note.trim() ? { note: note.trim().slice(0, NOTE_MAX) } : {}),
        ...(shareImage ? { shareImage } : {}),
      })
      if (path) {
        const file = path.split(/[\\/]/).pop() ?? path
        toast.show({ message: shareImage ? t('coCard.exportDialog.savedWithAShare', { file }) : t('coCard.exportDialog.saved', { file }), tone: 'success' })
        onClose()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const count = (n: number | undefined, key: 'coCard.exportDialog.skillCount' | 'coCard.exportDialog.routineCount' | 'coCard.exportDialog.noteCount'): string => (n === undefined ? '' : n === 0 ? t('coCard.exportDialog.noneYet') : t(key, { count: n }))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={t('coCard.exportDialog.export', { name: companion.name })}
      description={t('coCard.exportDialog.savesAFileAnyone')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('coCard.exportDialog.cancel')}</Button>
          <Button variant="primary" icon={<FileDown />} loading={busy} onClick={() => void run()}>{t('coCard.exportDialog.export2')}</Button>
        </>
      }
    >
      <div className="co-export">
        <Switch checked={skills} onChange={setSkills} disabled={counts?.skills === 0} label={t('coCard.exportDialog.includeItsSkills')} description={count(counts?.skills, 'coCard.exportDialog.skillCount')} />
        <Switch checked={routines} onChange={setRoutines} disabled={counts?.routines === 0} label={t('coCard.exportDialog.includeItsRoutines')} description={`${count(counts?.routines, 'coCard.exportDialog.routineCount')}${counts?.routines ? t('coCard.exportDialog.arrivePaused') : ''}`} />
        <Switch
          checked={memory}
          onChange={setMemory}
          disabled={counts?.notes === 0}
          label={t('coCard.exportDialog.includeItsMemory')}
          description={`${count(counts?.notes, 'coCard.exportDialog.noteCount')}${counts?.notes ? t('coCard.exportDialog.notesPersonal') : ''}`}
        />
        <div className="co-field">
          <label className="co-field__label" htmlFor={noteId}>{t('coCard.exportDialog.aNoteForWhoever')}</label>
          <textarea id={noteId} className="co-textarea" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('coCard.exportDialog.whatThisCompanionIs')} />
        </div>
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}
