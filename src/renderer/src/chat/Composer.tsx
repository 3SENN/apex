/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { SUGGESTION_DRAFT_EVENT, type SuggestionDraftDetail } from '../suggestions/suggestionData'
import { ArrowUp, Check, ChevronDown, ListEnd, Mic, Square } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import type { Companion, QueuedMessage } from '@shared/services'
import { apex, call, errorText } from '../api'
import { signalPresence } from '../companion/presence'
import { Button, Spinner, cx, toast, useConfirm, useMotion } from '../ui'
import { showPopoverMenu } from '../ui/Popover'
import { caretPoint } from './caret'
import { glideComposerIn } from './handoff'
import { CompanionAvatar } from './CompanionAvatar'
import { useSkills } from './hooks'
import { CHAT_MODELS, EFFORTS, composerHeight, composerHint, composerState, effortLabel, fitsOneLine, matchSkills, modelLabel, primaryButton, primaryLabel, skillQuery, toggleStep, voiceUnavailable } from './logic/composer'
import { chatState, markSent, patchChat, reloadChat, type ChatState } from './store'
import { draftText, loadDraft, setDraftText, surfaceName, type Driving } from './surfaces'
// MV-07, DS-59, CH-06, MV-14
import { t as tStatic, useT } from '../i18n/useT'
import { draftAttachments, restoreDraftAttachments, takeDraftAttachments, useDraftAttachments } from './attachments/drafts'
import { cancelHold, holdIfWaiting, useHeldSend } from './attachments/holds'
import { DictationBar } from './dictation/DictationBar'
import { insertDictation, micSlot, voiceInput } from './dictation/logic'
import { useDictation } from './dictation/useDictation'
import { QuoteChip } from './QuoteChip'
import { clearQuote, messageWithQuote, useQuote } from './quoteInbox'
// CH-15 queue, CH-16 interrupt, CH-17 stop, CH-18 mode, CH-38 tray drafts
import { ModeToggle, setActWithoutAsking } from './ModeToggle'
import { QueueList } from './QueueList'
import { RequestTray, useHandoffs, useTrayEntries } from './RequestTray'
import { leftQueue } from './logic/status'
import { PICK_MODEL_EVENT } from './logic/errors'
// CH-21 to CH-25, CH-08, OV-20, DS-125
import type { MessageAttachmentInput } from '@shared/chats'
import { t as tCore } from '@shared/i18n/core'
import { blockingMeetings } from './attachments/waiting'
import { meetingStatus } from '../meetings/status'
import { AddMenu } from './composer/AddMenu'
import { DocumentsBadge, IntakeChips } from './composer/Chips'
import { PasteDialog } from './composer/PastePreview'
import { chipAdvanced, chipMenuItems, setChipAdvanced } from './composer/chipMenu'
import { addSource, draftIntake, restoreAfterSend, takeForSend } from './composer/store'
import { useIntake } from './composer/useIntake'
import { hostLabel } from './logic/intake'

export interface ComposerHandle {
  focus(): void
  /** Shows text as a ghost hint in the composer (a hovered suggestion); null clears it. */
  preview(text: string | null): void
  /** Puts text into the draft and focuses the field. */
  insert(text: string): void
  /** Adds or removes a suggested step in the draft (DS-63). */
  toggleStep(step: string): void
  /** Starts dictation into the draft (DS-63's Answer by voice). */
  dictate(): void
}

export interface ComposerProps {
  chatId: string
  state: ChatState
  companion: Companion | null | undefined
  /** Visible companions, for the chip's menu. */
  companions: readonly Companion[]
  name: string
  /** Whether the chat can send: an API key, or an engine with its own sign-in (ST-58). */
  hasApiKey: boolean
  driving: Driving
  /** The empty panel's hint is about the page beside it. */
  surface: 'page' | 'panel'
  /** ↑ in an empty composer: edit your latest message. Returns false when there is none. */
  onEditLatest(): boolean
  /** Continue with another companion in a new chat (a started chat's companion is fixed). */
  onSwitchCompanion(companionId: string, text: string): void
  /** Continue with another model in a new chat, carrying `text` (an error card's Use another model on a started chat). */
  onSwitchModel?(model: string, text: string): void
  /** Opens another chat in this surface (continue in a new chat with a connector). */
  onOpenChat?(chatId: string): void
  onFocusChange?(focused: boolean): void
  /** The caret's place on screen while you type (null when the field loses focus). */
  onCaret?(point: { x: number; y: number } | null): void
  /** Slots for the + menu and the mic button, filled by the features that own them. */
  slots?: { attach?: ReactNode; mic?: ReactNode }
  className?: string
}

const MIN_HEIGHT = 48
const MAX_HEIGHT = 240
/** Roughly what fits between + and the buttons in the single-row composer. */
const COMPACT_CHARS = 56


export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { chatId, state, companion, companions, name, hasApiKey, driving, surface, onEditLatest, onSwitchCompanion, onSwitchModel, onOpenChat, onFocusChange, onCaret, slots, className },
  ref,
): ReactElement {
  const t = useT()
  const [text, setTextState] = useState(() => draftText(chatId))
  const [editingQueued, setEditingQueued] = useState<QueuedMessage | null>(null)
  const [skillIndex, setSkillIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [ghost, setGhost] = useState<string | null>(null)
  const stash = useRef('')
  const field = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  /** Whether presence was last told there is text, so leaving can say it is gone. */
  const typing = useRef(false)
  const ask = useConfirm()
  const skills = useSkills()
  const { reduced, durations } = useMotion()
  const dictation = useDictation((words) => void insertWords(words))
  const attached = useDraftAttachments(chatId)
  const held = useHeldSend(chatId)
  const hasMeeting = attached.some((d) => d.attachment.kind === 'meeting')

  const running = state.log.status !== 'idle'
  // SS-09: a chat showing a migration notice is read-only.
  const locked = Boolean(state.notice)
  const setup = state.setup
  const companionId = setup?.companionId ?? companion?.id ?? ''
  const empty = state.log.items.length === 0
  const hint = ghost ?? composerHint(composerState({ hasApiKey, empty, running, editingQueued: editingQueued !== null, surface, meeting: hasMeeting }), name)
  // CH-38: one tray for every request: approvals and hand-offs, and the cards other features register.
  const handoffs = useHandoffs(chatId)
  const trayItems = useTrayEntries(chatId, state.log.items, handoffs)
  const docked = trayItems.length > 0
  // CH-15: a queued message that went out while you edited it waits here for Discard or Send as new.
  const [gone, setGone] = useState<string | null>(null)
  const compact = docked && !editingQueued && fitsOneLine(text, COMPACT_CHARS)
  // The chips, @ and # lists, pastes and page drags; Send waits for every chip (CH-22).
  const intake = useIntake({
    chatId,
    text,
    setText: (next) => {
      setText(next)
      typed(next)
    },
    field,
    companions,
    companionId,
    setup,
    enabled: !locked && !editingQueued,
    onSwitchCompanion,
    ...(onOpenChat ? { onOpenChat } : {}),
  })
  // An error card's Use another model opens the model list here, at the chip (or the box when the chip is folded away).
  const chip = useRef<HTMLButtonElement | null>(null)
  const openChipRef = useRef<(anchor: Element, options?: { models?: boolean }) => Promise<void>>(async () => undefined)
  useEffect(() => {
    const onPick = (event: Event): void => {
      if ((event as CustomEvent<{ chatId?: string }>).detail?.chatId !== chatId) return
      const anchor = chip.current ?? box.current ?? field.current
      if (anchor) void openChipRef.current(anchor, { models: true })
    }
    window.addEventListener(PICK_MODEL_EVENT, onPick)
    return () => window.removeEventListener(PICK_MODEL_EVENT, onPick)
  }, [chatId])
  const sendHint = hasApiKey ? intake.gate.hint : null
  // OV-20: the panel's quoted selection becomes a selection chip with its source link.
  const quote = useQuote(surface === 'panel')
  useEffect(() => {
    if (!quote || !/^https?:/.test(quote.url) || !quote.text.trim()) return
    const title = hostLabel(quote.url)
    void addSource(chatId, { type: 'selection', text: quote.text.slice(0, 200_000), url: quote.url, title, ...(quote.links.length ? { links: quote.links.slice(0, 50).map((url) => ({ text: url, url })) } : {}) }).then((ref) => {
      if (ref) clearQuote()
    })
  }, [quote, chatId])
  const primary = primaryButton({ hasText: text.trim() !== '', canSend: hasApiKey, attachmentsReady: intake.gate.canSend, running, sending, editingQueued: editingQueued !== null, voice: voiceInput(dictation.state, dictation.available), waiting: held !== null })
  // Why the voice button is off: no speech helper, or no way to send.
  const voiceTip = !dictation.available ? tStatic('meetings.dictation.error.unavailable') : voiceUnavailable('idle', hasApiKey)

  // Each chat keeps its own unsent text.
  useEffect(() => {
    setTextState(draftText(chatId))
    setEditingQueued(null)
    setGhost(null)
    setGone(null)
    // The draft saved in main (a reload, another window) fills an untouched composer.
    let live = true
    void loadDraft(chatId).then((saved) => {
      if (live && saved) setTextState((current) => current || saved)
    })
    return () => {
      live = false
    }
  }, [chatId])

  // A draft that leaves with the view puts the companion back at rest.
  useEffect(() => () => {
    if (!typing.current) return
    typing.current = false
    signalPresence('idle', companionId || null, chatId)
  }, [chatId, companionId])

  // Listening holds while the composer has text (DS-69), not just while keys are pressed.
  const typed = (value: string): void => {
    typing.current = value.trim() !== ''
    signalPresence(typing.current ? 'typing' : 'idle', companionId || null, chatId)
  }

  const reportCaret = (): void => {
    const el = field.current
    if (el && onCaret && document.activeElement === el) onCaret(caretPoint(el))
  }

  const setText = (next: string): void => {
    setTextState(next)
    if (!editingQueued) setDraftText(chatId, next)
  }

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${composerHeight(el.scrollHeight, compact ? 24 : MIN_HEIGHT, MAX_HEIGHT)}px`
  }, [text, compact, hint])

  // A site suggestion drafted into this chat lands here when the composer is on screen.
  const setTextRef = useRef(setText)
  setTextRef.current = setText
  useEffect(() => {
    const onDraft = (e: Event): void => {
      const detail = (e as CustomEvent<SuggestionDraftDetail>).detail
      if (!detail || detail.chatId !== chatId || editingQueued) return
      e.preventDefault()
      setTextRef.current(detail.text)
      requestAnimationFrame(() => field.current?.focus())
    }
    window.addEventListener(SUGGESTION_DRAFT_EVENT, onDraft)
    return () => window.removeEventListener(SUGGESTION_DRAFT_EVENT, onDraft)
  }, [chatId, editingQueued])

  // DS-74: a chat sent from the new tab's ask field glides in from there.
  useLayoutEffect(() => {
    if (box.current) glideComposerIn(chatId, box.current)
  }, [chatId])

  // DS-62: the box glides between its two-row and single-row shapes.
  const lastHeight = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const next = el.getBoundingClientRect().height
    const before = lastHeight.current
    lastHeight.current = next
    if (before === null || reduced || Math.abs(before - next) < 1) return
    el.animate([{ height: `${before}px` }, { height: `${next}px` }], { duration: durations.glide, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
  }, [compact])

  // A queued message that went out while you edited it: keep the edit and offer Discard or Send as new (CH-15).
  useEffect(() => {
    if (!editingQueued || !leftQueue(state.queued, editingQueued.id)) return
    const edited = text.trim()
    const lost = editingQueued
    setEditingQueued(null)
    setTextState(stash.current)
    setDraftText(chatId, stash.current)
    if (edited && edited !== lost.text) setGone(edited)
  }, [state.queued, editingQueued, chatId, text])

  const sendGone = (): void => {
    const message = gone
    setGone(null)
    if (!message) return
    driving.claim()
    void apex.agent.send(chatId, message).catch((err: unknown) => {
      setGone(message)
      toast.show({ message: errorText(err), tone: 'error' })
    })
  }

  const cancelEdit = (): void => {
    setEditingQueued(null)
    setTextState(stash.current)
    setDraftText(chatId, stash.current)
  }

  // CH-16: ⌘↩ while working stops at the next safe point and sends this now.
  const interrupt = async (): Promise<void> => {
    const message = text.trim()
    if (!message || !hasApiKey || locked || editingQueued) return
    // A message with chips goes through the queue, which carries attachments.
    if (draftAttachments(chatId).length > 0 || draftIntake(chatId).items.length > 0) {
      void send()
      return
    }
    driving.claim()
    const outgoing = messageWithQuote(surface === 'panel', message)
    setText('')
    typing.current = false
    signalPresence('sent', companionId || null, chatId)
    try {
      await call('chats', 'interrupt', chatId, outgoing)
      if (outgoing !== message) clearQuote()
    } catch (err) {
      setText(message)
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    preview: (next) => setGhost(next && !text ? next : null),
    insert: (next) => {
      setGhost(null)
      setText(next)
      requestAnimationFrame(() => {
        const el = field.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    },
    toggleStep: (step) => {
      setGhost(null)
      setText(toggleStep(text, step))
    },
    dictate: () => void dictation.start(),
  }))

  const query = editingQueued ? null : skillQuery(text)
  const matches = useMemo(() => (query === null ? null : matchSkills(skills, query, companionId)), [query, skills, companionId])
  const skillList = matches?.all ?? []

  const send = async (override?: string /* The draft with dictated words */): Promise<void> => {
    const message = (override ?? text).trim()
    if (!message || !hasApiKey || sending || locked) return
    if (editingQueued) {
      await saveQueued(message)
      return
    }
    // CH-22: Send waits until every chip is ready.
    if (!intake.gate.canSend) {
      if (intake.gate.hint) toast.show({ message: intake.gate.hint })
      return
    }
    const meetingsWaiting = blockingMeetings(draftAttachments(chatId).map((d) => d.attachment), meetingStatus).length > 0
    const takenAttachments = meetingsWaiting ? null : takeForSend(chatId)
    if (meetingsWaiting && draftIntake(chatId).items.length > 0) {
      // A held send carries meeting and screenshot chips only, so a message with other attachments waits for the transcript here instead.
      toast.show({ message: tCore('composer.chip.waiting') })
      return
    }
    driving.claim()
    // The chips go with the message; one with an unfinished meeting is held until it is ready (MV-14).
    const items = takeDraftAttachments(chatId)
    if (items.length > 0 && holdIfWaiting(chatId, message, items)) {
      setText('')
      typing.current = false
      signalPresence('idle', companionId || null, chatId)
      return
    }
    const attachments: MessageAttachmentInput[] = [...items.map((d) => d.attachment), ...(takenAttachments?.attachments ?? [])]
    const outgoing = messageWithQuote(surface === 'panel', message) // A quoted selection goes ahead of your words (OV-20)
    setSending(true)
    setText('')
    typing.current = false
    signalPresence('sent', companionId || null, chatId)
    // The pending line shows within a frame, before main confirms the run.
    if (!running) markSent(chatId)
    try {
      await apex.agent.send(chatId, outgoing, attachments.length > 0 ? attachments : undefined)
      if (outgoing !== message) clearQuote()
    } catch (err) {
      markSent(chatId, false)
      restoreDraftAttachments(chatId, items)
      if (takenAttachments) restoreAfterSend(chatId, takenAttachments.ids)
      setText(message)
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setSending(false)
    }
  }

  const saveQueued = async (message: string | null): Promise<void> => {
    const item = editingQueued
    if (!item) return
    try {
      const queued = await call('chats', 'editQueued', chatId, item.id, message)
      patchChat(chatId, { queued })
      setEditingQueued(null)
      setTextState(stash.current)
      setDraftText(chatId, stash.current)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const editQueued = (item: QueuedMessage): void => {
    if (!editingQueued) stash.current = text
    setEditingQueued(item)
    setTextState(item.text)
    requestAnimationFrame(() => field.current?.focus())
  }

  // Dictated words land at the caret; "send what you said" sends the draft with them.
  const insertWords = (words: string): string => {
    const el = field.current
    const current = el?.value ?? text
    const next = insertDictation(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, words)
    setText(next.text)
    typed(next.text)
    requestAnimationFrame(() => {
      const f = field.current
      if (!f) return
      f.focus()
      f.setSelectionRange(next.caret, next.caret)
    })
    return next.text
  }
  const stopDictation = (): void => {
    void dictation.stop().then((words) => {
      if (words) insertWords(words)
    })
  }
  const sendTranscript = (): void => {
    void dictation.stop().then((words) => void send(words ? insertWords(words) : undefined))
  }
  const cancelHeld = (): void => {
    if (cancelHold(chatId)) setTextState(draftText(chatId))
  }

  const stop = async (): Promise<void> => {
    driving.claim()
    const unsent = await apex.agent.stop(chatId)
    // Messages that never went out come back to the composer.
    if (unsent.length > 0) setText([text.trim(), ...unsent].filter(Boolean).join('\n\n'))
  }

  const openChip = async (anchor: Element, options: { models?: boolean } = {}): Promise<void> => {
    // CH-07, DS-125: the in-window popover with a companion search, faces, preset rows and the switch row.
    const fixed = setup?.fixed ?? false
    const summary = state.summary
    const act = summary && !summary.imported ? (summary.actWithoutAsking ?? false) : null
    const items = chipMenuItems({ companions, companionId, setup, advanced: chipAdvanced(), act, ...(options.models ? { models: true } : {}) })
    let reopen = false
    const picked = await showPopoverMenu(items, anchor, {
      label: tCore('composer.chipMenu.label'),
      side: 'above',
      gap: 12,
      align: 'end',
      width: 280,
      rowHeight: 40,
      ...(options.models ? {} : { search: { placeholder: tCore('composer.chipMenu.search') } }),
      onToggle: (id, next) => {
        // DS-125: the chat's act-without-asking mode is a switch row here (CH-18).
        if (id === 'act' && summary) void setActWithoutAsking(chatId, chatState(chatId)?.summary ?? summary, next)
        if (id !== 'advanced') return
        setChipAdvanced(next)
        reopen = true
      },
    })
    if (reopen && !picked) {
      void openChip(anchor)
      return
    }
    if (!picked) return
    if (picked === 'manage') {
      void call('pages', 'open', 'apex://settings/companions')
      return
    }
    const [kind, value = ''] = picked.split(/:(.*)/s)
    try {
      if (kind === 'companion') {
        if (value === companionId) return
        if (!fixed) {
          await call('chats', 'configure', chatId, { companionId: value })
          reloadChat(chatId)
          return
        }
        const next = companions.find((c) => c.id === value)
        const ok = await ask({
          title: t('chat.composer.continueWithInA', { value: next?.name ?? 'this companion' }),
          message: t('chat.composer.aChatKeepsThe', { value: next?.name ?? 'they' }),
          confirmLabel: t('chat.composer.startNewChat'),
        })
        if (ok) {
          onSwitchCompanion(value, text)
          setText('')
        }
      } else if (kind === 'model') {
        if (value === setup?.model) return
        if (fixed) {
          // A started chat keeps its model: carry on in a new chat with the message that failed (or what you typed).
          const lastSent = [...state.log.items].reverse().find((item) => item.kind === 'user')
          onSwitchModel?.(value, text.trim() || (lastSent?.kind === 'user' ? lastSent.text : ''))
          setText('')
          return
        }
        await call('chats', 'configure', chatId, { model: value })
        reloadChat(chatId)
      } else if (kind === 'effort') {
        await call('chats', 'configure', chatId, { effort: value as (typeof EFFORTS)[number]['id'] })
        reloadChat(chatId)
      }
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  openChipRef.current = openChip

  const mirror = !driving.driving && driving.elsewhere !== null

  // CH-38: the tray draws approvals and hand-offs, and the registered cards.
  const tray = <RequestTray chatId={chatId} items={state.log.items} companion={companion} name={name} driving={driving} handoffs={handoffs} />

  if (mirror && driving.elsewhere) {
    return (
      <div className={cx('chat-composer', className)}>
        {tray}
        <div className="chat-composer--mirror">
          <p>{t('chat.composer.isWorkingFromThis', { name, value: surfaceName(driving.elsewhere) })}</p>
          <Button size="sm" onClick={driving.claim}>{t('chat.composer.continueHere')}</Button>
        </div>
      </div>
    )
  }

  const primaryIcon = (() => {
    switch (primary.action) {
      case 'voice':
        return <Mic />
      case 'stop':
        return <Square />
      case 'queue':
        return <ListEnd />
      case 'save':
        return <Check />
      case 'sending':
      case 'busy':
        return <Spinner size={14} />
      default:
        return <ArrowUp />
    }
  })()

  const onPrimary = (): void => {
    if (primary.action === 'voice') void dictation.start()
    else if (primary.action === 'send-transcript') sendTranscript()
    else if (primary.action === 'stop') void stop()
    else if (primary.action === 'send' || primary.action === 'queue' || primary.action === 'save') void send()
  }

  return (
    <div className={cx('chat-composer', className)}>
      {/* CH-15: the queue, and an edit whose message already went out. */}
      <QueueList chatId={chatId} queued={state.queued} editingId={editingQueued?.id ?? null} running={running} onEdit={editQueued} onAct={driving.claim} />
      {gone && (
        <div className="chat-composer__note chat-composer__note--gone" role="status">
          <span>{tStatic('chat.queue.gone')}</span>
          <Button size="sm" variant="ghost" onClick={() => setGone(null)}>{tStatic('chat.queue.discard')}</Button>
          <Button size="sm" onClick={sendGone}>{tStatic('chat.queue.sendAsNew')}</Button>
        </div>
      )}
      {skillList.length > 0 && matches && (
        <ul className="chat-skills" role="listbox" id={`skills-${chatId}`} aria-label={t('chat.composer.skills')}>
          {skillList.map((skill, i) => {
            const shared = skill.owner === SHARED_OWNER
            const groupStart = i === 0 || shared !== (skillList[i - 1]?.owner === SHARED_OWNER)
            return (
              <li key={skill.id} role="presentation">
                {groupStart && <div className="chat-skills__group" aria-hidden="true">{shared ? t('chat.composer.sharedSkills') : `${name}’s skills`}</div>}
                <div
                  role="option"
                  id={`skill-${skill.id}`}
                  aria-selected={i === skillIndex}
                  className="chat-skills__option"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setText(`/${skill.name} `)
                  }}
                  onMouseEnter={() => setSkillIndex(i)}
                >
                  <strong>/{skill.name}</strong>
                  {skill.description && <small>{skill.description}</small>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {state.log.interrupting && <p className="chat-composer__note" role="status">{tStatic('chat.status.interrupting')}</p> /* CH-16 */}
      {editingQueued && (
        <div className="chat-composer__note" role="status">
          <span>{tStatic('chat.queue.editing')}</span>
          <Button size="sm" variant="ghost" onClick={cancelEdit}>{tStatic('chat.queue.cancel')}</Button>
          <Button size="sm" onClick={() => void send()}>{tStatic('chat.queue.save')}</Button>
        </div>
      )}
      {tray}
      {/* Meeting and screenshot chips, the waiting chip, and dictation's status line */}
      {/* One shared chip row for meetings, screenshots and other attachments (CH-22, MV-14) */}
      <IntakeChips chatId={chatId} gate={hasApiKey ? intake.gate : { canSend: true, hint: null }} onOpenPaste={intake.openPaste} onCancelHold={cancelHeld} />
      <DictationBar dictation={dictation} onStop={stopDictation} />
      {/* The @ mention and # record lists (CH-25, CH-08) */}
      {skillList.length === 0 && intake.list}
      <PasteDialog open={intake.pasteFallback} onDone={intake.closePasteFallback} />
      <DocumentsBadge on={setup?.documents ?? false} name={name} /* CH-22 */ />
      <QuoteChip enabled={surface === 'panel'} /* OV-20 */ />
      <div
        ref={box}
        className={cx('chat-composer__box', editingQueued && 'chat-composer__box--editing', compact && 'chat-composer__box--compact', docked && 'chat-composer__box--docked', ghost && 'chat-composer__box--ghost')}
        onMouseDown={(e) => {
          // Clicking the box's padding still puts you in the field.
          if (e.target === e.currentTarget) {
            e.preventDefault()
            field.current?.focus()
          }
        }}
      >
        <textarea
          ref={field}
          className="chat-composer__field"
          value={text}
          placeholder={locked ? tStatic('migrations.composer.locked') : hint}
          disabled={locked}
          aria-label={composerHint(composerState({ hasApiKey, empty, running, editingQueued: editingQueued !== null, surface, meeting: hasMeeting }), name)}
          rows={1}
          role={skillList.length > 0 ? 'combobox' : intake.combo?.role}
          aria-expanded={skillList.length > 0 ? true : intake.combo?.['aria-expanded']}
          aria-controls={skillList.length > 0 ? `skills-${chatId}` : intake.combo?.['aria-controls']}
          aria-activedescendant={skillList.length > 0 && skillList[skillIndex] ? `skill-${skillList[skillIndex].id}` : intake.combo?.['aria-activedescendant']}
          onPaste={intake.onPaste /* CH-24 */}
          onDragOver={intake.onDragOver}
          onDrop={intake.onDrop}
          onFocus={() => {
            onFocusChange?.(true)
            if (text) typed(text)
          }}
          onBlur={() => {
            onFocusChange?.(false)
            onCaret?.(null)
            typing.current = false
            signalPresence('idle', companionId || null, chatId)
          }}
          onSelect={() => {
            reportCaret()
            intake.onCaret()
          }}
          onChange={(e) => {
            setText(e.target.value)
            intake.onCaret()
            setSkillIndex(0)
            setGhost(null)
            typed(e.target.value)
            reportCaret()
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (skillList.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSkillIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : skillList.length - 1)) % skillList.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                const pick = skillList[skillIndex]
                if (pick) setText(`/${pick.name} `)
                return
              }
            }
            if (skillList.length === 0 && intake.onKeyDown(e)) return // The @ and # lists
            if (e.key === 'Escape' && editingQueued) {
              e.preventDefault()
              cancelEdit()
              return
            }
            // CH-17: Esc in the composer stops a run (dictation's own Esc comes first).
            if (e.key === 'Escape' && running && dictation.state !== 'listening') {
              e.preventDefault()
              void stop()
              return
            }
            // CH-16: ⌘↩ sends now, interrupting the run at its next safe point.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && running && !editingQueued) {
              e.preventDefault()
              void interrupt()
              return
            }
            if (e.key === 'ArrowUp' && text === '' && !running && onEditLatest()) {
              e.preventDefault()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // Enter while listening sends what you said, like the primary button.
              if (dictation.state === 'listening') sendTranscript()
              else void send()
            }
          }}
        />
        <div className="chat-composer__add">
          {slots?.attach ?? (
            // CH-21, DS-126: the add-context menu.
            <AddMenu
              chatId={chatId}
              companionId={companionId}
              name={name}
              disabled={locked || editingQueued !== null}
              onInsert={(next) => {
                setText(next)
                requestAnimationFrame(() => field.current?.focus())
              }}
              onConnector={intake.chooseConnector}
            />
          )}
        </div>
        <div className="chat-composer__controls">
          {/* DS-125: no shield at rest; the mode is a switch row in the chip's menu, and this badge shows only while it is on. */}
          <ModeToggle chatId={chatId} summary={state.summary} name={name} compact /* CH-18 */ />
          {!compact && (
            <button ref={chip} type="button" className={cx('chat-chip', empty && 'chat-chip--start')} aria-haspopup="menu" title={setup ? `${companion?.name ?? name} · ${modelLabel(setup.model)} · ${effortLabel(setup.effort)} effort` : t('chat.composer.companionModelAndEffort')} onClick={(e) => void openChip(e.currentTarget)}>
              {/* DS-125: the start variant (an empty chat) shows no face and a short label. */}
              {!empty && <CompanionAvatar companion={companion} size={24} label="" />}
              <span className="chat-chip__name">{companion?.name ?? name}</span>
              {setup && !setup.fixed && surface === 'page' && !empty && <span className="chat-chip__meta">{modelLabel(setup.model)} · {effortLabel(setup.effort)}</span>}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          )}
          {slots?.mic && primary.mic !== 'hidden' && <div className={cx('chat-composer__slot', `chat-composer__slot--${primary.mic}`)} data-slot="mic">{slots.mic}</div>}
          {/* DS-59: with text, the mic steps aside into a secondary circle (disabled until voice ships). */}
          {/* The secondary is the mic while there is text, and Stop while recording. */}
          {!slots?.mic && micSlot(primary) === 'mic' && (
            <button type="button" className="chat-secondary chat-voice" aria-label={tStatic('meetings.dictation.dictate')} title={voiceTip ?? tStatic('meetings.dictation.dictate')} disabled={voiceTip !== null} onClick={() => void dictation.start()}>
              <Mic aria-hidden="true" />
            </button>
          )}
          {!slots?.mic && micSlot(primary) === 'stop' && (
            <button type="button" className="chat-secondary chat-voice chat-voice--stop" aria-label={tStatic('meetings.dictation.stop')} title={tStatic('meetings.dictation.stopHint')} onClick={stopDictation}>
              <Square aria-hidden="true" />
            </button>
          )}
          {editingQueued && <Button size="sm" variant="ghost" onClick={() => void saveQueued(null)}>{t('chat.composer.remove')}</Button>}
          <button
            type="button"
            className={cx('chat-primary', `chat-primary--${primary.action}`)}
            aria-label={primaryLabel(primary.action, name)}
            title={(primary.action === 'voice' && primary.disabled ? voiceTip : null) ?? (primary.disabled && (primary.action === 'send' || primary.action === 'queue') ? sendHint : null) ?? (primary.action === 'queue' ? `${primaryLabel(primary.action, name)} · ${tStatic('chat.interrupt.hint')}` : primary.action === 'stop' ? tStatic('chat.stop.hint') : null) /* CH-16, CH-17 */ ?? primaryLabel(primary.action, name)}
            disabled={primary.disabled || locked}
            onClick={onPrimary}
          >
            {primaryIcon}
          </button>
        </div>
      </div>
    </div>
  )
})
