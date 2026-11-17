/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The folder access dialog (CH-43): asked after a folder is picked,
// from the + menu, the Files section or a chat. Read only or read and edit;
// all chats or only this chat; an optional companion. With `folder` it
// changes an existing grant instead (mode and scope).
import { useId, useRef, useState, type ReactElement } from 'react'
import type { WatchedFolder } from '@shared/workspace'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { useCompanions } from '../settings/data'
import { Button, Dialog, Select, toast } from '../ui'
import { mountDialog } from './mount'
import './workspace.css'

export interface FolderAccessDialogProps {
  path: string
  chatId: string | null
  onClose(folder: WatchedFolder | null): void
  /** An existing grant to change. */
  folder?: WatchedFolder
}

const ANY = '__any'

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function FolderAccessDialog({ path, chatId, onClose, folder }: FolderAccessDialogProps): ReactElement {
  const t = useT()
  const ids = useId()
  const companions = useCompanions()
  const name = folder?.name ?? folderName(path)
  const scopedChat = folder && typeof folder.scope === 'object' ? folder.scope.chatId : chatId
  const [mode, setMode] = useState<WatchedFolder['mode']>(folder?.mode ?? 'read')
  const [scope, setScope] = useState<'all' | 'chat'>(folder ? (folder.scope === 'all-chats' ? 'all' : 'chat') : 'all')
  const [companionId, setCompanionId] = useState<string>(folder?.companionId ?? ANY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)

  const submit = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    const nextScope: WatchedFolder['scope'] = scope === 'chat' && scopedChat ? { chatId: scopedChat } : 'all-chats'
    try {
      const saved = folder
        ? await call('folders', 'update', folder.id, { mode, scope: nextScope })
        : await call('folders', 'grant', { path, mode, scope: nextScope, companionId: companionId === ANY ? null : companionId })
      if (!folder) toast.show({ message: t('workspace.folder.granted', { name: saved.name }), tone: 'success' })
      onClose(saved)
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  const companionOptions = [{ value: ANY, label: t('workspace.folder.anyCompanion') }, ...(companions.items ?? []).map((c) => ({ value: c.id, label: c.name }))]

  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      title={folder ? t('workspace.folder.changeTitle', { name }) : t('workspace.folder.title')}
      description={folder ? undefined : t('workspace.folder.intro', { name })}
      initialFocus={first}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)}>
            {t('workspace.folder.cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {folder ? t('workspace.folder.save') : t('workspace.folder.grant')}
          </Button>
        </>
      }
    >
      <div className="ws-form">
        <div className="ws-path" title={path}>
          {path}
        </div>
        <fieldset className="ws-choice">
          <legend>{t('workspace.folder.what')}</legend>
          <label className="ws-option">
            <input ref={first} type="radio" name={`${ids}-mode`} checked={mode === 'read'} onChange={() => setMode('read')} aria-describedby={`${ids}-read`} />
            <span className="ws-option__title">{t('workspace.folder.readTitle')}</span>
            <span id={`${ids}-read`} className="ws-option__text">
              {t('workspace.folder.readText')}
            </span>
          </label>
          <label className="ws-option">
            <input type="radio" name={`${ids}-mode`} checked={mode === 'read-write'} onChange={() => setMode('read-write')} aria-describedby={`${ids}-write`} />
            <span className="ws-option__title">{t('workspace.folder.writeTitle')}</span>
            <span id={`${ids}-write`} className="ws-option__text">
              {t('workspace.folder.writeText')}
            </span>
          </label>
        </fieldset>
        {scopedChat && (
          <fieldset className="ws-choice">
            <legend>{t('workspace.folder.which')}</legend>
            <label className="ws-option">
              <input type="radio" name={`${ids}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} />
              <span className="ws-option__title">{t('workspace.folder.allChats')}</span>
            </label>
            <label className="ws-option">
              <input type="radio" name={`${ids}-scope`} checked={scope === 'chat'} onChange={() => setScope('chat')} />
              <span className="ws-option__title">{t('workspace.folder.thisChat')}</span>
            </label>
          </fieldset>
        )}
        {!folder && (companions.items?.length ?? 0) > 0 && (
          <label className="ws-field">
            <span className="ws-field__label" id={`${ids}-companion`}>
              {t('workspace.folder.companion')}
            </span>
            <Select value={companionId} options={companionOptions} onChange={setCompanionId} aria-label={t('workspace.folder.companion')} fullWidth />
          </label>
        )}
        {error && (
          <p className="ws-field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/**
 * Picks a folder (the system dialog) and asks for its access; resolves with
 * the grant, or null when either step was cancelled. Used by the + menu and
 * the Files section.
 */
export async function shareFolder(chatId: string | null = null): Promise<WatchedFolder | null> {
  const path = await call('folders', 'pick')
  if (!path) return null
  return mountDialog<WatchedFolder | null>((done) => <FolderAccessDialog path={path} chatId={chatId} onClose={done} />)
}

/** Changes an existing grant's access. */
export function changeFolderAccess(folder: WatchedFolder): Promise<WatchedFolder | null> {
  return mountDialog<WatchedFolder | null>((done) => <FolderAccessDialog path={folder.path} chatId={null} folder={folder} onClose={done} />)
}
