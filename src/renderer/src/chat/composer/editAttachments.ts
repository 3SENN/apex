/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { attachmentsReady, type AttachmentRef, type RefAttachment } from '@shared/attachments'
import { editedAttachments } from '../logic/intake'
import { allRefs, claim, pickFiles, removeAttachment, useDraftIntake } from './store'

// Editing a sent message's attachments (CH-09). The inline editor
// shows the message's chips, each removable, and can add files through the
// chat's intake; those refs are claimed so the composer below doesn't show
// them too. Save hands editAndResend the new set, or nothing at all when the
// set is unchanged (main then keeps the original attachments).

export interface EditAttachments {
  items: AttachmentRef[]
  ready: boolean
  remove(id: string): void
  add(): void
  /** The attachments argument for editAndResend. */
  result(): RefAttachment[] | undefined
  /** Saved: main took the added refs. */
  done(): void
  /** Cancelled: the added refs go away. */
  cancel(): void
}

export function useEditAttachments(chatId: string, original: readonly AttachmentRef[] | undefined, editing: boolean): EditAttachments {
  const base = original ?? []
  const [kept, setKept] = useState<string[]>(() => base.map((a) => a.id))
  const [added, setAdded] = useState<string[]>([])
  const addedRef = useRef(added)
  addedRef.current = added
  useDraftIntake(editing ? chatId : null) // re-renders as the added refs prepare

  useEffect(() => {
    if (!editing) return
    setKept(base.map((a) => a.id))
    setAdded([])
    // Leaving the editor without saving drops what it added.
    return () => {
      const ids = addedRef.current
      if (ids.length === 0) return
      claim(chatId, ids, false)
      for (const id of ids) removeAttachment(chatId, id)
    }
  }, [editing, chatId])

  const live = editing ? allRefs(chatId).filter((a) => added.includes(a.id)) : []
  const items = [...base.filter((a) => kept.includes(a.id)), ...live]
  return {
    items,
    ready: attachmentsReady(live),
    remove: (id) => {
      if (added.includes(id)) {
        claim(chatId, [id], false)
        removeAttachment(chatId, id)
        setAdded((ids) => ids.filter((x) => x !== id))
      } else setKept((ids) => ids.filter((x) => x !== id))
    },
    add: () => {
      void pickFiles(chatId).then((refs) => {
        if (refs.length === 0) return
        const ids = refs.map((r) => r.id)
        claim(chatId, ids, true)
        setAdded((prev) => [...prev, ...ids])
      })
    },
    result: () => editedAttachments(base, kept, added),
    done: () => {
      // They stay claimed (hidden from the composer) until main's next event moves them onto the message.
      addedRef.current = []
      setAdded([])
    },
    cancel: () => {
      const ids = addedRef.current
      claim(chatId, ids, false)
      for (const id of ids) removeAttachment(chatId, id)
      addedRef.current = []
      setAdded([])
    },
  }
}
