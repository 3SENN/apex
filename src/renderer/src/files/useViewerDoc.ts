/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryFileRef, ViewerDoc, ViewerTarget } from '@shared/files'
import { t } from '@shared/i18n/core'
import { apex, call, errorText } from '../api'

// Opens one viewer target and keeps its document current (OV-32).
// The token belongs to `owner` (the viewer tab) and is released when the
// target changes or the view unmounts; quick look and the chat files modal
// pass no owner, so their tokens end on release. A report still being
// written reopens as Library › Files reports it growing, until it's ready.

export interface ViewerDocHandle {
  doc: ViewerDoc | null
  /** Why the target couldn't be opened at all (refused, malformed, unavailable). */
  error: string | null
  /** The viewer refused the path (outside Apex's folders, or a local file not granted). */
  refused: boolean
  loading: boolean
  reload(): Promise<void>
  /** A save, rename or other call returned a newer document. */
  setDoc(doc: ViewerDoc): void
}

const REFUSED = new Set(['files.error.refused', 'files.error.localRefused', 'files.error.invalidPath'].map((k) => t(k as Parameters<typeof t>[0])))
/** Sources with no change event (meeting transcripts) are polled while they are still being written. */
const WRITING_POLL_MS = 3000

function release(token: string): void {
  void call('viewer', 'release', token).catch(() => undefined)
}

export function useViewerDoc(target: ViewerTarget | null, owner?: string): ViewerDocHandle {
  const key = target ? JSON.stringify(target) : ''
  const [doc, setDocState] = useState<ViewerDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(target !== null)
  const token = useRef<string | null>(null)
  const latest = useRef(doc)
  latest.current = doc
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!target) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const next = await call('viewer', 'open', target, owner)
      if (mine !== seq.current) {
        release(next.token)
        return
      }
      const previous = token.current
      token.current = next.token
      setDocState(next)
      setError(null)
      if (previous && previous !== next.token) release(previous)
    } catch (err) {
      if (mine !== seq.current) return
      setError(errorText(err))
      setDocState(null)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [key, owner])

  useEffect(() => {
    setDocState(null)
    setError(null)
    void load()
    return () => {
      seq.current++
      if (token.current) release(token.current)
      token.current = null
    }
  }, [load])

  // Library files: follow the store's change event (a report growing, a rename elsewhere, a delete).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = apex.onAppEvent((event) => {
      if (event.type !== 'library-files') return
      const current = latest.current
      if (!current?.libraryId) return
      const item: LibraryFileRef | undefined = event.items.find((f) => f.id === current.libraryId)
      const changed = !item || item.size !== current.size || item.name !== current.name || (item.state === 'writing') !== (current.state === 'writing') || (item.state === 'failed') !== (current.state === 'error')
      if (!changed || timer) return
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 200)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  // Other sources still being written (a meeting transcript): poll until ready.
  const writing = doc?.state === 'writing' && !doc.libraryId
  useEffect(() => {
    if (!writing) return
    const timer = setInterval(() => void load(), WRITING_POLL_MS)
    return () => clearInterval(timer)
  }, [writing, load])

  const setDoc = useCallback((next: ViewerDoc) => {
    token.current = next.token
    setDocState(next)
  }, [])

  return { doc, error, refused: error !== null && REFUSED.has(error), loading, reload: load, setDoc }
}
