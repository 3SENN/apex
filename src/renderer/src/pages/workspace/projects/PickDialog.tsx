/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A multi-select picker for a project's "Add chats" and "Add files": a
// search field, a checkable list (loading, error, nothing to add) and Add.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useT } from '../../../i18n/useT'
import { Button, Dialog, ErrorState, SkeletonRows } from '../../../ui'
import { SearchBox } from '../../../workspace/kit'
import { toggled } from '../../../workspace/logic'

export interface PickItem {
  id: string
  label: string
  detail?: ReactNode
  icon?: ReactNode
}

export interface PickDialogProps {
  title: string
  /** The items for a query; null while loading. */
  load(query: string): Promise<PickItem[]>
  onAdd(ids: string[]): Promise<void>
  onClose(): void
}

export function PickDialog({ title, load, onAdd, onClose }: PickDialogProps): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PickItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  // Picked items stay known while a new search hides them.
  const seen = useRef(new Map<string, PickItem>())

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      setError(null)
      load(query.trim())
        .then((next) => {
          if (!live) return
          for (const item of next) seen.current.set(item.id, item)
          setItems(next)
        })
        .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, attempt])

  const add = async (): Promise<void> => {
    if (picked.size === 0 || adding) return
    setAdding(true)
    try {
      await onAdd([...picked])
      onClose()
    } catch {
      setAdding(false)
    }
  }

  let list: ReactElement
  if (error) list = <ErrorState compact title={t('workspace.loadError')} message={error} onRetry={() => setAttempt((n) => n + 1)} />
  else if (!items) list = <SkeletonRows rows={5} />
  else if (items.length === 0) list = <p className="ws-muted">{t('workspace.projects.pickNone')}</p>
  else
    list = (
      <div className="ws-pick" role="group" aria-label={title}>
        {items.map((item) => (
          <label key={item.id}>
            <input type="checkbox" checked={picked.has(item.id)} onChange={() => setPicked((s) => toggled(s, item.id))} />
            {item.icon}
            <span className="ws-pick__label">{item.label}</span>
            {item.detail && <span className="ws-pick__detail">{item.detail}</span>}
          </label>
        ))}
      </div>
    )

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="md"
      initialFocus={search}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('workspace.editor.cancel')}
          </Button>
          <Button variant="primary" disabled={picked.size === 0} loading={adding} onClick={() => void add()}>
            {picked.size > 0 ? `${t('workspace.projects.add')} (${picked.size})` : t('workspace.projects.add')}
          </Button>
        </>
      }
    >
      <SearchBox ref={search} value={query} onChange={setQuery} placeholder={t('workspace.projects.pickSearch')} />
      {list}
    </Dialog>
  )
}
