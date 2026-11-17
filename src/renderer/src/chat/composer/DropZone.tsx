/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { FilePlus2 } from 'lucide-react'
import { t } from '@shared/i18n/core'
import { cx } from '../../ui'
import type { ComposerHandle } from '../Composer'
import { draftAttachments } from '../attachments/drafts'
import { carriesFiles, dragDepth } from '../logic/drop'
import { chatUrl } from '@shared/url'
import { apex, call, errorText } from '../../api'
import { toast } from '../../ui'
import { setDraftText } from '../surfaces'
import { pasteAction } from '../logic/paste'
import { addFiles, addSource, type DroppedFile } from './store'
import './composer.css'

// Dropping files on the chat (CH-23): the chat page, the side panel
// and the new tab's composer show one overlay while files are dragged over
// them, counted across nested dragenter and dragleave so it never flickers,
// and every dropped file goes to the intake. Text and links aren't files;
// the composer handles those itself. ChatIntakeScope also hands reply cards
// the surface's composer (DS-63's next steps write into it).

const NO_COMPOSER: RefObject<ComposerHandle | null> = { current: null }

export const ComposerContext = createContext<RefObject<ComposerHandle | null>>(NO_COMPOSER)

/** The composer of the chat surface a card sits in. */
export function useComposerHandle(): RefObject<ComposerHandle | null> {
  return useContext(ComposerContext)
}

/** The files a drop carries, with folders marked (Finder can drag those in too). */
export function droppedFiles(data: DataTransfer): DroppedFile[] {
  const items = [...data.items].filter((i) => i.kind === 'file')
  if (items.length > 0) {
    return items.flatMap((item) => {
      const file = item.getAsFile()
      if (!file) return []
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      return [{ file, directory: entry?.isDirectory === true }]
    })
  }
  return [...data.files].map((file) => ({ file }))
}

/**
 * Follows file drags over `target` and returns whether they are over it.
 * Dropped files go to `onFiles`; anything else is left alone.
 */
export function useFileDrop(target: RefObject<HTMLElement | null>, onFiles: ((files: DroppedFile[]) => void) | null): boolean {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const latest = useRef(onFiles)
  latest.current = onFiles

  useEffect(() => {
    const el = target.current
    if (!el || !onFiles) return
    const files = (e: DragEvent): boolean => carriesFiles([...(e.dataTransfer?.types ?? [])])
    const set = (next: number): void => {
      depth.current = next
      setOver(next > 0)
    }
    const onEnter = (e: DragEvent): void => {
      if (!files(e)) return
      e.preventDefault()
      set(dragDepth(depth.current, 'enter'))
    }
    const onOver = (e: DragEvent): void => {
      if (!files(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent): void => {
      if (!files(e)) return
      set(dragDepth(depth.current, 'leave'))
    }
    const onDrop = (e: DragEvent): void => {
      if (!files(e) || !e.dataTransfer) return
      e.preventDefault()
      e.stopPropagation()
      set(dragDepth(depth.current, 'drop'))
      const dropped = droppedFiles(e.dataTransfer)
      if (dropped.length > 0) latest.current?.(dropped)
    }
    // A drag that ends anywhere (Esc, a drop outside) resets the count.
    const onEnd = (): void => set(dragDepth(depth.current, 'end'))
    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onEnd)
    window.addEventListener('drop', onEnd)
    return () => {
      el.removeEventListener('dragenter', onEnter)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('drop', onEnd)
    }
  }, [target, onFiles === null])

  return over
}

/** The overlay itself: a dashed, tinted card over the drop target. */
export function DropOverlay({ shown, className }: { shown: boolean; className?: string }): ReactElement | null {
  if (!shown) return null
  return (
    <div className={cx('cmp-drop', className)} aria-hidden="true">
      <div className="cmp-drop__card">
        <FilePlus2 className="cmp-drop__icon" />
        <p className="cmp-drop__title">{t('composer.drop.title')}</p>
        <p className="cmp-drop__detail">{t('composer.drop.detail')}</p>
      </div>
      <p className="ui-sr-only" role="status">{t('composer.drop.title')}</p>
    </div>
  )
}

export interface ChatIntakeScopeProps {
  chatId: string
  /** The chat view's section: the drop target (page or panel). */
  root: RefObject<HTMLElement | null>
  composer: RefObject<ComposerHandle | null>
  /** Drops attach only once the chat has loaded. */
  enabled: boolean
  children: ReactNode
}

export function ChatIntakeScope({ chatId, root, composer, enabled, children }: ChatIntakeScopeProps): ReactElement {
  const over = useFileDrop(root, enabled ? (files) => void addFiles(chatId, files, draftAttachments(chatId).length) : null)
  return (
    <ComposerContext.Provider value={composer}>
      {children}
      <DropOverlay shown={over} />
    </ComposerContext.Provider>
  )
}

/**
 * The new tab's ask field takes files too (CH-23, CH-24): a drop
 * or a pasted image or long text opens a fresh chat with this companion in
 * the tab, carrying what was typed and the attachments, so the person sends
 * from the chat's own composer once the chips are ready.
 */
export function useStartIntake(input: { tabId: string; companionId: string | null; text: string; target: RefObject<HTMLElement | null>; onHandoff?(): void }): boolean {
  const busy = useRef(false)
  const latest = useRef(input)
  latest.current = input
  const handoff = async (attach: (chatId: string) => Promise<unknown>): Promise<void> => {
    const { tabId, companionId, text, onHandoff } = latest.current
    if (busy.current || !companionId) return
    busy.current = true
    try {
      const draft = await call('chats', 'create', { companionId })
      if (text.trim()) setDraftText(draft.id, text)
      onHandoff?.()
      await apex.nav.go(tabId, chatUrl(draft.id))
      await attach(draft.id)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      busy.current = false
    }
  }
  const over = useFileDrop(input.target, input.companionId ? (files) => void handoff((id) => addFiles(id, files)) : null)
  // The ask field's pastes bubble up to the form, so the composer itself needs no change.
  useEffect(() => {
    const el = input.target.current
    if (!el) return
    const onPaste = (e: ClipboardEvent): void => {
      const data = e.clipboardData
      if (!data || !latest.current.companionId) return
      const files = [...data.files]
      const pasted = data.getData('text/plain')
      const action = pasteAction({ text: pasted, files: files.length, images: files.filter((f) => f.type.startsWith('image/')).length })
      if (action === 'default') return
      e.preventDefault()
      if (action === 'files') void handoff((id) => addFiles(id, files.map((file) => ({ file, ...(file.name ? {} : { name: t('composer.paste.imageName') }) }))))
      else void handoff((id) => addSource(id, { type: 'paste', text: pasted }))
    }
    el.addEventListener('paste', onPaste)
    return () => el.removeEventListener('paste', onPaste)
  }, [input.target])
  return over
}
