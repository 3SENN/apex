/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://skills/<id> (SK-03): one skill as a page. Its fields, its steps and
// its supporting files; Save (asking before changes are thrown away), Use,
// Export, Reveal in Finder, Duplicate and Delete. A built-in skill opens
// read-only with "Duplicate to edit". apex://skills/new starts a blank one.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, Copy, Download, FolderOpen, MoreHorizontal, Play, Trash2, WandSparkles } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import type { Skill } from '@shared/skills'
import { chatUrl, skillUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button, EmptyState, IconButton, RelativeTime, showMenu, useConfirm, useToast } from '../ui'
import { ExportDialog } from '../ui/ExportDialog'
import { useCompanions, useEvent } from '../settings/data'
import { DestinationFrame } from '../settings/destinations/common'
import { Notice, PageSkeleton } from '../settings/kit'
import { skillFormDirty, skillFormErrors, skillFormInput, type SkillForm, type SkillFormField } from '../companion-card/logic/skills'
import { SkillFiles } from './SkillFiles'
import { SkillFormFields } from './SkillFormFields'
import './skills.css'
import { shareAsPack } from '../packs/share'

export interface SkillEditorPageProps {
  tabId: string
  /** A skill id, or 'new'. */
  skillId: string
  file?: string | null
  /** The owner a new skill starts with. */
  owner?: string
}

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; skill: Skill | null }

export function formOf(skill: Skill | null, owner = SHARED_OWNER): SkillForm {
  return skill
    ? { name: skill.name, description: skill.description, instructions: skill.instructions, steps: skill.steps.map((s) => ({ ...s })), owner: skill.owner }
    : { name: '', description: '', instructions: '', steps: [], owner }
}

export function SkillEditorPage({ tabId, skillId, file = null, owner = SHARED_OWNER }: SkillEditorPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const companions = useCompanions()
  const isNew = skillId === 'new'
  const [load, setLoad] = useState<Load>(isNew ? { kind: 'ready', skill: null } : { kind: 'loading' })
  const [form, setForm] = useState<SkillForm>(() => formOf(null, owner))
  const [base, setBase] = useState<SkillForm>(form)
  const [errors, setErrors] = useState<Partial<Record<SkillFormField, string>>>({})
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const skill = load.kind === 'ready' ? load.skill : null
  const builtin = skill !== undefined && skill !== null && skill.source !== 'user'
  const dirty = !builtin && skillFormDirty(form, base)

  const apply = (next: Skill): void => {
    const f = formOf(next)
    setLoad({ kind: 'ready', skill: next })
    setForm(f)
    setBase(f)
  }
  const fetchSkill = async (): Promise<void> => {
    if (isNew) return
    try {
      apply(await call('skills', 'get', skillId))
    } catch {
      setLoad({ kind: 'missing' })
    }
  }
  useEffect(() => {
    void fetchSkill()
  }, [skillId])
  // Changes made elsewhere (the companion card, Finder) show up unless you are mid-edit.
  useEvent('skills', (e) => {
    if (isNew) return
    const next = e.items.find((s) => s.id === skillId)
    if (!next) setLoad((l) => (l.kind === 'ready' && !dirty ? { kind: 'missing' } : l))
    else if (!dirty) apply(next)
  })

  const leave = async (url: string): Promise<void> => {
    if (dirty) {
      const ok = await confirm({ title: t('skills.editor.discardTitle'), message: t('skills.editor.discardBody'), confirmLabel: t('skills.editor.discard'), cancelLabel: t('skills.editor.keep'), destructive: true })
      if (!ok) return
    }
    void apex.nav.go(tabId, url)
  }
  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })

  const save = async (): Promise<void> => {
    setTried(true)
    const found = skillFormErrors(form)
    setErrors(found)
    if (Object.keys(found).length) {
      if (found.name) nameRef.current?.focus()
      return
    }
    setSaving(true)
    try {
      const saved = await call('skills', 'save', skillFormInput(form, skill?.id))
      apply(saved)
      toast.show({ tone: 'success', message: isNew ? t('skills.page.created', { name: saved.name }) : t('skills.editor.saved', { name: saved.name }) })
      if (isNew) void apex.nav.go(tabId, skillUrl(saved.id))
    } catch (err) {
      const message = errorText(err)
      if (/already exists|name/i.test(message)) setErrors({ name: message })
      else fail(err)
    } finally {
      setSaving(false)
    }
  }
  const use = async (): Promise<void> => {
    if (!skill) return
    if (dirty) await save()
    try {
      const chatId = await call('skills', 'run', skill.id)
      void call('pages', 'open', chatUrl(chatId))
    } catch (err) {
      fail(err)
    }
  }
  const duplicate = async (): Promise<void> => {
    if (!skill) return
    try {
      const copy = await call('skills', 'duplicate', skill.id)
      toast.show({ tone: 'success', message: t('skills.page.duplicated', { name: copy.name }) })
      void apex.nav.go(tabId, skillUrl(copy.id))
    } catch (err) {
      fail(err)
    }
  }
  const remove = async (): Promise<void> => {
    if (!skill) return
    const ok = await confirm({ title: t('skills.page.deleteTitle', { name: skill.name }), message: t('skills.page.deleteBody'), destructive: true })
    if (!ok) return
    try {
      await call('skills', 'remove', skill.id)
      toast.show({ message: t('skills.page.deleted', { name: skill.name }) })
      void apex.nav.go(tabId, 'apex://skills')
    } catch (err) {
      fail(err)
    }
  }
  const exportMenu = async (anchor: Element): Promise<void> => {
    if (!skill) return
    const choice = await showMenu(
      [
        { id: 'doc', label: t('skills.page.exportFile') },
        ...(skill.source === 'user' ? [{ id: 'folder', label: t('skills.page.exportFolder') }, { id: 'share-pack', label: t('packs.share.action') }] : []),
      ],
      anchor,
    )
    if (choice === 'doc') setExporting(true)
    else if (choice === 'share-pack') void shareAsPack('skill', skill.id)
    else if (choice === 'folder') {
      call('skills', 'exportFile', skill.id).then((path) => path && toast.show({ tone: 'success', message: t('skills.page.saved', { file: path.split(/[\\/]/).pop() ?? path }) }), fail)
    }
  }
  const moreMenu = async (anchor: Element): Promise<void> => {
    if (!skill) return
    const choice = await showMenu(
      [
        { id: 'duplicate', label: t('skills.page.duplicate') },
        ...(skill.source === 'user' ? [{ id: 'reveal', label: t('skills.page.reveal') }, { id: 'sep', label: '', type: 'separator' as const }, { id: 'delete', label: t('skills.page.delete'), danger: true }] : []),
      ],
      anchor,
    )
    if (choice === 'duplicate') void duplicate()
    else if (choice === 'reveal') call('skills', 'reveal', skill.id).catch(fail)
    else if (choice === 'delete') void remove()
  }

  if (load.kind === 'loading') {
    return (
      <DestinationFrame label={t('skills.page.title')}>
        <PageSkeleton label={t('skills.editor.loading')} rows={6} />
      </DestinationFrame>
    )
  }
  if (load.kind === 'missing') {
    return (
      <DestinationFrame label={t('skills.page.title')}>
        <EmptyState
          icon={<WandSparkles />}
          title={t('skills.editor.missing')}
          description={t('skills.editor.missingHint')}
          action={
            <Button variant="secondary" icon={<ArrowLeft />} onClick={() => void apex.nav.go(tabId, 'apex://skills')}>
              {t('skills.editor.back')}
            </Button>
          }
        />
      </DestinationFrame>
    )
  }

  const ownerName = skill && skill.owner !== SHARED_OWNER ? companions.items?.find((c) => c.id === skill.owner)?.name : null
  return (
    <DestinationFrame label={t('skills.page.title')}>
      <div
        className="sk-editor"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !builtin && (e.target as HTMLElement).closest('.sk-file-pane') === null) {
            e.preventDefault()
            void save()
          }
        }}
      >
        <button type="button" className="sp-back" onClick={() => void leave('apex://skills')}>
          <ArrowLeft aria-hidden /> {t('skills.editor.back')}
        </button>
        <header className="sk-editor__head">
          <div className="sk-editor__title">
            <h1 className="sp-mono">{skill ? `/${skill.name}` : t('skills.editor.newTitle')}</h1>
            <div className="sk-editor__badges">
              {skill?.source === 'builtin' && <Badge>{t('skills.builtin')}</Badge>}
              {skill?.source === 'pack' && skill.pack && <Badge tone="info">{t('skills.fromPack', { pack: skill.pack.name })}</Badge>}
              {builtin && skill?.builtinVersion && <span className="sk-muted">{t('skills.editor.version', { version: skill.builtinVersion })}</span>}
              {skill && !builtin && skill.owner === SHARED_OWNER && <Badge tone="accent">{t('skills.page.sharedMarker')}</Badge>}
              {ownerName && <Badge>{ownerName}</Badge>}
              {skill && !builtin && (
                <span className="sk-muted">
                  {t('skills.page.updated')} <RelativeTime value={skill.updatedAt} />
                </span>
              )}
              {dirty && <span className="sk-unsaved">{t('skills.editor.unsaved')}</span>}
            </div>
          </div>
          <div className="sk-editor__actions">
            {skill && (
              <Button variant="secondary" icon={<Play />} onClick={() => void use()}>
                {t('skills.editor.use')}
              </Button>
            )}
            {skill && <IconButton label={t('skills.page.export')} icon={<Download />} aria-haspopup="menu" onClick={(e) => void exportMenu(e.currentTarget)} />}
            {skill && skill.source === 'user' && <IconButton label={t('skills.page.reveal')} icon={<FolderOpen />} onClick={() => call('skills', 'reveal', skill.id).catch(fail)} />}
            {skill && <IconButton label={t('skills.page.more', { name: skill.name })} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void moreMenu(e.currentTarget)} />}
            {builtin ? (
              <Button variant="primary" icon={<Copy />} onClick={() => void duplicate()}>
                {t('skills.page.duplicateToEdit')}
              </Button>
            ) : (
              <Button variant="primary" loading={saving} disabled={!isNew && !dirty} onClick={() => void save()}>
                {t('skills.editor.save')}
              </Button>
            )}
          </div>
        </header>
        {builtin && <Notice>{skill?.source === 'pack' ? t('skills.editor.readOnlyPack') : t('skills.editor.readOnly')}</Notice>}
        <SkillFormFields
          form={form}
          onChange={(next) => {
            setForm(next)
            if (tried) setErrors(skillFormErrors(next))
          }}
          errors={errors}
          companions={companions.items ?? []}
          readOnly={builtin}
          nameRef={nameRef}
        />
        {skill && skill.source === 'user' && <SkillFiles skillId={skill.id} readOnly={false} initialFile={file} />}
        {isNew && <p className="sp-field__hint">{t('skills.files.newOnSave')}</p>}
        {skill && !builtin && (
          <div className="sk-editor__footer">
            <Button variant="ghost" className="sk-danger" icon={<Trash2 />} onClick={() => void remove()}>
              {t('skills.page.delete')}
            </Button>
          </div>
        )}
      </div>
      {exporting && skill && <ExportDialog kind="skill" ids={[skill.id]} title={`/${skill.name}`} onClose={() => setExporting(false)} />}
    </DestinationFrame>
  )
}
