/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState } from 'react'
import { Brain, MessageSquareText, Plus, Settings2, Sparkles, X } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { SHARED_OWNER, type MemoryFile, type Owner } from '@shared/services'
import { call, errorText } from '../api'
import { Button, Dialog, ErrorState, RelativeTime, SegmentedControl, SkeletonRows, confirm, toast } from '../ui'
import { filterNotes, itemToPath, noteFolder, notePathFromName, noteTitle, timelineDays, type AuthorFilter } from './logic/notes'
import { ListSearch, ListSkeleton, ListTabHeader, useSkeletonPhase } from './ListTab'
import { Nested } from './Nested'
import { useLoaded } from './useLoaded'
import { CardTidy } from '../activity/CardTidy'
import { t } from '../i18n/useT'

interface MemoryTabProps {
  companion: Companion
  /** A deep-linked note (base64url path, see logic/notes). */
  focusItem: string | null
}

type Scope = 'own' | 'shared'
/** CO-09: the tab's two views, the nightly tidy and the notes. */
type View = 'tidy' | 'notes'

const EXPLAINER_KEY = 'apex.card.memory.explainerHidden'

function readExplainerHidden(): boolean {
  try {
    return localStorage.getItem(EXPLAINER_KEY) === '1'
  } catch {
    return false
  }
}

export function MemoryTab({ companion, focusItem }: MemoryTabProps) {
  const [view, setView] = useState<View>('notes')
  const [scope, setScope] = useState<Scope>('own')
  const [author, setAuthor] = useState<AuthorFilter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ owner: Owner; path: string } | 'new' | null>(null)
  const owner = scope === 'own' ? companion.id : SHARED_OWNER
  const notes = useLoaded(() => call('memory', 'list', owner), [owner], (e) => e.type === 'memory' && e.owner === owner)
  const phase = useSkeletonPhase(notes.status === 'loading' && !notes.data)

  // A link to one note opens it.
  useEffect(() => {
    const path = itemToPath(focusItem)
    if (path) {
      setView('notes')
      setOpen({ owner: companion.id, path })
    }
  }, [focusItem, companion.id])

  const visible = filterNotes(notes.data ?? [], { author, query })
  const days = timelineDays(visible)
  const [explainerHidden, setExplainerHidden] = useState(readExplainerHidden)
  const hideExplainer = (): void => {
    setExplainerHidden(true)
    try {
      localStorage.setItem(EXPLAINER_KEY, '1')
    } catch {
      // Hidden for this view only when storage is blocked.
    }
  }
  const authorName = (file: MemoryFile): string | null => (file.author === 'agent' ? companion.name : file.author === 'you' ? t('coCard.memory.you') : null)

  return (
    <div className="co-tab co-memory">
      <ListTabHeader
        title={t('coCard.memory.memory')}
        help={
          scope === 'own'
            ? t('coCard.memory.whatRemembersBetweenChats', { name: companion.name, name2: companion.name })
            : t('coCard.memory.notesEveryCompanionCan')
        }
        action={
          view === 'notes'
            ? { label: t('memory.card.newNote'), icon: <Plus aria-hidden />, onClick: () => setOpen('new') }
            : { label: t('memory.card.settings'), icon: <Settings2 aria-hidden />, onClick: () => void call('pages', 'open', 'apex://settings/memory') }
        }
      />
      {!explainerHidden && (
        <div className="co-memory__explainer" role="note">
          <span className="co-memory__point">
            <MessageSquareText aria-hidden />
            <span>{t('memory.card.explainChat', { name: companion.name })}</span>
          </span>
          <span className="co-memory__point">
            <Sparkles aria-hidden />
            <span>{t('memory.card.explainTidy', { name: companion.name })}</span>
          </span>
          <span className="co-memory__point">
            <Brain aria-hidden />
            <span>{t('memory.card.explainStart', { name: companion.name })}</span>
          </span>
          <button type="button" className="co-memory__dismiss" aria-label={t('memory.card.dismissExplainer')} onClick={hideExplainer}>
            <X aria-hidden />
          </button>
        </div>
      )}
      <SegmentedControl<View>
        label={t('memory.card.views')}
        className="co-memory__views"
        options={[
          { value: 'tidy', label: t('memory.card.viewTidy') },
          { value: 'notes', label: t('memory.card.viewNotes') },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'tidy' && <CardTidy companion={companion} />}
      {view === 'notes' && (
      <>
      <SegmentedControl<Scope>
        label={t('memory.card.scope')}
        size="sm"
        className="am-card-scope"
        options={[{ value: 'own', label: `${companion.name}’s` }, { value: 'shared', label: t('coCard.memory.shared') }]}
        value={scope}
        onChange={setScope}
      />
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder={t('coCard.memory.searchNotes')}
        trailing={
          <SegmentedControl<AuthorFilter>
            label={t('coCard.memory.writtenBy')}
            size="sm"
            options={[{ value: 'all', label: t('coCard.memory.anyone') }, { value: 'agent', label: scope === 'own' ? companion.name : t('coCard.memory.companions') }, { value: 'you', label: t('coCard.memory.you') }]}
            value={author}
            onChange={setAuthor}
          />
        }
      />
      {phase === 'skeleton' && <ListSkeleton label={t('coCard.list.loading.notes')} />}
      {notes.status === 'error' && <ErrorState compact message={notes.error ?? undefined} onRetry={notes.reload} />}
      {notes.data && phase === 'done' && days.length === 0 && (
        <p className="co-empty-line">
          {query || author !== 'all' ? t('coCard.memory.noNotesMatch') : scope === 'own' ? t('coCard.memory.hasnTSavedAny', { name: companion.name }) : t('coCard.memory.noSharedNotesYet')}
        </p>
      )}
      {phase === 'done' && days.length > 0 && (
        <ol className="co-timeline" aria-label={t('coCard.memory.notesByDay')}>
          {days.map((day) =>
            day.items.map((file, i) => {
              const by = authorName(file)
              const folder = noteFolder(file.path)
              return (
                <li key={file.path} className="co-timeline__entry">
                  <span className="co-timeline__date">{i === 0 ? day.label : ''}</span>
                  <span className="co-timeline__rail" aria-hidden="true">
                    <i className="co-timeline__node" />
                  </span>
                  <button type="button" className="co-timeline__content" onClick={() => setOpen({ owner, path: file.path })}>
                    <span className="co-timeline__title">{noteTitle(file.path)}</span>
                    <span className="co-timeline__text">
                      {by && `${by} · `}
                      {folder && `${folder} · `}
                      {t('coCard.memory.changed')} <RelativeTime value={file.modifiedAt} />
                    </span>
                  </button>
                </li>
              )
            }),
          )}
        </ol>
      )}
      </>
      )}
      {open && (
        <Nested>
        <NoteDialog
          companion={companion}
          owner={open === 'new' ? owner : open.owner}
          path={open === 'new' ? null : open.path}
          taken={new Set((notes.data ?? []).map((n) => n.path))}
          onClose={() => setOpen(null)}
        />
        </Nested>
      )}
    </div>
  )
}

function NoteDialog({ companion, owner, path, taken, onClose }: { companion: Companion; owner: Owner; path: string | null; taken: ReadonlySet<string>; onClose(): void }) {
  const isNew = path === null
  const note = useLoaded(() => (path ? call('memory', 'read', path, owner) : Promise.resolve('')), [path, owner])
  const [name, setName] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { name: useId(), text: useId() }
  const value = text ?? note.data ?? ''
  const target = isNew ? notePathFromName(name) : path
  // A new note never quietly replaces one that already has its name.
  const clash = isNew && target !== null && taken.has(target)
  const where = owner === SHARED_OWNER ? 'shared notes' : `${companion.name}’s notes`

  const save = (): void => {
    if (!target || clash) return
    setBusy(true)
    setError(null)
    call('memory', 'write', target, value, owner).then(
      () => {
        toast.show({ message: isNew ? t('coCard.memory.addedTo', { where }) : t('coCard.memory.noteSaved'), tone: 'success' })
        onClose()
      },
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      },
    )
  }
  const remove = async (): Promise<void> => {
    if (!path) return
    const ok = await confirm({ title: t('coCard.memory.delete2', { value: noteTitle(path) }), message: owner === SHARED_OWNER ? t('coCard.memory.everyCompanionForgetsIt') : t('coCard.memory.forgetsIt', { name: companion.name }), destructive: true })
    if (!ok) return
    call('memory', 'remove', path, owner).then(onClose, (err: unknown) => setError(errorText(err)))
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={isNew ? t('coCard.memory.newNote') : noteTitle(path)}
      description={isNew ? `Saved to ${where}.` : <code className="co-path">{path}</code>}
      footer={
        <>
          {!isNew && <Button variant="danger" className="co-footer-start" onClick={() => void remove()} disabled={busy}>{t('coCard.memory.delete')}</Button>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('coCard.memory.cancel')}</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!target || clash || note.status !== 'ready'}>{t('coCard.memory.saveNote')}</Button>
        </>
      }
    >
      <div className="co-form">
        {isNew && (
          <div className="co-field">
            <label className="co-field__label" htmlFor={ids.name}>{t('coCard.memory.name')}</label>
            <input id={ids.name} className="co-input" value={name} placeholder={t('coCard.memory.travelPreferences')} data-autofocus onChange={(e) => setName(e.target.value)} />
            {name && !target && <p className="co-field__error">{t('coCard.memory.useLettersOrDigits')}</p>}
            {clash && <p className="co-field__error">{t('coCard.memory.aNoteWithThis')}</p>}
          </div>
        )}
        {note.status === 'loading' && <SkeletonRows rows={2} label={t('coCard.memory.loadingTheNote')} />}
        {note.status === 'error' && <ErrorState compact message={note.error ?? undefined} onRetry={note.reload} />}
        {note.status === 'ready' && (
          <div className="co-field">
            <label className="co-field__label" htmlFor={ids.text}>{t('coCard.memory.text')}</label>
            <textarea id={ids.text} className="co-textarea co-textarea--code" rows={12} value={value} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}
