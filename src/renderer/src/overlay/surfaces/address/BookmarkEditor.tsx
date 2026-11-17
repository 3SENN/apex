/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react'
import type { BookmarkEditorProps } from '@shared/overlay/address'
import { folderList, isBookmarkableUrl, locate, type BookmarkLink, type BookmarkRemoval, type BookmarkTree } from '@shared/bookmarks'
import { FolderPlus, Star } from 'lucide-react'
import { call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The bookmark editor (SH-48), anchored to the pill's star. ⌘D and
// the star add the page first and open this to edit its name, address and
// folder, with an inline new folder. Remove shows a removed state with
// Undo. Enter saves, Esc closes, and a failed save shows inline.

export function BookmarkEditor({ props, resolve, close }: SurfaceComponentProps<BookmarkEditorProps>): ReactElement {
  const t = useT()
  const ids = { name: useId(), url: useId(), folder: useId(), newFolder: useId(), error: useId() }
  const nameField = useRef<HTMLInputElement>(null)
  const [tree, setTree] = useState<BookmarkTree | null>(null)
  const [link, setLink] = useState<BookmarkLink | null>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [parentId, setParentId] = useState('bar')
  const [adding, setAdding] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removal, setRemoval] = useState<BookmarkRemoval | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call('bookmarks', 'tree').then((next) => {
      setTree(next)
      const found = locate(next, props.id)
      if (found?.item.kind !== 'bookmark') {
        setError(t('address.editor.saveFailed', { error: t('address.bookmarks.empty') }))
        return
      }
      setLink(found.item)
      setTitle(found.item.title)
      setUrl(found.item.url)
      setParentId(found.parent?.id ?? 'bar')
      requestAnimationFrame(() => {
        nameField.current?.focus()
        nameField.current?.select()
      })
    }, (err: unknown) => setError(errorText(err)))
  }, [props.id])

  const folders = tree ? folderList(tree) : []

  const save = async (): Promise<void> => {
    if (!link || busy) return
    const nextUrl = url.trim()
    if (!isBookmarkableUrl(nextUrl)) {
      setError(t('address.editor.badUrl'))
      return
    }
    setBusy(true)
    try {
      let target = parentId
      if (adding && folderName.trim()) {
        const folder = await call('bookmarks', 'createFolder', parentId, folderName.trim())
        target = folder.id
      }
      await call('bookmarks', 'update', link.id, { title: title.trim() || nextUrl, url: nextUrl, parentId: target })
      resolve({ kind: 'saved' })
    } catch (err) {
      setError(t('address.editor.saveFailed', { error: errorText(err) }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!link) return
    try {
      setRemoval(await call('bookmarks', 'removeItem', link.id))
    } catch (err) {
      setError(t('address.editor.saveFailed', { error: errorText(err) }))
    }
  }

  const undo = async (): Promise<void> => {
    if (!removal) return
    try {
      await call('bookmarks', 'restore', removal)
      setRemoval(null)
      requestAnimationFrame(() => nameField.current?.focus())
    } catch (err) {
      setError(t('address.editor.saveFailed', { error: errorText(err) }))
    }
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    void save()
  }

  if (removal) {
    return (
      <div className="be be--removed" role="dialog" aria-label={t('address.editor.removed')} onKeyDown={onKeyDown}>
        <p className="be__removed" role="status">
          {t('address.editor.removed')}
        </p>
        <div className="be__actions">
          <Button size="sm" variant="secondary" onClick={() => void undo()} data-autofocus>
            {t('address.editor.undo')}
          </Button>
          <Button size="sm" variant="primary" onClick={close}>
            {t('address.editor.save')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="be" role="dialog" aria-label={props.created ? t('address.editor.added') : t('address.editor.edit')} onKeyDown={onKeyDown} onSubmit={onSubmit}>
      <h2 className="be__title">
        <Star size={14} aria-hidden className="be__star" />
        {props.created ? t('address.editor.added') : t('address.editor.edit')}
      </h2>
      <label className="be__label" htmlFor={ids.name}>
        {t('address.editor.name')}
      </label>
      <input ref={nameField} id={ids.name} className="be__input" value={title} maxLength={1024} onChange={(e) => setTitle(e.target.value)} data-autofocus />
      <label className="be__label" htmlFor={ids.url}>
        {t('address.editor.url')}
      </label>
      <input
        id={ids.url}
        className="be__input"
        value={url}
        maxLength={8192}
        spellCheck={false}
        aria-invalid={error === t('address.editor.badUrl') || undefined}
        aria-describedby={error ? ids.error : undefined}
        onChange={(e) => {
          setUrl(e.target.value)
          setError(null)
        }}
      />
      <label className="be__label" htmlFor={ids.folder}>
        {t('address.editor.folder')}
      </label>
      <div className="be__folder">
        <select id={ids.folder} className="be__select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {`${' '.repeat(f.depth)}${f.id === 'bar' ? t('address.bookmarks.bar') : f.id === 'other' ? t('address.bookmarks.other') : f.title}`}
            </option>
          ))}
        </select>
        <button type="button" className="be__new" aria-expanded={adding} aria-controls={ids.newFolder} title={t('address.editor.newFolder')} aria-label={t('address.editor.newFolder')} onClick={() => setAdding((a) => !a)}>
          <FolderPlus size={15} aria-hidden />
        </button>
      </div>
      {adding && (
        <input
          id={ids.newFolder}
          className="be__input"
          value={folderName}
          maxLength={1024}
          placeholder={t('address.editor.newFolderPlaceholder')}
          aria-label={t('address.editor.newFolder')}
          autoFocus
          onChange={(e) => setFolderName(e.target.value)}
        />
      )}
      {error && (
        <p id={ids.error} className="be__error" role="alert">
          {error}
        </p>
      )}
      <div className="be__actions">
        <Button size="sm" variant="danger" onClick={() => void remove()} disabled={!link}>
          {t('address.editor.remove')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!link} loading={busy}>
          {t('address.editor.save')}
        </Button>
      </div>
    </form>
  )
}
