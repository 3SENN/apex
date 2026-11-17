/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Share… for an app pack (docs/apps.md › Sharing), shaped like a
// companion's Export…: a note for whoever gets it and a share image, made
// from a still of the app drawn off-screen in its own sandbox. Both go inside
// the .atelierapp (beside the signed files, so the review shows them as from
// whoever shared it), and the image is saved next to the file too.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { FileDown } from 'lucide-react'
import { PACK_SHARE_NOTE_MAX, type PackSummary } from '@shared/packs'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, Dialog, Skeleton, toast } from '../ui'
import { renderAppShareImage } from './shareImage'

export function ShareAppDialog({ pack, open, onClose }: { pack: PackSummary; open: boolean; onClose(): void }): ReactElement {
  const t = useT()
  const app = pack.apps[0]
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noteId = useId()

  useEffect(() => {
    if (!open || !app) return
    let live = true
    setImage(undefined)
    setError(null)
    Promise.resolve(call('packs', 'appStill', pack.id, app.id))
      .then((still) => renderAppShareImage({ still, name: app.name, caption: pack.name === app.name ? t('packs.shareApp.caption') : t('packs.shareApp.captionWithPack', { pack: pack.name }) }))
      .then(
        (made) => live && setImage(made),
        // The file is what matters; it still saves without the picture.
        () => live && setImage(null),
      )
    return () => {
      live = false
    }
  }, [open, pack.id, pack.name, app?.id, app?.name, t])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const path = await call('packs', 'exportPack', pack.id, 'installed', { ...(note.trim() ? { note: note.trim().slice(0, PACK_SHARE_NOTE_MAX) } : {}), ...(image ? { image } : {}) })
      if (path) {
        const file = path.split(/[\\/]/).pop() ?? path
        toast.show({ message: image ? t('packs.shareApp.savedWithImage', { file }) : t('packs.shareApp.saved', { file }), tone: 'success' })
        onClose()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={t('packs.shareApp.title', { name: app?.name ?? pack.name })}
      description={t('packs.shareApp.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('packs.shareApp.cancel')}
          </Button>
          <Button variant="primary" icon={<FileDown />} loading={busy} disabled={image === undefined} onClick={() => void run()}>
            {t('packs.shareApp.save')}
          </Button>
        </>
      }
    >
      <div className="pk-share">
        <figure className="pk-share__image">
          {image === undefined ? <Skeleton className="pk-share__placeholder" /> : image ? <img src={image} alt={t('packs.shareApp.imageAlt', { name: app?.name ?? pack.name })} /> : <p className="pk-muted pk-small">{t('packs.shareApp.noImage')}</p>}
        </figure>
        <div className="pk-share__field">
          <label className="pk-share__label" htmlFor={noteId}>
            {t('packs.shareApp.noteLabel')}
          </label>
          <textarea id={noteId} className="pk-share__note" rows={3} maxLength={PACK_SHARE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('packs.shareApp.notePlaceholder')} />
        </div>
        {error && (
          <p className="pk-share__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
