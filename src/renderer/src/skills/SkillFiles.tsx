/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A skill's supporting files (SK-03): browse, open a text file to edit it,
// drop files (or pick them) to add, and remove. Other types are view-only;
// Reveal in Finder opens them. Files arrive at most 5 MB each, 50 in all.
import { useEffect, useId, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { FileText, File as FileIcon, Paperclip, Trash2, X } from 'lucide-react'
import { SKILL_FILE_MAX_BYTES, type SkillFile } from '@shared/skills'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button, ErrorState, IconButton, SkeletonRows, cx, useConfirm, useToast } from '../ui'
import { useEvent, useResource } from '../settings/data'
import { TextArea } from '../settings/kit'
import { fileSizeLabel } from '../companion-card/logic/skills'

export interface SkillFilesProps {
  skillId: string
  readOnly: boolean
  /** ?file= of the address: opened once the list is in. */
  initialFile?: string | null
  onOpenFile?(path: string | null): void
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Couldn’t read that file.'))
    reader.readAsDataURL(file)
  })
}

export function SkillFiles({ skillId, readOnly, initialFile = null, onOpenFile }: SkillFilesProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const files = useResource(() => call('skills', 'files', skillId), skillId, { keep: true })
  useEvent('skill-files', (e) => {
    if (e.skillId === skillId) void files.reload()
  })
  const [open, setOpen] = useState<string | null>(initialFile)
  const [text, setText] = useState<{ path: string; loaded: string; value: string } | { path: string; error: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const editorId = useId()
  const list = files.data ?? []
  const current = open ? list.find((f) => f.path === open) : undefined

  // Open the chosen text file's contents.
  useEffect(() => {
    if (!open || !current) {
      setText(null)
      return
    }
    if (!current.editable) {
      setText(null)
      return
    }
    let live = true
    call('skills', 'readFile', skillId, open).then(
      (value) => live && setText({ path: open, loaded: value, value }),
      (err: unknown) => live && setText({ path: open, error: errorText(err) }),
    )
    return () => void (live = false)
  }, [open, current?.modifiedAt, current?.editable, skillId])

  const choose = async (path: string | null): Promise<void> => {
    if (text && 'value' in text && text.value !== text.loaded) {
      const ok = await confirm({ title: t('skills.editor.discardTitle'), message: t('skills.editor.discardBody'), confirmLabel: t('skills.editor.discard'), cancelLabel: t('skills.editor.keep'), destructive: true })
      if (!ok) return
    }
    setOpen(path)
    onOpenFile?.(path)
  }
  const add = async (picked: FileList | File[]): Promise<void> => {
    setBusy(true)
    for (const file of Array.from(picked)) {
      if (file.size > SKILL_FILE_MAX_BYTES) {
        toast.show({ tone: 'error', message: t('skills.files.tooBig', { file: file.name }) })
        continue
      }
      try {
        const added = await call('skills', 'addFile', skillId, file.name, await toBase64(file))
        toast.show({ tone: 'success', message: t('skills.files.added', { file: added.path }) })
      } catch (err) {
        toast.show({ tone: 'error', message: errorText(err) })
        break
      }
    }
    setBusy(false)
    void files.reload()
  }
  const remove = async (file: SkillFile): Promise<void> => {
    const ok = await confirm({ title: t('skills.files.removeTitle', { file: file.path }), message: t('skills.files.removeBody'), destructive: true })
    if (!ok) return
    try {
      await call('skills', 'removeFile', skillId, file.path)
      if (open === file.path) {
        setOpen(null)
        onOpenFile?.(null)
      }
      toast.show({ message: t('skills.files.removed', { file: file.path }) })
      void files.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const saveText = async (): Promise<void> => {
    if (!text || !('value' in text)) return
    try {
      await call('skills', 'writeFile', skillId, text.path, text.value)
      setText({ ...text, loaded: text.value })
      toast.show({ tone: 'success', message: t('skills.files.savedFile', { file: text.path }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    if (readOnly || !e.dataTransfer.files.length) return
    void add(e.dataTransfer.files)
  }

  return (
    <section className="sk-files" aria-labelledby={`${editorId}-title`}>
      <div className="sk-files__head">
        <h2 id={`${editorId}-title`} className="sk-section-title">
          {t('skills.files.title')}
        </h2>
        {!readOnly && (
          <>
            <Button size="sm" variant="secondary" icon={<Paperclip />} loading={busy} onClick={() => picker.current?.click()}>
              {t('skills.files.add')}
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void add(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        )}
      </div>
      <p className="sp-field__hint">{t('skills.files.hint')}</p>
      <div
        className={cx('sk-files__drop', dragging && 'sk-files__drop--over')}
        onDragOver={(e) => {
          if (readOnly) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {files.loading && !files.data && <SkeletonRows rows={2} label={t('skills.files.loading')} />}
        {files.error && <ErrorState compact message={files.error} onRetry={files.reload} />}
        {files.data && list.length === 0 && <p className="sk-files__empty">{readOnly ? t('skills.files.empty') : t('skills.files.drop')}</p>}
        {list.length > 0 && (
          <ul className="sk-files__list" aria-label={t('skills.files.list')}>
            {list.map((f) => (
              <li key={f.path} className={cx('sk-file', open === f.path && 'sk-file--open')}>
                <button type="button" className="sk-file__main" aria-current={open === f.path ? 'true' : undefined} onClick={() => void choose(open === f.path ? null : f.path)}>
                  {f.editable ? <FileText aria-hidden /> : <FileIcon aria-hidden />}
                  <span className="sk-file__name">{f.path}</span>
                  <span className="sk-file__size">{fileSizeLabel(f.size)}</span>
                  {!f.editable && <Badge>{t('skills.files.viewOnly')}</Badge>}
                </button>
                {!readOnly && <IconButton size="sm" tone="danger" label={t('skills.files.remove', { file: f.path })} icon={<Trash2 />} onClick={() => void remove(f)} />}
              </li>
            ))}
          </ul>
        )}
        {dragging && <p className="sk-files__hint-over">{t('skills.files.drop')}</p>}
      </div>
      {open && current && (
        <div className="sk-file-pane">
          <div className="sk-file-pane__head">
            <span className="sk-file__name">{current.path}</span>
            <IconButton size="sm" label={t('skills.files.close')} icon={<X />} onClick={() => void choose(null)} />
          </div>
          {!current.editable && <p className="sp-field__hint">{t('skills.files.binary', { file: current.path })}</p>}
          {text && 'error' in text && <ErrorState compact message={text.error} />}
          {text && 'value' in text && (
            <>
              <TextArea
                id={editorId}
                code
                rows={14}
                aria-label={t('skills.files.editorLabel', { file: current.path })}
                value={text.value}
                readOnly={readOnly}
                onChange={(e) => setText({ ...text, value: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void saveText()
                  }
                }}
              />
              {!readOnly && (
                <div className="sk-file-pane__actions">
                  {text.value !== text.loaded && <span className="sk-unsaved">{t('skills.editor.unsaved')}</span>}
                  <Button size="sm" variant="primary" disabled={text.value === text.loaded} onClick={() => void saveText()}>
                    {t('skills.files.saveFile')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
