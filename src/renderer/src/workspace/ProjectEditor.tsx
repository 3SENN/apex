/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The project editor: name, colour from Apex's project
// palette, a description and the standing instructions every new chat in
// the project starts with. Used by the Projects section and by "New
// project…" in the chat menus and the Space row.
import { useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { PROJECT_COLORS, PROJECT_NAME_MAX, type Project, type ProjectColor } from '@shared/workspace'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, Dialog, cx, useRovingFocus } from '../ui'
import { projectColor } from './logic'
import { mountDialog } from './mount'
import './workspace.css'

export interface ProjectEditorProps {
  /** The project to edit; null creates one. */
  project: Project | null
  onClose(saved: Project | null): void
}

export function ProjectEditor({ project, onClose }: ProjectEditorProps): ReactElement {
  const t = useT()
  const ids = useId()
  const [name, setName] = useState(project?.name ?? '')
  const [color, setColor] = useState<ProjectColor>(projectColor(project?.color ?? PROJECT_COLORS[(Date.now() >> 10) % PROJECT_COLORS.length]))
  const [description, setDescription] = useState(project?.description ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState(false)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const swatches = useRef<HTMLDivElement>(null)
  const onSwatchKey = useRovingFocus(swatches, {
    orientation: 'horizontal',
    onMove: (el) => {
      const value = el.dataset.color
      if (value) setColor(projectColor(value))
    },
  })

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (saving) return
    if (!name.trim()) {
      setNameError(true)
      nameRef.current?.focus()
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await call('projects', 'save', { ...(project ? { id: project.id } : {}), name: name.trim(), color, description: description.trim(), instructions: instructions.trim() })
      onClose(saved)
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      title={project ? t('workspace.editor.editTitle') : t('workspace.editor.newTitle')}
      initialFocus={nameRef}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)}>
            {t('workspace.editor.cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {project ? t('workspace.editor.save') : t('workspace.editor.create')}
          </Button>
        </>
      }
    >
      <form className="ws-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="ws-field">
          <span className="ws-field__label">{t('workspace.editor.name')}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            maxLength={PROJECT_NAME_MAX}
            placeholder={t('workspace.editor.namePlaceholder')}
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? `${ids}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value)
              if (e.target.value.trim()) setNameError(false)
            }}
          />
          {nameError && (
            <span id={`${ids}-name-error`} className="ws-field__error" role="alert">
              {t('workspace.editor.nameRequired')}
            </span>
          )}
        </label>
        <div className="ws-field">
          <span className="ws-field__label" id={`${ids}-color`}>
            {t('workspace.editor.color')}
          </span>
          <div ref={swatches} className="ws-swatches" role="radiogroup" aria-labelledby={`${ids}-color`} onKeyDown={onSwatchKey}>
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                className="ws-swatch"
                data-color={c}
                aria-checked={color === c}
                aria-label={t(`workspace.color.${c}`)}
                title={t(`workspace.color.${c}`)}
                tabIndex={color === c ? 0 : -1}
                onClick={() => setColor(c)}
              >
                <span className={cx('ws-dot', `ws-dot--${c}`)} aria-hidden />
              </button>
            ))}
          </div>
        </div>
        <label className="ws-field">
          <span className="ws-field__label">{t('workspace.editor.description')}</span>
          <input type="text" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} aria-describedby={`${ids}-desc`} />
          <span id={`${ids}-desc`} className="ws-field__hint">
            {t('workspace.editor.descriptionHint')}
          </span>
        </label>
        <label className="ws-field">
          <span className="ws-field__label">{t('workspace.editor.instructions')}</span>
          <textarea value={instructions} maxLength={20_000} onChange={(e) => setInstructions(e.target.value)} aria-describedby={`${ids}-instr`} />
          <span id={`${ids}-instr`} className="ws-field__hint">
            {t('workspace.editor.instructionsHint')}
          </span>
        </label>
        {error && (
          <p className="ws-field__error" role="alert">
            {error}
          </p>
        )}
        {/* Enter in a field submits. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  )
}

/** Opens the editor from plain code; resolves with the saved project, or null. */
export function openProjectEditor(project: Project | null = null): Promise<Project | null> {
  return mountDialog<Project | null>((done) => <ProjectEditor project={project} onClose={done} />)
}
