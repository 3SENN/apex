/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One block of Settings › Memory (ST-47): the notes of one owner (shared,
// or one companion) as plain files, each with a Markdown preview and Edit
// (main keeps a version before every save), plus Build from past chats,
// Reorganize and Delete all, with their background jobs.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Brain, FilePlus, FileText, ListRestart, MessageSquareText, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import type { MemoryJob } from '@shared/activity'
import { engineHasOwnAccount, type EngineId } from '@shared/engine'
import type { MemoryFile, Owner } from '@shared/services'
import { chatUrl } from '@shared/url'
import { call, errorText, formatBytes } from '../api'
import { Markdown } from '../chat/Markdown'
import { useT } from '../i18n/useT'
import { useEvent, useResource } from '../settings/data'
import { Card, ListFrame, Notice, TextArea, TextInput } from '../settings/kit'
import { memoryDisplayName, memoryFilePath } from '../settings/logic/filters'
import { Button, Dialog, EmptyState, ErrorState, IconButton, RelativeTime, SegmentedControl, SkeletonRows, useConfirm, useToast } from '../ui'
import { JOB_STATE_KEYS, canRetry, jobsFor } from './logic'

interface OpenNote {
  path: string
  saved: string
  text: string
  mode: 'preview' | 'edit'
}

export interface MemoryBlockProps {
  owner: Owner
  /** "shared notes", "Pip’s notes". */
  whose: string
  jobs: readonly MemoryJob[]
  engine: EngineId
  /** Tells the page a job changed (start, cancel, retry answer at once). */
  onJob(job: MemoryJob): void
}

export function MemoryBlock({ owner, whose, jobs, engine, onJob }: MemoryBlockProps): ReactElement {
  const t = useT()
  const ids = useId()
  const confirm = useConfirm()
  const toast = useToast()
  const files = useResource(() => call('memory', 'list', owner), owner)
  const [open, setOpen] = useState<OpenNote | null>(null)
  const [newName, setNewName] = useState('')
  const [newError, setNewError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)

  useEvent('memory', (e) => {
    if (e.owner === owner) void files.reload()
  })
  // Another owner shows other notes.
  useEffect(() => setOpen(null), [owner])

  const dirty = open !== null && open.text !== open.saved
  const leaveEditor = async (): Promise<boolean> => {
    if (!open || open.text === open.saved) return true
    return confirm({ title: t('memory.memory.discardTitle'), message: t('memory.memory.discardMessage', { name: memoryDisplayName(open.path) }), confirmLabel: t('memory.memory.discard'), destructive: true })
  }
  const openFile = async (path: string, mode: OpenNote['mode'] = 'preview'): Promise<void> => {
    if (open?.path === path || !(await leaveEditor())) return
    setEditorError(null)
    try {
      const text = await call('memory', 'read', path, owner)
      setOpen({ path, saved: text, text, mode })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const save = async (): Promise<void> => {
    if (!open || !dirty) return
    setSaving(true)
    setEditorError(null)
    try {
      await call('memory', 'write', open.path, open.text, owner)
      setOpen({ ...open, saved: open.text })
    } catch (err) {
      setEditorError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  const create = async (): Promise<void> => {
    const path = memoryFilePath(newName)
    if (!path) {
      setNewError(t('memory.memory.badName'))
      return
    }
    setNewError(null)
    setNewName('')
    if (files.data?.some((f) => f.path === path)) {
      await openFile(path, 'edit')
      return
    }
    if (!(await leaveEditor())) return
    try {
      await call('memory', 'write', path, '', owner)
      setOpen({ path, saved: '', text: '', mode: 'edit' })
    } catch (err) {
      setNewError(errorText(err))
    }
  }
  const remove = async (file: MemoryFile): Promise<void> => {
    const name = memoryDisplayName(file.path)
    if (!(await confirm({ title: t('memory.memory.deleteTitle', { name }), message: t('memory.memory.deleteMessage'), destructive: true }))) return
    try {
      await call('memory', 'remove', file.path, owner)
      if (open?.path === file.path) setOpen(null)
      toast.show({ message: t('memory.memory.deleted', { name }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const removeAll = async (): Promise<void> => {
    const count = files.data?.length ?? 0
    if (count === 0) return
    if (!(await confirm({ title: t('memory.memory.deleteAllTitle', { whose }), message: t('memory.memory.deleteAllMessage', { count }), confirmLabel: t('memory.memory.deleteAll'), destructive: true }))) return
    try {
      const removed = await call('memory', 'removeAll', owner)
      setOpen(null)
      toast.show({ message: t('memory.memory.deleteAllDone', { count: removed }) })
      void files.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const reorganize = async (): Promise<void> => {
    if (!(await confirm({ title: t('memory.memory.reorganizeTitle', { whose }), message: t('memory.memory.reorganizeMessage'), confirmLabel: t('memory.memory.reorganizeStart') }))) return
    try {
      onJob(await call('memory', 'startJob', 'reorganize', owner))
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const list = files.data
  const mine = jobsFor(jobs, owner)
  const running = mine.some((j) => j.state === 'running')

  return (
    <div className="am-block">
      <div className="am-block__actions" role="group" aria-label={t('memory.memory.actions')}>
        <Button size="sm" icon={<Sparkles />} disabled={running} onClick={() => setBuilding(true)}>
          {t('memory.memory.build')}
        </Button>
        <Button size="sm" icon={<ListRestart />} disabled={running || !list || list.length === 0} onClick={() => void reorganize()}>
          {t('memory.memory.reorganize')}
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 />} disabled={!list || list.length === 0} onClick={() => void removeAll()}>
          {t('memory.memory.deleteAll')}
        </Button>
      </div>

      {mine.length > 0 && <JobList jobs={mine} whose={whose} onJob={onJob} />}

      <form
        className="sp-field__row am-block__new"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <TextInput
          className="sp-input--inline"
          value={newName}
          placeholder={t('memory.memory.newPlaceholder')}
          aria-label={t('memory.memory.newLabel')}
          invalid={!!newError}
          aria-describedby={newError ? `${ids}-new-error` : undefined}
          onChange={(e) => {
            setNewName(e.target.value)
            setNewError(null)
          }}
        />
        <Button type="submit" size="sm" icon={<FilePlus />} disabled={!newName.trim()}>
          {t('memory.memory.add')}
        </Button>
      </form>
      {newError && (
        <p id={`${ids}-new-error`} className="sp-field__error" role="alert">
          {newError}
        </p>
      )}

      {open && (
        <Card className="sp-editor am-note">
          <div className="sp-editor__head">
            <FileText size={16} aria-hidden />
            <h3 className="sp-editor__title sp-mono" title={open.path}>
              {memoryDisplayName(open.path)}
            </h3>
            <SegmentedControl<OpenNote['mode']>
              size="sm"
              label={memoryDisplayName(open.path)}
              options={[
                { value: 'preview', label: t('memory.memory.preview') },
                { value: 'edit', label: t('memory.memory.edit') },
              ]}
              value={open.mode}
              onChange={(mode) => setOpen({ ...open, mode })}
            />
            {open.mode === 'edit' && (
              <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
                {dirty ? t('memory.memory.save') : t('memory.memory.savedState')}
              </Button>
            )}
            <IconButton size="sm" label={t('memory.memory.close')} icon={<X />} onClick={() => void leaveEditor().then((ok) => ok && setOpen(null))} />
          </div>
          {open.mode === 'preview' ? (
            open.text.trim() ? (
              <div className="am-note__preview">
                <Markdown text={open.text} />
              </div>
            ) : (
              <p className="am-muted">{t('memory.memory.emptyNote')}</p>
            )
          ) : (
            <TextArea
              code
              value={open.text}
              aria-label={t('memory.memory.contents', { name: memoryDisplayName(open.path) })}
              spellCheck
              autoFocus
              onChange={(e) => setOpen({ ...open, text: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
          )}
          {editorError && (
            <p className="sp-field__error" role="alert">
              {editorError}
            </p>
          )}
          {open.mode === 'edit' && <p className="sp-field__hint">{t('memory.memory.versionsNote')}</p>}
        </Card>
      )}

      <ListFrame label={whose}>
        {list === null ? (
          files.error ? (
            <ErrorState title={t('memory.memory.loadError')} message={files.error} onRetry={files.reload} />
          ) : (
            <SkeletonRows rows={3} label={t('memory.memory.loading')} />
          )
        ) : list.length === 0 ? (
          <EmptyState icon={<Brain />} title={t('memory.memory.empty')} description={t('memory.memory.emptyHint')} />
        ) : (
          list.map((f) => (
            <div key={f.path} className="sp-item" aria-current={open?.path === f.path || undefined}>
              <span className="sp-item__icon" aria-hidden>
                <FileText />
              </span>
              <button type="button" className="sp-item__main" onClick={() => void openFile(f.path)}>
                <span className="sp-item__title">
                  <span className="sp-item__title-text sp-mono">{memoryDisplayName(f.path)}</span>
                </span>
                <span className="sp-item__sub">
                  {formatBytes(f.size)} · {f.author === 'agent' ? t('memory.memory.byAgent') : f.author === 'you' ? t('memory.memory.byYou') : t('memory.memory.saved')} <RelativeTime value={f.modifiedAt} />
                </span>
              </button>
              <div className="sp-item__actions sp-item__actions--reveal">
                <IconButton size="sm" tone="danger" label={t('memory.memory.delete', { name: memoryDisplayName(f.path) })} icon={<Trash2 />} onClick={() => void remove(f)} />
              </div>
            </div>
          ))
        )}
      </ListFrame>

      {building && <BuildDialog owner={owner} whose={whose} engine={engine} onClose={() => setBuilding(false)} onStarted={onJob} />}
    </div>
  )
}

function JobList({ jobs, whose, onJob }: { jobs: readonly MemoryJob[]; whose: string; onJob(job: MemoryJob): void }): ReactElement {
  const t = useT()
  const toast = useToast()
  const fail = (err: unknown): void => {
    toast.show({ tone: 'error', message: errorText(err) })
  }
  return (
    <ul className="am-jobs" aria-label={t('memory.jobs.title')}>
      {jobs.slice(0, 5).map((job) => {
        const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0
        return (
          <li key={job.id} className="am-job" data-state={job.state}>
            <div className="am-job__text">
              <span className="am-job__title">{t(job.kind === 'build' ? 'memory.jobs.build' : 'memory.jobs.reorganize', { whose })}</span>
              <span className="am-job__sub">
                {t(JOB_STATE_KEYS[job.state])} · {t('memory.jobs.progress', { done: job.done, total: job.total })}
                {job.skippedChats ? ` · ${t('memory.jobs.skippedChats', { count: job.skippedChats })}` : ''}
                {job.error && ` · ${job.error}`}
              </span>
              {job.state === 'running' && (
                <span className="am-job__bar" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done} aria-label={t('memory.jobs.progress', { done: job.done, total: job.total })}>
                  <span className="am-job__fill" style={{ width: `${pct}%` }} />
                </span>
              )}
            </div>
            <div className="am-job__actions">
              {job.chatId && (
                <Button size="sm" variant="ghost" icon={<MessageSquareText />} onClick={() => void call('pages', 'open', chatUrl(job.chatId as string))}>
                  {t('memory.jobs.openChat')}
                </Button>
              )}
              {job.state === 'running' && (
                <Button size="sm" variant="ghost" onClick={() => void call('memory', 'cancelJob', job.id).catch(fail)}>
                  {t('memory.jobs.cancel')}
                </Button>
              )}
              {canRetry(job) && (
                <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void call('memory', 'retryJob', job.id).then(onJob, fail)}>
                  {t('memory.jobs.retry')}
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Build from past chats: the estimate first, then Start or Cancel. */
function BuildDialog({ owner, whose, engine, onClose, onStarted }: { owner: Owner; whose: string; engine: EngineId; onClose(): void; onStarted(job: MemoryJob): void }): ReactElement {
  const t = useT()
  const estimate = useResource(() => call('memory', 'estimateBuild', owner), owner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const e = estimate.data

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onStarted(await call('memory', 'startJob', 'build', owner))
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="md"
      title={t('memory.build.title')}
      description={t('memory.build.description', { whose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('memory.build.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={!e || e.chats === 0}>
            {t('memory.build.start')}
          </Button>
        </>
      }
    >
      {!e && !estimate.error && <SkeletonRows rows={2} label={t('memory.build.estimating')} />}
      {!e && estimate.error && <ErrorState compact title={t('memory.build.estimateError')} message={estimate.error} onRetry={estimate.reload} />}
      {e && e.chats === 0 && <p className="am-muted">{t('memory.build.none')}</p>}
      {e && e.chats > 0 && (
        <div className="am-estimate">
          <dl className="am-estimate__stats">
            <div>
              <dt>{t('memory.build.chats')}</dt>
              <dd>{e.chats.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('memory.build.messages')}</dt>
              <dd>{e.messages.toLocaleString()}</dd>
            </div>
          </dl>
          <p className="am-estimate__line">{t('memory.build.tokens', { count: e.approxInputTokens.toLocaleString() })}</p>
          {e.approxCostUsd !== null ? (
            <>
              <p className="am-estimate__line">{t('memory.build.cost', { cost: e.approxCostUsd.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) })}</p>
              <p className="am-muted">{t('memory.build.costNote')}</p>
            </>
          ) : (
            engineHasOwnAccount(engine) && <p className="am-muted">{t('memory.build.ownAccount')}</p>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  )
}
