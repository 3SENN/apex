/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type WheelEvent } from 'react'
import { ArrowDown, Brain, Check, Copy, Ellipsis, Pencil, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { CompanionMood } from '@shared/companion'
import { memoryLocation, type ChatFeedback, type FeedbackRating } from '@shared/chats'
import type { MenuItemSpec } from '@shared/menu'
import type { Companion } from '@shared/services'
import type { LogItem } from '../agentLog'
import { call, errorText } from '../api'
import { useShell } from '../components/shellContext'
import { Button, IconButton, StatusDot, cx, formatAbsolute, menuSeparator, showMenu, toast, useConfirm, useMotion } from '../ui'
import { copyText } from './actions'
import { CompanionAvatar } from './CompanionAvatar'
import { flyInto, takeHandoff } from './handoff'
import { MarkdownBlocks, useMarkdownBlocks } from './Markdown'
import { effortLabel, modelLabel } from './logic/composer'
import { countMarkdownWords, type Block } from './logic/markdown'
import { closingAsk, type ClosingAsk } from './logic/askBlock'
import { chatBlocks, cutDiscards, replyDetails, replyFeedback, type ChatBlock, type UserItem } from './logic/replies'
import { STICK_THRESHOLD, edgeFades, formatTimer, formatTokens, formatWorked, isNearBottom, isStopNotice, isUpwardIntent, jumpBehavior, mentionsApiKey, shouldFollow } from './logic/view'
import { replyParts } from './logic/work'
import { loadOlder, patchChat, revealRecord, saveScroll, savedScroll, type ChatState } from './store'
import type { Driving } from './surfaces'
import { logCardFor } from './cards/registry'
// CH-26, CH-27, CH-09, SS-03
import './cards/registerReplyCards'
import { CompactAction } from './cards/ReplyCards'
import { EditChips, SentChips } from './composer/Chips'
import { useEditAttachments } from './composer/editAttachments'
import { t as tCore } from '@shared/i18n/core'
// Sent chips; CH-11 dictated rating note
import { SentAttachments } from './attachments/SentAttachments'
import { DictateButton } from './dictation/DictateButton'
import { insertDictation } from './dictation/logic'
import { t as tStatic, useT, t } from '../i18n/useT'
// CH-13 paging and anchors, CH-14, CH-17, CH-19, CH-20, SS-03
import { AnchorMissing, ErrorCard, OlderBar, StepLimitCard, StoppedMark, useOnline } from './ChatCards'
import { Reasoning, WorkFold, useSecondTick } from './WorkTrace'
import { anchorStep, keepPosition, nearTop } from './logic/anchor'
import { activityStatus } from './logic/status'
// SK-04 skill chip, CH-29 tips, CH-37 find targets
import { SkillChip } from './SkillChip'
import { WorkingTip } from './WorkingTip'
import { stripSkillCommand } from './logic/skillChip'
import './register' // the request and log cards, chat sounds and find
import { TurnQuestion } from './TurnQuestion' // DS-63's question block

export interface ChatLogProps {
  chatId: string
  state: ChatState
  companion: Companion | null | undefined
  name: string
  /** The chat's live mood, shown on the newest reply's face. */
  mood: CompanionMood
  driving: Driving
  /** The message of yours open in the inline editor. */
  editingId: string | null
  onEditingChange(id: string | null): void
  /** Shown when the chat has no messages yet. */
  empty: ReactNode
  /** Above the messages (the panel's API-key notice, for example). */
  lead?: ReactNode
  /** CH-13: a message to scroll to and highlight (atelier://chat/<id>#<message>). */
  anchor?: string | null
  /** SS-03's New chat action (a chat too long to go on). */
  onNewChat?(): void
}

/** The conversation: your messages, replies with their faces and footers, and the reading position. */
export function ChatLog({ chatId, state, companion, name, mood, driving, editingId, onEditingChange, empty, lead, anchor = null, onNewChat }: ChatLogProps): ReactElement {
  const blocks = chatBlocks(state.log.items)
  const running = state.log.status !== 'idle'
  const waiting = running || state.sentAt !== null
  const hasMessages = blocks.length > 0 || state.sentAt !== null
  const scroll = useReadingPosition(chatId, state.log, hasMessages)
  // Sending a message brings you back to the newest output.
  const sent = state.log.items.reduce((n, item) => (item.kind === 'user' ? n + 1 : n), 0)
  const lastSent = useRef(sent)
  useLayoutEffect(() => {
    if (sent > lastSent.current) scroll.jump()
    lastSent.current = sent
  }, [sent])
  useLayoutEffect(() => {
    if (state.sentAt !== null) scroll.jump()
  }, [state.sentAt])

  const lastReply = [...blocks].reverse().find((b) => b.kind === 'reply')
  // Until the first output arrives, one pending line says the companion has the message.
  const pending = waiting && (blocks.length === 0 || blocks[blocks.length - 1]?.kind === 'user')
  const firstReplyKey = blocks.find((b) => b.kind === 'reply')?.key ?? null
  const online = useOnline()
  const { reduced } = useMotion()

  // Scrolling near the top loads the page before, keeping your place.
  const canOlder = (state.logStart ?? 0) > 0
  const olderFrom = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const loadEarlier = (): void => {
    const el = scroll.scroller.current
    if (!el || state.olderLoading || !canOlder) return
    olderFrom.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
    void loadOlder(chatId).then((loaded) => {
      if (!loaded) olderFrom.current = null
    })
  }
  useLayoutEffect(() => {
    const el = scroll.scroller.current
    const before = olderFrom.current
    if (!el || !before) return
    olderFrom.current = null
    el.scrollTop = keepPosition(before, el.scrollHeight)
  }, [state.log])

  // Scroll to the message and highlight it; page back until it turns up.
  const [anchorPhase, setAnchorPhase] = useState<'pending' | 'done' | 'missing'>(anchor ? 'pending' : 'done')
  useEffect(() => setAnchorPhase(anchor ? 'pending' : 'done'), [anchor, chatId])
  useEffect(() => {
    if (!anchor || anchorPhase !== 'pending' || state.phase !== 'ready') return
    const step = anchorStep({ items: state.log.items, id: anchor, logStart: state.logStart ?? 0, loading: Boolean(state.olderLoading), failed: Boolean(state.olderError) })
    if (step === 'load-older') void loadOlder(chatId)
    else if (step === 'missing') setAnchorPhase('missing')
    else if (step === 'found') {
      setAnchorPhase('done')
      requestAnimationFrame(() => {
        const box = scroll.scroller.current
        const id = CSS.escape(anchor)
        const el = box?.querySelector<HTMLElement>(`[data-message-id="${id}"], [data-turn-ids~="${id}"]`)
        if (!el) return
        scroll.hold()
        el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
        el.tabIndex = -1
        el.focus({ preventScroll: true })
        el.classList.add('chat-anchor-hit')
        setTimeout(() => el.classList.remove('chat-anchor-hit'), 2400)
      })
    }
  }, [anchor, anchorPhase, state.log, state.logStart, state.olderLoading, state.olderError, state.phase, chatId])

  return (
    <div className={cx('chat-log', scroll.fades.top && 'chat-log--fade-top')}>
      {anchorPhase === 'missing' && <AnchorMissing onNewest={scroll.jump} onClose={() => setAnchorPhase('done')} /* CH-13 */ />}
      <div
        className="chat-log__scroller"
        ref={scroll.scroller}
        onScroll={() => {
          scroll.onScroll()
          // CH-13: near the top, the page before loads.
          const el = scroll.scroller.current
          if (el && canOlder && !state.olderLoading && !state.olderError && nearTop(el.scrollTop) && el.scrollHeight > el.clientHeight) loadEarlier()
        }}
        onWheel={scroll.onWheel}
        onKeyDown={scroll.onKeyDown}
      >
        <div className="chat-log__content" ref={scroll.content}>
          {lead}
          {canOlder && <OlderBar loading={Boolean(state.olderLoading)} error={state.olderError} onLoad={loadEarlier} /* CH-13 */ />}
          {!hasMessages ? empty : blocks.map((block) =>
            block.kind === 'user' ? (
              <UserMessage
                key={`user:${block.item.id}`}
                chatId={chatId}
                item={block.item}
                items={state.log.items}
                name={name}
                running={running}
                editable={!state.summary?.draft}
                editing={editingId === block.item.id}
                onEditingChange={(on) => onEditingChange(on ? block.item.id : null)}
                onAct={driving.claim}
              />
            ) : (
              <Reply
                key={block.key}
                chatId={chatId}
                block={block}
                state={state}
                companion={companion}
                name={name}
                running={running}
                driving={driving}
                mood={block === lastReply ? mood : undefined}
                handoff={block.key === firstReplyKey}
                online={online}
                onNewChat={onNewChat}
              />
            ),
          )}
          {pending && <PendingReply chatId={chatId} state={state} companion={companion} name={name} mood={mood} handoff={firstReplyKey === null} />}
        </div>
      </div>
      {scroll.away && (
        // DS-61: a 36 px circle with a down arrow; its name is for screen readers.
        <button type="button" className="chat-log__jump" onClick={scroll.jump} aria-label={scroll.fresh ? `${tStatic('chat.anchor.newest')}${tStatic('chat.jump.fresh')}` : tStatic('chat.anchor.newest')}>
          <ArrowDown size={18} aria-hidden="true" />
          {scroll.fresh && <span className="chat-log__jump-dot" aria-hidden="true" />}
        </button>
      )}
    </div>
  )
}

/**
 * DS-61: follows new output while you read at the bottom. Any upward intent
 * (wheel up, ↑, Page Up, Home, ⇧Space) lets go at once, and a short grace
 * period keeps it from sticking again straight away. Where a view leaves the
 * chat is remembered, so the next view (the page after expand) picks up there.
 */
function useReadingPosition(chatId: string, log: unknown, hasMessages: boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const releasedAt = useRef(0)
  const jumping = useRef(0)
  const fromBottom = useRef<number | null>(null)
  const { reduced } = useMotion()
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const hasRef = useRef(hasMessages)
  hasRef.current = hasMessages

  const measure = (): void => {
    const el = scroller.current
    if (!el) return
    const next = edgeFades(el, hasRef.current)
    setFades((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    fromBottom.current = following.current || gap <= STICK_THRESHOLD ? null : gap
  }

  const toBottom = (): void => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const release = (): void => {
    following.current = false
    releasedAt.current = performance.now()
    jumping.current = 0
  }

  // Pick up where the last view of this chat left off.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const saved = savedScroll(chatId)
    if (saved !== null) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - saved)
      following.current = false
      setAway(true)
    } else {
      toBottom()
    }
    measure()
    return () => saveScroll(chatId, fromBottom.current)
  }, [chatId])

  // Content grows while a reply streams; follow it only while following.
  useEffect(() => {
    const el = content.current
    const box = scroller.current
    if (!el || !box) return
    const observer = new ResizeObserver(() => {
      if (following.current) toBottom()
      measure()
    })
    observer.observe(el)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const seen = useRef(false)
  useLayoutEffect(() => {
    if (following.current) toBottom()
    // Only output that arrives while you read further up counts as new.
    else if (seen.current) setFresh(true)
    seen.current = true
    measure()
  }, [log, hasMessages])

  return {
    scroller,
    content,
    away,
    fresh,
    fades,
    onWheel(e: WheelEvent): void {
      if (e.deltaY < 0) release()
    },
    onKeyDown(e: KeyboardEvent): void {
      // Keys typed into a field (the inline editor) aren't scroll intent.
      const target = e.target as HTMLElement
      if (target.closest('textarea, input, [contenteditable="true"]')) return
      if (isUpwardIntent(e)) release()
    },
    onScroll(): void {
      const el = scroller.current
      if (!el) return
      const now = performance.now()
      const near = isNearBottom(el)
      if (jumping.current && now < jumping.current) {
        if (near) jumping.current = 0
      } else if (following.current) {
        if (!near) following.current = false
      } else if (shouldFollow(el, releasedAt.current, now)) {
        following.current = true
      }
      setAway(!near)
      if (near) setFresh(false)
      measure()
    },
    /** CH-13: stops following so a scroll to a linked message stays put. */
    hold(): void {
      release()
      setAway(true)
    },
    jump(): void {
      const el = scroller.current
      following.current = true
      releasedAt.current = 0
      setAway(false)
      setFresh(false)
      if (!el) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const behavior = jumpBehavior(distance, reduced)
      // A smooth scroll passes through "not at the bottom"; don't let go meanwhile.
      jumping.current = behavior === 'smooth' ? performance.now() + 900 : 0
      el.scrollTo({ top: el.scrollHeight, behavior })
    },
  }
}

interface UserMessageProps {
  /** This surface takes over driving the chat. */
  onAct(): void
  chatId: string
  item: UserItem
  items: readonly LogItem[]
  name: string
  running: boolean
  editable: boolean
  editing: boolean
  onEditingChange(editing: boolean): void
}

function UserMessage({ onAct, chatId, item, items, name, running, editable, editing, onEditingChange }: UserMessageProps): ReactElement {
  const t = useT()
  const [text, setText] = useState(item.text)
  const [busy, setBusy] = useState(false)
  const ask = useConfirm()
  const field = useRef<HTMLTextAreaElement>(null)
  const attach = useEditAttachments(chatId, item.attachments, editing) // CH-09

  useEffect(() => {
    if (!editing) return
    setText(item.text)
    const el = field.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editing, item.text])

  const save = async (): Promise<void> => {
    const next = text.trim()
    if (!next || !attach.ready) return
    const attachments = attach.result() // Undefined keeps the message's attachments
    if (next === item.text.trim() && !attachments && !cutDiscards(items, item.id)) {
      onEditingChange(false)
      return
    }
    if (cutDiscards(items, item.id)) {
      const ok = await ask({
        title: t('chat.log.sendTheEditedMessage'),
        message: t('chat.log.everythingAfterThisMessage', { name }),
        confirmLabel: t('chat.log.editAndSend'),
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    onAct()
    try {
      await call('chats', 'editAndResend', chatId, item.id, next, ...(attachments ? [attachments] : []))
      attach.done()
      onEditingChange(false)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="chat-msg chat-msg--user chat-msg--editing" data-message-id={item.id}>
        <textarea
          ref={field}
          className="chat-msg__editor"
          value={text}
          aria-label={t('chat.log.editYourMessage')}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              attach.cancel()
              onEditingChange(false)
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void save()
            }
          }}
        />
        {/* CH-09: the message's attachments, each removable, plus Add files */}
        <EditChips items={attach.items} onRemove={attach.remove} />
        <div className="chat-msg__edit-actions">
          <Button size="sm" variant="ghost" className="chat-msg__edit-add" onClick={attach.add}>{tCore('composer.edit.add')}</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              attach.cancel()
              onEditingChange(false)
            }}
          >
            {t('chat.log.cancel')}
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!text.trim() || !attach.ready} onClick={() => void save()}>{t('chat.log.send')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-msg chat-msg--user" data-message-id={item.id}>
      {item.attachments && item.attachments.length > 0 && <SentAttachments items={item.attachments} />}
      {item.attachments && item.attachments.length > 0 && <SentChips items={item.attachments} /> /* Files, tabs, pastes and the rest */}
      {/* A skill message shows its chip instead of the raw /command (SK-04); data-find-id marks the text for find (CH-37). */}
      <div className="chat-msg__bubble">{item.skill && <SkillChip skill={item.skill} />}<span data-find-id={item.id}>{item.skill ? stripSkillCommand(item.text, item.skill.name) : item.text}</span></div>
      <div className="chat-msg__tools">
        <CopyButton text={item.text} label={t('chat.log.copyMessage')} />
        {editable && (
          <IconButton
            size="sm"
            label={t('chat.log.editAndResend')}
            tooltip={running ? t('chat.log.stopFirstToEdit', { name }) : undefined}
            icon={<Pencil />}
            disabled={running}
            onClick={() => onEditingChange(true)}
          />
        )}
      </div>
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): ReactElement {
  const t = useT()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(timer)
  }, [done])
  return (
    <IconButton
      size="sm"
      label={done ? t('chat.log.copied') : label}
      icon={done ? <Check /> : <Copy />}
      onClick={() => void copyText(text).then(setDone)}
    />
  )
}

// ---- the companion's face in the gutter (DS-52) ----

interface ReplyFaceProps {
  chatId: string
  companion: Companion | null | undefined
  name: string
  mood?: CompanionMood
  /** The chat's first reply: the waiting companion flies into this face (DS-73). */
  handoff?: boolean
}

function ReplyFace({ chatId, companion, name, mood, handoff = false }: ReplyFaceProps): ReactElement {
  const shell = useShell()
  const face = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!handoff || !face.current) return
    const from = takeHandoff(chatId)
    if (from) flyInto(face.current, from)
  }, [])
  // DS-52: a 28 px face with no hover name, time or motion.
  return (
    <div className="chat-reply__face" ref={face}>
      <CompanionAvatar
        companion={companion}
        size={28}
        mood={mood}
        mark={mood === 'approval' ? 'approval' : null}
        label={companion ? `${companion.name}, open profile` : name}
        {...(companion ? { onClick: () => shell.openCompanionCard(companion.id, 'general') } : {})}
      />
    </div>
  )
}

// ---- the working status (DS-54) ----

/** Ticks once a second while mounted. */
/** One muted status line with a light sweep across it and a live timer. */
function StatusLine({ text, startedAt, sweep = true }: { text: string; startedAt: number | null; sweep?: boolean }): ReactElement {
  const now = useSecondTick(startedAt !== null)
  return (
    <p className="chat-status" role="status">
      <span className={cx('chat-status__text', sweep && 'chat-sweep')} data-text={text}>{text}</span>
      {startedAt !== null && <span className="chat-status__timer"> · {formatTimer(now - startedAt)}</span>}
    </p>
  )
}

function PendingReply({ chatId, state, companion, name, mood, handoff }: { chatId: string; state: ChatState; companion: Companion | null | undefined; name: string; mood: CompanionMood; handoff: boolean }): ReactElement {
  const t = useT()
  return (
    <div className="chat-reply chat-reply--pending">
      <ReplyFace chatId={chatId} companion={companion} name={name} mood={mood} handoff={handoff} />
      <StatusLine text={t('chat.log.isOnIt', { name })} startedAt={state.runStartedAt ?? state.sentAt} />
      <WorkingTip state={state} /* CH-29 */ />
    </div>
  )
}

// ---- replies ----

interface ReplyProps {
  chatId: string
  block: Extract<ChatBlock, { kind: 'reply' }>
  state: ChatState
  companion: Companion | null | undefined
  name: string
  running: boolean
  driving: Driving
  mood?: CompanionMood
  handoff: boolean
  online: boolean
  onNewChat?(): void
}

function Reply({ chatId, block, state, companion, name, running, driving, mood, handoff, online, onNewChat }: ReplyProps): ReactElement {
  const live = block.last && running
  // DS-63: the closing question is lifted out of the text into its own block, then next steps, then the duration line and footer.
  const ask = useMemo(() => (live || state.summary?.imported ? null : closingAsk({ last: block.last, running, items: block.items })), [live, state.summary?.imported, block.last, running, block.items])
  const allParts = replyParts(block.items)
  const parts = allParts.filter((part) => part.kind !== 'item' || part.item.kind !== 'suggestions')
  const steps = allParts.filter((part) => part.kind === 'item' && part.item.kind === 'suggestions')
  const details = replyDetails(block.turnIds, state.details)
  const duration = block.userId ? state.durations[block.userId] : undefined
  // A reply that only failed (no key, network) can still be retried.
  const failed = block.items.some((item) => item.kind === 'notice' && item.tone === 'error')
  const tail = parts[parts.length - 1]
  const streaming = tail?.kind === 'item' && tail.item.kind === 'assistant' && tail.item.text.trim() !== ''
  const working = tail?.kind === 'work' && tail.running
  const startedAt = state.runStartedAt ?? state.sentAt
  // CH-20: the status line says what is happening in plain words.
  const status = live ? activityStatus({ log: state.log, name, paused: state.paused }) : null
  const newest = state.log.items[state.log.items.length - 1]
  const itemContext: ReplyItemContext = {
    name,
    running,
    online,
    driving: driving.driving || driving.elsewhere === null,
    liveErrorAt: state.liveErrorAt ?? null,
    newestId: newest ? `${newest.kind}:${newest.id}` : null,
    last: block.last,
    continuable: block.last ? continuableStepLimit(block.items) : null,
    claim: driving.claim,
    newChat: onNewChat ?? (() => undefined),
    lifted: ask,
  }
  return (
    <div className={cx('chat-reply', live && 'chat-reply--live')} data-turn-ids={block.turnIds.join(' ') || undefined}>
      <ReplyFace chatId={chatId} companion={companion} name={name} mood={mood} handoff={handoff} />
      {parts.map((part) =>
        part.kind === 'work' ? (
          <WorkFold key={part.key} part={part} name={name} live={live && part === tail} startedAt={startedAt} state={state} />
        ) : (
          <ReplyItem key={`${part.item.kind}:${part.item.id}`} chatId={chatId} item={part.item} context={itemContext} />
        ),
      )}
      {live && !streaming && !working && status && (
        status.tone !== 'working'
          ? <StatusLine text={tStatic(status.key, status.vars)} startedAt={null} sweep={false} />
          : <StatusLine text={tStatic(status.key, status.vars)} startedAt={startedAt} />
      )}
      {live && <WorkingTip state={state} /* CH-29 */ />}
      {/* DS-63: a reply that ends by asking you something offers a typed or spoken answer, as its last content block. */}
      {ask && <TurnQuestion ask={ask} state={state} companion={companion} />}
      {steps.map((part) => part.kind === 'item' && <ReplyItem key={`${part.item.kind}:${part.item.id}`} chatId={chatId} item={part.item} context={itemContext} />)}
      {!live && duration !== undefined && <p className="chat-duration">{formatWorked(duration)}</p>}
      {!live && (block.turnIds.length > 0 || (block.last && failed)) && (
        <ReplyFooter chatId={chatId} block={block} state={state} companion={companion} name={name} running={running} onAct={driving.claim} />
      )}
    </div>
  )
}

/** CH-14: the newest step-limit card, if nothing but marks came after it. */
function continuableStepLimit(items: readonly LogItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item) continue
    if (item.kind === 'step-limit') return item.id
    if (item.kind === 'partial' || item.kind === 'stopped' || item.kind === 'suggestions' || item.kind === 'memory-change') continue
    return null
  }
  return null
}

/** What the reply's cards need beyond the item (SS-03's retry, CH-14's Continue). */
interface ReplyItemContext {
  name: string
  running: boolean
  online: boolean
  /** This surface drives the chat (or nobody else does). */
  driving: boolean
  liveErrorAt: number | null
  /** `kind:id` of the chat's newest item. */
  newestId: string | null
  /** The reply is the chat's last. */
  last: boolean
  /** The step-limit item Continue can pick up: nothing ran after it. */
  continuable: string | null
  claim(): void
  newChat(): void
  /** DS-63: the closing question lifted out of one item's text. */
  lifted?: ClosingAsk | null
}

function ReplyItem({ chatId, item, context }: { chatId: string; item: LogItem; context?: ReplyItemContext }): ReactElement | null {
  // Registered cards (reply cards, request and log cards) draw their own kinds.
  const t = useT()
  const Card = logCardFor(item.kind)
  if (Card) return <Card item={item as never} chatId={chatId} />
  switch (item.kind) {
    case 'assistant':
      return (
        <div className="chat-msg chat-msg--assistant">
          {item.thinking && <Reasoning turnId={item.id} text={item.thinking} /* CH-19 */ />}
          {item.text && <AssistantText chatId={chatId} turnId={item.id} text={item.text} lifted={context?.lifted?.itemId === item.id ? context.lifted.blocks : undefined} />}
        </div>
      )
    case 'tool':
      return null
    case 'approval':
      // The request itself docks above the composer (DS-62); the log keeps a quiet record.
      return (
        <p className={cx('chat-approval-note', item.resolved === null && 'chat-approval-note--pending')}>
          {item.resolved === null ? (
            <StatusDot status="needs-input" label="" size={6} pulse={false} />
          ) : item.resolved ? (
            <Check size={13} aria-hidden="true" />
          ) : null}
          <span>
            {item.resolved === null ? t('chat.log.waitingForYourAnswer') : item.resolved ? t('chat.log.allowed') : t('chat.log.notAllowed')}
            {item.description}
          </span>
        </p>
      )
    case 'notice': {
      if (isStopNotice(item.text)) return <div className="chat-notice chat-notice--info">{t('chat.log.stopped')}</div>
      // SS-03: errors draw a card by type, with its action and, for rate limits, a countdown.
      if (item.tone === 'error' && context) {
        const last = context.newestId === `notice:${item.id}`
        return (
          <ErrorCard
            chatId={chatId}
            item={item}
            name={context.name}
            last={last}
            arrivedAt={last ? context.liveErrorAt : null}
            driving={context.driving}
            online={context.online}
            running={context.running}
            onNewChat={context.newChat}
            onAct={context.claim}
            extra={item.code === 'too-long' ? <CompactAction chatId={chatId} /> /* SS-03: Compact and continue */ : undefined}
          />
        )
      }
      return (
        <div className={`chat-notice chat-notice--${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
          <span>{item.text}</span>
          {item.code === 'too-long' && <CompactAction chatId={chatId} /> /* SS-03: Compact and continue */}
          {mentionsApiKey(item.text) && (
            <Button size="sm" onClick={() => void call('pages', 'open', 'atelier://settings/model')}>{t('chat.log.openSettings')}</Button>
          )}
        </div>
      )
    }
    case 'user':
      return null
    // CH-14 the step-limit card, CH-17 the stop mark
    case 'step-limit':
      return <StepLimitCard chatId={chatId} item={item} name={context?.name ?? t('chat.log.yourCompanion')} canContinue={Boolean(context && !context.running && context.continuable === item.id)} onAct={context?.claim ?? (() => undefined)} />
    case 'stopped':
      return <StoppedMark item={item} />
    default:
      // A kind whose card hasn't registered yet draws nothing.
      return null
  }
}

/** A text turn as Markdown, with new words fading in while it streams (DS-56). */
function AssistantText({ chatId, turnId, text, lifted }: { chatId: string; turnId: string; text: string; lifted?: Block[] }): ReactElement {
  const { reduced } = useMotion()
  const parsed = useMarkdownBlocks(text)
  // DS-63: without the closing question, which its own block shows.
  const blocks = lifted ?? parsed
  const [mountedAt] = useState(() => Date.now())
  const record = revealRecord(chatId, turnId, countMarkdownWords(blocks), Date.now())
  const reveal = !reduced && record.batches.length > 0 ? { record, mountedAt } : null
  // The wrapper only marks the reply's text for find (CH-37); it takes no box.
  return <div data-find-id={turnId} className="cd-find-target"><MarkdownBlocks blocks={blocks} reveal={reveal} className="chat-msg__text" /></div>
}

// ---- the work fold (DS-55): WorkTrace.tsx (CH-19) ----

// ---- the quiet footer (DS-57) ----

interface FooterProps {
  onAct(): void
  chatId: string
  block: Extract<ChatBlock, { kind: 'reply' }>
  state: ChatState
  companion: Companion | null | undefined
  name: string
  running: boolean
}

function ReplyFooter({ onAct, chatId, block, state, companion, name, running }: FooterProps): ReactElement {
  const t = useT()
  const shell = useShell()
  const [noteFor, setNoteFor] = useState<FeedbackRating | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const ask = useConfirm()
  const anchor = block.anchorTurnId
  const rating = replyFeedback(block.turnIds, anchor, state.feedback)
  const details = replyDetails(block.turnIds, state.details)
  const companionId = state.setup?.companionId ?? state.summary?.companionId ?? ''

  const rate = async (next: FeedbackRating | null, note = ''): Promise<ChatFeedback | null | undefined> => {
    if (!anchor) return undefined
    try {
      const saved = await call('chats', 'feedback', chatId, anchor, next, note)
      const feedback = { ...state.feedback }
      for (const id of block.turnIds) delete feedback[id]
      if (saved) feedback[anchor] = saved
      patchChat(chatId, { feedback })
      return saved
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      return undefined
    }
  }

  const pick = (choice: FeedbackRating): void => {
    if (rating?.rating === choice) {
      setNoteFor(null)
      void rate(null)
      return
    }
    void rate(choice, rating?.note ?? '').then((saved) => {
      if (saved) setNoteFor(choice)
    })
  }

  const retry = async (): Promise<void> => {
    if (!block.last) {
      const ok = await ask({
        title: t('chat.log.retryThisReply'),
        message: t('chat.log.answersThisMessageAgain', { name }),
        confirmLabel: t('chat.log.retry'),
        destructive: true,
      })
      if (!ok) return
    }
    onAct()
    try {
      // Without a turn (a reply that only failed) main retries the last message.
      const turnId = block.turnIds[0]
      await (turnId ? call('chats', 'retry', chatId, turnId) : call('chats', 'retry', chatId))
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const openMemory = (path: string): void => {
    const where = memoryLocation(path, companionId)
    // The companion's own notes are on its card, over the page; shared notes live in Settings.
    if (where.owner === 'shared' || !companionId) void call('pages', 'open', 'atelier://settings/memory')
    else shell.openCompanionCard(companionId, 'memory')
  }

  const more = async (anchorEl: Element): Promise<void> => {
    const memory = details?.memoryPaths ?? []
    const items: MenuItemSpec[] = [
      { id: 'retry', label: block.last ? t('chat.log.retry') : t('chat.log.retryFromHere'), enabled: !running && Boolean(block.userId) },
      { id: 'details', label: showDetails ? t('chat.log.hideDetails') : t('chat.log.details'), enabled: Boolean(anchor) },
    ]
    if (memory.length > 0) {
      items.push(menuSeparator(), {
        id: 'memory',
        label: memory.length === 1 ? t('chat.log.memoryUpdated') : t('chat.log.memoryFilesUpdated', { length: memory.length }),
        submenu: memory.map((path, i) => ({ id: `memory:${i}`, label: path.replace(/^\/memories\/?/, '') || path })),
      })
    }
    const picked = await showMenu(items, anchorEl)
    if (picked === 'retry') void retry()
    else if (picked === 'details') setShowDetails((v) => !v)
    else if (picked?.startsWith('memory:')) {
      const path = memory[Number(picked.slice(7))]
      if (path) openMemory(path)
    }
  }

  // DS-57: the memory glyph's click lists what this turn changed; one file opens straight away.
  const memoryPaths = details?.memoryPaths ?? []
  const memoryMenu = async (anchorEl: Element): Promise<void> => {
    if (memoryPaths.length === 1) return openMemory(memoryPaths[0] ?? '')
    const picked = await showMenu(memoryPaths.map((path, i) => ({ id: `memory:${i}`, label: path.replace(/^\/memories\/?/, '') || path })), anchorEl)
    const path = picked ? memoryPaths[Number(picked.slice(7))] : undefined
    if (path) openMemory(path)
  }

  return (
    <div className="chat-footer">
      <div className="chat-footer__row">
        {anchor && (
          <>
            <IconButton size="sm" label={t('chat.log.helpful')} icon={<ThumbsUp />} pressed={rating?.rating === 'helpful'} onClick={() => pick('helpful')} />
            <IconButton size="sm" label={t('chat.log.notHelpful')} icon={<ThumbsDown />} pressed={rating?.rating === 'not-helpful'} onClick={() => pick('not-helpful')} />
          </>
        )}
        {memoryPaths.length > 0 && (
          <IconButton
            size="sm"
            label={memoryPaths.length === 1 ? t('chat.log.memoryUpdated') : t('chat.log.memoryFilesUpdated', { length: memoryPaths.length })}
            icon={<Brain />}
            aria-haspopup={memoryPaths.length > 1 ? 'menu' : undefined}
            onClick={(e) => void memoryMenu(e.currentTarget)}
          />
        )}
        {/* Copy and ⋯ fade in on hover over the turn (DS-57, DS-141). */}
        <span className="chat-footer__extra">
          {block.markdown && <CopyButton text={block.markdown} label={t('chat.log.copyAsMarkdown')} />}
          <IconButton
            size="sm"
            label={t('chat.log.moreForThisReply')}
            icon={<Ellipsis />}
            aria-haspopup="menu"
            tooltip={running ? t('chat.log.moreWaitForTo', { name }) : t('chat.log.more')}
            onClick={(e) => void more(e.currentTarget)}
          />
        </span>
        {rating?.note && noteFor === null && <span className="chat-footer__note" title={rating.note}>{t('chat.log.note', { note: rating.note })}</span>}
      </div>
      {noteFor && (
        <RatingNote
          initial={rating?.note ?? ''}
          rating={noteFor}
          onSave={async (note) => {
            if ((await rate(noteFor, note)) !== undefined) setNoteFor(null)
          }}
          onSkip={() => setNoteFor(null)}
        />
      )}
      {showDetails && (
        <div className="chat-details" role="group" aria-label={t('chat.log.replyDetails')}>
          {details ? (
            <dl>
              <div><dt>{t('chat.log.finished')}</dt><dd>{formatAbsolute(details.at)}</dd></div>
              <div><dt>{t('chat.log.model')}</dt><dd>{details.models.map(modelLabel).join(t('chat.log.modelsThen'))}</dd></div>
              {details.effort && <div><dt>{t('chat.log.effort')}</dt><dd>{t('chat.log.effortForThisMessage', { effort: effortLabel(details.effort) })}</dd></div>}
              <div>
                <dt>{t('chat.log.tokens')}</dt>
                <dd>
                  {t('chat.log.tokensInOut', { input: formatTokens(details.usage.inputTokens), output: formatTokens(details.usage.outputTokens) })}
                  {details.usage.cacheReadTokens + details.usage.cacheWriteTokens > 0 && t('chat.log.tokensFromCache', { cache: formatTokens(details.usage.cacheReadTokens) })}
                </dd>
              </div>
              {details.memoryPaths.length > 0 && (
                <div>
                  <dt>{t('chat.log.memory')}</dt>
                  <dd className="chat-details__memory">
                    {details.memoryPaths.map((path) => (
                      <button key={path} type="button" className="chat-details__link" onClick={() => openMemory(path)}>{path.replace(/^\/memories\/?/, '') || path}</button>
                    ))}
                  </dd>
                </div>
              )}
              {details.missing > 0 && <p className="chat-details__note">{t('chat.log.someStepsOfThis')}</p>}
            </dl>
          ) : (
            <p className="chat-details__note">{t('chat.log.atelierDidnTKeep')}</p>
          )}
          {companion === null && <p className="chat-details__note">{t('chat.log.theCompanionThatWrote')}</p>}
        </div>
      )}
    </div>
  )
}

function RatingNote({ initial, rating, onSave, onSkip }: { initial: string; rating: FeedbackRating; onSave(note: string): Promise<void>; onSkip(): void }): ReactElement {
  const t = useT()
  const [note, setNote] = useState(initial)
  const [busy, setBusy] = useState(false)
  const save = (): void => {
    setBusy(true)
    void onSave(note).finally(() => setBusy(false))
  }
  return (
    <div className="chat-rating-note">
      <label className="chat-rating-note__label">
        <StatusDot status={rating === 'helpful' ? 'success' : 'idle'} label="" size={6} />
        {rating === 'helpful' ? t('chat.log.whatWorkedWell') : t('chat.log.whatWentWrong')} <span className="chat-rating-note__private">{t('chat.log.onlyYouSeeThis')}</span>
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          placeholder={t('chat.log.addANoteOptional')}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onSkip()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            }
          }}
        />
      </label>
      <div className="chat-rating-note__actions">
        {/* CH-11: the note can be dictated; the words land at the end. */}
        <DictateButton label={tStatic('meetings.dictation.dictateNote')} onText={(words) => setNote((current) => insertDictation(current, current.length, current.length, words).text.slice(0, 2000))} />
        <Button size="sm" variant="ghost" onClick={onSkip}>{t('chat.log.skip')}</Button>
        <Button size="sm" variant="primary" loading={busy} onClick={save}>{t('chat.log.saveNote')}</Button>
      </div>
    </div>
  )
}

/** DS-66: the chat's loading rows, in the column's shape, pulsing with the working sweep. */
export function ChatSkeleton({ rows = 3, label = t('chat.log.loadingTheChat') }: { rows?: number; label?: string }): ReactElement {
  return (
    <div className="chat-skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cx('chat-skeleton__group', i % 2 === 1 && 'chat-skeleton__group--user')}>
          {i % 2 === 0 && <span className="chat-skeleton__face" />}
          <span className="chat-skeleton__bar" style={{ width: i % 2 === 1 ? '38%' : `${84 - ((i * 13) % 24)}%` }} />
          {i % 2 === 0 && <span className="chat-skeleton__bar" style={{ width: `${56 - ((i * 7) % 18)}%` }} />}
        </div>
      ))}
    </div>
  )
}
