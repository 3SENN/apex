/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import type { ChatSetup } from '@shared/chats'
import type { ConnectorRecordHit } from '@shared/connectors'
import { t } from '@shared/i18n/core'
import type { Companion, Connector } from '@shared/services'
import { call, errorText } from '../../api'
import { openSurface, anchorFromElement } from '../../overlay/useSurface'
import { toast, useConfirm } from '../../ui'
import { draftAttachments, useDraftAttachments } from '../attachments/drafts'
import { useChatList, useTabs } from '../hooks'
import { intakeGate, hostLabel, type Gate } from '../logic/intake'
import { cycleFilter, filterMentions, listKey, mentionToken, orphanedTokens, recordQuery, replaceTrigger, triggerAt, type MentionCandidate, type MentionFilter, type Trigger } from '../logic/mentions'
import { pageDragSource } from '../logic/drop'
import { pasteAction, putBack } from '../logic/paste'
import { reloadChat } from '../store'
import { setDraftText } from '../surfaces'
import { useConnectorList, webTabs } from './data'
import { MentionList, RecordList, optionId } from './MentionList'
import type { PasteResult } from './PastePreview'
import { addFiles, addSource, forget, removeAttachment, setToken, tokensOf, useDraftIntake } from './store'

// The composer's intake (CH-22 to CH-25, CH-08's #): the @ and #
// lists that open at the caret, long pastes and clipboard images, text and
// pictures dragged in from the page, mention tokens that drop their chip when
// typed away, and the gate that holds Send while a chip is still preparing.
// The composer keeps focus in its field the whole time; the lists follow
// the combobox pattern (aria-activedescendant).

/** # waits this long after the last key before it asks the connectors. */
export const RECORD_DEBOUNCE_MS = 200
const RECORD_HITS_MAX = 8

export interface IntakeOptions {
  chatId: string
  text: string
  setText(next: string, caret?: number): void
  field: RefObject<HTMLTextAreaElement | null>
  companions: readonly Companion[]
  companionId: string
  setup: ChatSetup | null
  /** Whether the composer takes input at all (a locked or mirrored chat doesn't). */
  enabled: boolean
  onSwitchCompanion(companionId: string, text: string): void
  /** Opens another chat in this surface (continue in a new chat). */
  onOpenChat?(chatId: string): void
}

export interface Intake {
  gate: Gate
  /** The @ or # list to draw above the field, or null. */
  list: ReactElement | null
  /** Combobox attributes for the field while a list shows. */
  combo: { role: 'combobox'; 'aria-expanded': true; 'aria-controls': string; 'aria-activedescendant'?: string } | null
  /** Handles the key when a list is open; true when it was used. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void
  onDragOver(e: DragEvent<HTMLTextAreaElement>): void
  onDrop(e: DragEvent<HTMLTextAreaElement>): void
  /** The caret moved or the text changed. */
  onCaret(): void
  /** A connector picked from the + menu acts like mentioning it. */
  chooseConnector(connector: Connector): void
  /** A paste chip was clicked. */
  openPaste(id: string, el: HTMLElement): void
  /** The in-window paste preview, while the overlay host isn't there. */
  pasteFallback: { chatId: string; attachmentId: string } | null
  closePasteFallback(result: PasteResult | null): void
}

function mentionCandidates(input: {
  tabs: ReturnType<typeof webTabs>
  chats: ReturnType<typeof useChatList>
  companions: readonly Companion[]
  connectors: readonly Connector[] | null
  chatId: string
  companionId: string
}): MentionCandidate[] {
  const names = new Map(input.companions.map((c) => [c.id, c.name]))
  const out: MentionCandidate[] = []
  for (const tab of input.tabs) out.push({ kind: 'tab', id: tab.id, label: tab.title || hostLabel(tab.url), detail: hostLabel(tab.url), icon: tab.favicon })
  for (const chat of input.chats ?? []) {
    if (chat.id === input.chatId || chat.draft || chat.archived) continue
    out.push({ kind: 'chat', id: chat.id, label: chat.title || t('composer.mention.untitled'), ...(names.has(chat.companionId) ? { detail: names.get(chat.companionId) ?? '' } : {}) })
  }
  for (const c of input.companions) if (c.id !== input.companionId) out.push({ kind: 'companion', id: c.id, label: c.name })
  for (const c of input.connectors ?? []) out.push({ kind: 'connector', id: c.id, label: c.name })
  return out
}

export function useIntake({ chatId, text, setText, field, companions, companionId, setup, enabled, onSwitchCompanion, onOpenChat }: IntakeOptions): Intake {
  const listId = useId()
  const ask = useConfirm()
  const intake = useDraftIntake(chatId)
  const draftItems = useDraftAttachments(chatId)
  const tabs = useTabs()
  const chats = useChatList()
  const connectors = useConnectorList(companionId)
  const [caret, setCaret] = useState<number | null>(null)
  const [filter, setFilter] = useState<MentionFilter>('all')
  const [active, setActive] = useState(0)
  /** The trigger the person closed with Esc; it stays closed until the caret leaves that word. */
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [hits, setHits] = useState<ConnectorRecordHit[]>([])
  const [pasteFallback, setPasteFallback] = useState<{ chatId: string; attachmentId: string } | null>(null)

  const raw = enabled && caret !== null ? triggerAt(text, caret) : null
  const trigger: Trigger | null = raw && raw.start !== dismissed ? raw : null
  const mentionOpen = trigger?.char === '@'
  const records = recordQuery(trigger)

  // Leaving the word forgets the Esc.
  useEffect(() => {
    if (dismissed !== null && raw?.start !== dismissed) setDismissed(null)
  }, [raw?.start, dismissed])

  const all = useMemo(
    () => (mentionOpen ? mentionCandidates({ tabs: webTabs(tabs.tabs), chats, companions, connectors, chatId, companionId }) : []),
    [mentionOpen, tabs.tabs, chats, companions, connectors, chatId, companionId],
  )
  const items = useMemo(() => (mentionOpen && trigger ? filterMentions(all, filter, trigger.query) : []), [mentionOpen, all, filter, trigger?.query])
  const anyOfFilter = filter === 'all' ? all.length > 0 : all.some((c) => c.kind === filter)

  // # asks the searchable connectors, 200 ms after the last key; a newer query (or closing) drops the older answer.
  const searchIds = useMemo(() => (connectors ?? []).filter((c) => (c as { searchable?: boolean }).searchable !== false).map((c) => c.id), [connectors])
  const searchKey = searchIds.join(',')
  useEffect(() => {
    if (records === null || searchIds.length === 0) {
      setHits([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      call('connectors', 'search', records, searchIds).then(
        (found) => {
          if (live) setHits(found.slice(0, RECORD_HITS_MAX))
        },
        () => {
          if (live) setHits([])
        },
      )
    }, RECORD_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [records, searchKey])

  useEffect(() => setActive(0), [trigger?.start, trigger?.char, filter, items.length, hits.length])

  // A mention token typed or cut away takes its chip with it.
  useEffect(() => {
    for (const id of orphanedTokens(text, tokensOf(chatId))) removeAttachment(chatId, id)
  }, [text, chatId])

  const recordOpen = records !== null && hits.length > 0
  const count = mentionOpen ? items.length : recordOpen ? hits.length : 0

  const place = (next: { text: string; caret: number }): void => {
    setText(next.text, next.caret)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      const el = field.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  const insertToken = (at: Trigger, token: string): void => place(replaceTrigger(text, at, token))

  const attachToken = async (at: Trigger, label: string, source: Parameters<typeof addSource>[1]): Promise<void> => {
    const token = mentionToken(label)
    insertToken(at, token)
    const ref = await addSource(chatId, source)
    if (ref) setToken(chatId, ref.id, token)
  }

  const connectorChosen = async (connector: Connector, at: Trigger | null): Promise<void> => {
    const inChat = setup ? setup.connectorIds.includes(connector.id) : true
    const token = mentionToken(connector.name)
    if (inChat || !setup?.fixed) {
      // The token in the message is the hint: the agent reads "@Name" as "use Name".
      if (at) insertToken(at, token)
      else place({ text: text && !text.endsWith(' ') ? `${text} ${token} ` : `${text}${token} `, caret: text.length + token.length + (text && !text.endsWith(' ') ? 2 : 1) })
      if (!inChat) {
        const companion = companions.find((c) => c.id === companionId)?.name ?? ''
        toast.show({ message: t('composer.mention.connectorOff', { name: connector.name, companion }), action: { label: t('composer.mention.openConnectors'), onAction: () => void call('pages', 'open', 'apex://settings/connectors') } })
      }
      return
    }
    const rest = at ? replaceTrigger(text, at, '') : { text, caret: text.length }
    const ok = await ask({
      title: t('composer.mention.connectorTitle', { name: connector.name }),
      message: t('composer.mention.connectorMessage', { name: connector.name }),
      confirmLabel: t('composer.mention.connectorConfirm'),
    })
    if (!ok) return
    try {
      const next = await call('chats', 'continueInNewChat', chatId, { connectorIds: [connector.id] })
      if (rest.text.trim()) setDraftText(next.id, rest.text)
      place({ text: '', caret: 0 })
      onOpenChat?.(next.id)
      toast.show({ message: t('composer.mention.continued', { name: connector.name }) })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const pickMention = (index: number): void => {
    const item = items[index]
    if (!item || !trigger) return
    const at = trigger
    switch (item.kind) {
      case 'tab':
        void attachToken(at, item.label, { type: 'tab', tabId: item.id })
        return
      case 'chat':
        void attachToken(at, item.label, { type: 'chat', chatId: item.id })
        return
      case 'companion': {
        const rest = replaceTrigger(text, at, '')
        place(rest)
        if (!setup?.fixed) {
          void call('chats', 'configure', chatId, { companionId: item.id }).then(
            () => {
              reloadChat(chatId)
              toast.show({ message: t('composer.mention.companionSet', { name: item.label }) })
            },
            (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }),
          )
          return
        }
        void ask({
          title: t('composer.mention.switchTitle', { name: item.label }),
          message: t('composer.mention.switchMessage', { name: item.label }),
          confirmLabel: t('composer.mention.switchConfirm'),
        }).then((ok) => {
          if (!ok) return
          onSwitchCompanion(item.id, rest.text)
          place({ text: '', caret: 0 })
        })
        return
      }
      case 'connector': {
        const connector = connectors?.find((c) => c.id === item.id)
        if (connector) void connectorChosen(connector, at)
        return
      }
    }
  }

  const pickRecord = (index: number): void => {
    const hit = hits[index]
    if (!hit || !trigger) return
    place(replaceTrigger(text, trigger, ''))
    setHits([])
    void addSource(chatId, { type: 'connector-record', connectorId: hit.connectorId, uri: hit.uri, title: hit.title.slice(0, 1024) || hit.uri })
  }

  const connectorName = (id: string): string => connectors?.find((c) => c.id === id)?.name ?? ''

  const list = mentionOpen ? (
    <MentionList
      id={listId}
      items={items}
      any={anyOfFilter}
      filter={filter}
      query={trigger?.query ?? ''}
      active={active}
      companions={companions}
      onFilter={(f) => {
        setFilter(f)
        field.current?.focus()
      }}
      onActive={setActive}
      onPick={pickMention}
    />
  ) : recordOpen ? (
    <RecordList id={listId} hits={hits} connectorName={connectorName} active={active} onActive={setActive} onPick={pickRecord} />
  ) : null

  const combo = list
    ? { role: 'combobox' as const, 'aria-expanded': true as const, 'aria-controls': listId, ...(count > 0 ? { 'aria-activedescendant': optionId(listId, active) } : {}) }
    : null

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!list || e.nativeEvent.isComposing) return false
    const key = listKey(e.key, e.shiftKey, count, active, mentionOpen)
    if (!key) return false
    e.preventDefault()
    switch (key.type) {
      case 'move':
        setActive(key.active)
        break
      case 'pick':
        if (mentionOpen) pickMention(key.index)
        else pickRecord(key.index)
        break
      case 'filter':
        setFilter((f) => cycleFilter(f, key.direction))
        break
      case 'close':
        if (trigger) setDismissed(trigger.start)
        setHits([])
        break
    }
    return true
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!enabled) return
    const data = e.clipboardData
    const files = [...data.files]
    const pasted = data.getData('text/plain')
    const action = pasteAction({ text: pasted, files: files.length, images: files.filter((f) => f.type.startsWith('image/')).length })
    if (action === 'files') {
      e.preventDefault()
      void addFiles(chatId, files.map((file) => ({ file, ...(file.name ? {} : { name: t('composer.paste.imageName') }) })), draftAttachments(chatId).length)
    } else if (action === 'long-text') {
      e.preventDefault()
      void addSource(chatId, { type: 'paste', text: pasted })
    }
  }

  const activePage = (): { tabId: string; url: string; title: string } | null => {
    const tab = tabs.tabs.find((x) => x.id === tabs.activeId)
    return tab ? { tabId: tab.id, url: tab.url, title: tab.title } : null
  }

  const onDragOver = (e: DragEvent<HTMLTextAreaElement>): void => {
    if (!enabled || [...e.dataTransfer.types].includes('Files')) return
    if (e.dataTransfer.types.includes('text/html') || e.dataTransfer.types.includes('text/uri-list')) e.dataTransfer.dropEffect = 'copy'
  }

  const onDrop = (e: DragEvent<HTMLTextAreaElement>): void => {
    if (!enabled || [...e.dataTransfer.types].includes('Files')) return
    const source = pageDragSource({ uriList: e.dataTransfer.getData('text/uri-list'), html: e.dataTransfer.getData('text/html'), text: e.dataTransfer.getData('text/plain') }, activePage())
    if (!source) return
    e.preventDefault()
    void addSource(chatId, source)
  }

  const onCaret = (): void => {
    const el = field.current
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const finishPaste = (id: string, result: PasteResult | null): void => {
    if (!result) return
    if (result.action === 'removed') forget(chatId, id)
    else if (result.action === 'put-back') {
      const el = field.current
      place(putBack(text, el?.selectionStart ?? text.length, result.text))
      removeAttachment(chatId, id)
    }
  }

  const openPaste = (id: string, el: HTMLElement): void => {
    openSurface('paste-preview', anchorFromElement(el), { chatId, attachmentId: id }).then(
      (r) => finishPaste(id, 'value' in r ? (r.value as PasteResult) : null),
      // No overlay host (yet): the same preview as an in-window dialog.
      () => setPasteFallback({ chatId, attachmentId: id }),
    )
  }

  return {
    gate: intakeGate(intake.items, draftItems.length),
    list,
    combo,
    onKeyDown,
    onPaste,
    onDragOver,
    onDrop,
    onCaret,
    chooseConnector: (connector) => void connectorChosen(connector, null),
    openPaste,
    pasteFallback,
    closePasteFallback: (result) => {
      const open = pasteFallback
      setPasteFallback(null)
      if (open) finishPaste(open.attachmentId, result)
    },
  }
}
