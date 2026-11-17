/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { KeyRound, MessageSquarePlus, Pencil, SearchX } from 'lucide-react'
import { accentTokens } from '@shared/accent'
import type { CompanionMood } from '@shared/companion'
import type { Companion as CompanionRecord } from '@shared/services'
import type { NewChatOptions } from '@shared/chats'
import { atelier, call, errorText } from '../api'
import { Bubble, Companion } from '../companion'
import { signalPresence, useChatPresence } from '../companion/presence'
import { useCompanionImage } from '../components/companionData'
import { engineCanSend } from '../settings/logic/engine'
import { Button, EmptyState, ErrorState, cx, toast } from '../ui'
import { ChatLog, ChatSkeleton } from './ChatLog'
import { Composer, type ComposerHandle } from './Composer'
import { ChatIntakeScope } from './composer/DropZone'
import { glideComposerIn, noteComposerOrigin, noteStanding } from './handoff'
import { useCompanion, useCompanionList, useSettingsView } from './hooks'
import { latestUserMessage } from './logic/replies'
import { chatMood, waitingSize } from './logic/view'
import { markSent, reloadChat, useChat, type ChatState } from './store'
import { releaseSurface, setDraftText, useDriving, type Driving } from './surfaces'
import { MigrationNotice } from '../migrations/MigrationNotice'
import { useShell } from '../components/shellContext'
import { useT } from '../i18n/useT'
import { StartChrome } from './StartSurface' // DS-72
import { greetingPlacement, type GreetingPlace } from './logic/start' // DS-80
import { OfflineBanner, SaveErrorNotice, useOnline } from './ChatCards' // SS-04, SS-05, SS-06
// Banners, the private toggle, find in chat, the ideas card
import { ChatBanners, PrivateToggle } from './ChatBanners'
import { ChatFindBar } from './find/ChatFindBar'
import { useChatFindTarget } from './find/findRouter'
import { IdeasCard } from '../components/newtab/IdeasCard'
import { ChipTray } from '../components/newtab/ChipTray'
import '../components/newtab/newtab.css'
// DS-107: the start surface's keep-awake corner (the switcher, floor and top corner are DS-72's StartChrome).
import { StartKeepAwake } from '../components/StartSurface'
import { isStartSurface, showsChatHeader } from '../components/startSurfaceLogic'

export type ChatVariant = 'page' | 'panel'

export interface ChatViewContext {
  state: ChatState
  companion: CompanionRecord | null | undefined
  name: string
  driving: Driving
  mood: CompanionMood
  /** Starts a fresh chat on this surface. */
  newChat(): void
}

export interface ChatViewProps {
  chatId: string
  /** 'panel' or 'page:<tabId>'; main uses it to know which chats are on screen. */
  surfaceId: string
  variant: ChatVariant
  /** Shows another chat on this surface (new chat, companion switch). */
  onChangeChat(chatId: string): void
  /** The companion a new chat starts with; default: the active one. */
  newChatCompanionId?: string
  header?(context: ChatViewContext): ReactNode
  /** CH-13: a message to scroll to and highlight, from the link's fragment. */
  anchor?: string | null
}

/** How long the waiting companion's greeting bubble stays before it fades. */
const GREETING_MS = 8000

/** Creates a draft chat and resolves to its id. */
export async function newDraftChat(companionId?: string, options: Omit<NewChatOptions, 'companionId'> = {}): Promise<string | null> {
  try {
    const draft = await call('chats', 'create', { ...(companionId ? { companionId } : {}), ...options })
    return draft.id
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
    return null
  }
}

/** The chat's companion colour as CSS variables for both modes, readable on the chat surface. */
export function companionTint(color: string | null | undefined): CSSProperties {
  if (!color) return {}
  const light = accentTokens(color, 'light')
  const dark = accentTokens(color, 'dark')
  return {
    '--chat-co-light': light.accent,
    '--chat-co-dark': dark.accent,
    '--chat-co-text-light': light.text,
    '--chat-co-text-dark': dark.text,
    '--chat-co-soft-light': light.soft,
    '--chat-co-soft-dark': dark.soft,
  } as CSSProperties
}

/** One chat on one surface: states, messages and composer. The panel and the chat page both use it. */
export function ChatView({ chatId, surfaceId, variant, onChangeChat, newChatCompanionId, header, anchor = null }: ChatViewProps): ReactElement {
  const t = useT()
  const state = useChat(chatId)
  const settings = useSettingsView()
  const companions = useCompanionList()
  const companionKey = state.setup?.companionId ?? state.summary?.companionId
  const companion = useCompanion(companionKey ?? null)
  const name = companion?.name ?? (companion === null ? t('chat.view.yourCompanion') : 'Companion')
  const running = state.log.status !== 'idle'
  const driving = useDriving(chatId, surfaceId, running)
  const online = useOnline()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [caret, setCaret] = useState<{ x: number; y: number } | null>(null)
  const composer = useRef<ComposerHandle>(null)
  const root = useRef<HTMLElement>(null)
  const find = useChatFindTarget(variant, root) // CH-37
  // The presence store (every composer, agent events) wins; the chat's own state covers the rest.
  // DS-69: focusing the composer alone changes nothing; typing reaches only the live figure, through presence.
  const localMood = useChatMood(state, false)
  const { mood } = useChatPresence(chatId, localMood)
  // A chat with a migration notice shows its read-only log, never the start surface.
  const empty = state.log.items.length === 0 && state.sentAt === null && !state.notice
  // A chat on an engine with its own sign-in sends without an API key (ST-58); its setup says which engine it uses.
  const canSend = engineCanSend(state.setup?.engine ?? companion?.engine ?? settings.engine, settings.hasApiKey)

  // Main marks chats read while a surface shows them.
  useEffect(() => {
    void call('chats', 'setViewing', surfaceId, chatId).catch(() => undefined)
    return () => {
      void call('chats', 'setViewing', surfaceId, null).catch(() => undefined)
      releaseSurface(surfaceId, chatId)
    }
  }, [surfaceId, chatId])

  useEffect(() => setEditingId(null), [chatId])

  // Focus the composer when a chat opens, so you can type straight away. The
  // panel doesn't take focus from another field (the new tab's ask field, the address).
  useEffect(() => {
    if (state.phase !== 'ready') return
    const active = document.activeElement
    const free = !active || active === document.body || root.current?.contains(active)
    if (variant === 'page' || free) composer.current?.focus()
  }, [chatId, state.phase, variant])

  // DS-73: the first send glides the composer from the start position to the bottom.
  const startRect = useRef<{ chatId: string; rect: DOMRect } | null>(null)
  useLayoutEffect(() => {
    const box = root.current?.querySelector<HTMLElement>(':scope > .chat-composer .chat-composer__box')
    if (!box) return
    if (empty) {
      startRect.current = { chatId, rect: box.getBoundingClientRect() }
      return
    }
    const from = startRect.current
    startRect.current = null
    // Only the chat that was empty a moment ago glides; switching chats doesn't.
    if (from?.chatId !== chatId) return
    noteComposerOrigin(chatId, from.rect)
    glideComposerIn(chatId, box)
  }, [empty, chatId, state.phase])

  const newChat = useCallback(() => {
    void newDraftChat(newChatCompanionId).then((id) => id && onChangeChat(id))
  }, [newChatCompanionId, onChangeChat])
  // Another companion takes this empty chat: a new draft with it, carrying what was typed.
  const switchCompanion = (companionId: string, text: string): void => {
    void newDraftChat(companionId).then((id) => {
      if (!id) return
      setDraftText(id, text)
      onChangeChat(id)
    })
  }
  // An error card's Use another model on a started chat: the same companion and engine, the picked model, the failed message ready to send.
  const switchModel = (model: string, text: string): void => {
    void newDraftChat(state.setup?.companionId ?? companion?.id, { model, ...(state.setup?.engine ? { engine: state.setup.engine } : {}) }).then((id) => {
      if (!id) return
      setDraftText(id, text)
      onChangeChat(id)
    })
  }
  const draftText = (): string => root.current?.querySelector<HTMLTextAreaElement>('.chat-composer__box textarea')?.value ?? ''

  const context: ChatViewContext = { state, companion, name, driving, mood, newChat }

  // Only a draft (a new chat before its first send) is the start surface; an empty saved chat (a sub-agent's, say) is not.
  const startEmpty = isStartSurface({ empty, phase: state.phase, draft: state.summary?.draft, imported: state.summary?.imported })
  // DS-107: the empty chat page has no header bar; the start chrome's switcher stands in for it.
  const headerShown = showsChatHeader({ variant, phase: state.phase, startSurface: startEmpty, hasCompanion: companion !== null })

  let body: ReactNode
  if (state.phase === 'loading') {
    body = <div className="chat-view__state chat-view__state--loading"><ChatSkeleton rows={variant === 'panel' ? 3 : 4} /></div>
  } else if (state.phase === 'missing') {
    body = (
      <div className="chat-view__state">
        <EmptyState
          icon={<SearchX />}
          title={t('chat.view.thisChatIsnT')}
          description={t('chat.view.itMayHaveBeen')}
          action={
            <>
              <Button variant="primary" icon={<MessageSquarePlus size={14} />} onClick={newChat}>{t('chat.view.newChat')}</Button>
              <Button onClick={() => void call('pages', 'open', 'atelier://chats')}>{t('chat.view.allChats')}</Button>
            </>
          }
        />
      </div>
    )
  } else if (state.phase === 'failed') {
    body = (
      <div className="chat-view__state">
        <ErrorState
          title={t('chat.view.couldnTLoadThis')}
          message={state.error ?? t('chat.view.somethingWentWrongWhile')}
          onRetry={() => reloadChat(chatId)}
          action={<Button onClick={newChat}>{t('chat.view.newChat')}</Button>}
        />
      </div>
    )
  } else {
    const startWith = (text: string): void => {
      driving.claim()
      signalPresence('sent', companion?.id ?? null, chatId)
      markSent(chatId)
      void atelier.agent.send(chatId, text).catch((err: unknown) => {
        markSent(chatId, false)
        toast.show({ message: errorText(err), tone: 'error' })
      })
    }
    const lead = (
      <>
        {/* The routine run header, private and imported notes, the parent link and Don't ask (SK-12, CH-30, CH-31, CH-32). */}
        <ChatBanners chatId={chatId} state={state} onDiscarded={newChat} />
        {!canSend && (
          <div className="chat-callout" role="note">
            <KeyRound size={16} aria-hidden="true" />
            <p>{t('chat.view.addYourAnthropicApi', { name })}</p>
            <Button size="sm" variant="primary" onClick={() => void call('pages', 'open', 'atelier://settings/model')}>{t('chat.view.openSettings')}</Button>
          </div>
        )}
        {state.setup?.fixed && companion === null && (
          <div className="chat-callout chat-callout--muted" role="note">
            <p>{t('chat.view.theCompanionThatStarted')}</p>
          </div>
        )}
        {/* The migration notice (SS-09): damaged or newer chat files open read-only. */}
        <MigrationNotice chatId={chatId} notice={state.notice ?? null} />
      </>
    )
    // DS-107 / CO-20: an empty chat is the start surface. The companion stands
    // above the composer, whose top sits at 40% of the height, with the ideas
    // below it. The composer keeps its place in the tree, so the first send
    // glides it down to the bottom instead of remounting it (DS-73).
    body = (
      <>
        {/* DS-72: the start surface's chrome and floor, as on the new tab. */}
        {empty && companion && (
          <StartChrome
            root={root}
            companion={companion}
            companions={companions.items.filter((c) => !c.hidden)}
            onSwitch={(companionId) => companionId !== companion.id && switchCompanion(companionId, draftText())}
          />
        )}
        {empty ? (
          <div className="chat-start">
            {lead}
            {companion ? <WaitingCompanion chatId={chatId} companion={companion} variant={variant} lookAt={caret} /> : <div className="chat-empty__spacer" />}
          </div>
        ) : (
          <ChatLog
            chatId={chatId}
            state={state}
            companion={companion}
            name={name}
            mood={mood}
            driving={driving}
            editingId={editingId}
            onEditingChange={(id) => {
              setEditingId(id)
              // Closing the editor puts you back in the composer.
              if (id === null) requestAnimationFrame(() => composer.current?.focus())
            }}
            lead={lead}
            empty={null}
            anchor={anchor}
            onNewChat={newChat}
          />
        )}
        {/* Offline, sends wait and the composer stays usable (SS-04, SS-06); a failed save offers Retry (SS-05). */}
        <OfflineBanner online={online} />
        <SaveErrorNotice chatId={chatId} error={state.saveError} />
        {/* CH-31: an imported transcript is read-only; its banner carries on in a new chat instead. */}
        {!state.summary?.imported && <Composer
          ref={composer}
          chatId={chatId}
          state={state}
          companion={companion}
          companions={companions.items.filter((c) => !c.hidden)}
          name={name}
          hasApiKey={canSend}
          driving={driving}
          surface={variant}
          {...(empty ? { onCaret: setCaret } : {})}
          onEditLatest={() => {
            if (state.summary?.draft) return false
            const latest = latestUserMessage(state.log.items)
            if (!latest) return false
            setEditingId(latest.id)
            return true
          }}
          onOpenChat={onChangeChat}
          onSwitchCompanion={switchCompanion}
          onSwitchModel={switchModel}
        />}
        {/* DS-108: the start tray is tucked under the composer card, outside the scrolling ideas so its band reaches under the card's foot. */}
        {empty && canSend && (
          <div className="chat-ideas chat-start__tray">
            <ChipTray compact={variant === 'panel'} />
          </div>
        )}
        {empty && (
          <div className="chat-start__below">
            {/* DS-109: the ideas card, then the private toggle (CH-30) below it, as on the new tab. */}
            {canSend && (
              <div className="chat-ideas">
                <IdeasCard companionName={name} compact={variant === 'panel'} onPrefill={(text) => composer.current?.insert(text)} onSend={startWith} />
              </div>
            )}
            {variant === 'page' && <PrivateToggle chatId={chatId} state={state} onChangeChat={onChangeChat} />}
          </div>
        )}
      </>
    )
  }

  return (
    <section
      ref={root}
      className={cx('chat-view', `chat-view--${variant}`, empty && state.phase === 'ready' && 'chat-view--empty', !headerShown && state.phase === 'ready' && 'chat-view--bare')}
      style={companionTint(companion?.look.colors.accent)}
      data-tinted={companion ? '' : undefined}
      aria-label={state.summary?.title ?? t('chat.view.chat')}
      data-deleted={state.phase === 'missing' || undefined}
    >
      {/* CH-23: files dropped anywhere on the chat attach to its draft; cards reach this composer. */}
      <ChatIntakeScope chatId={chatId} root={root} composer={composer} enabled={state.phase === 'ready' && !state.notice}>
        {headerShown && header?.(context)}
        {/* DS-107 / DS-112: one keep-awake button at the bottom right of the start surface. */}
        {startEmpty && <StartKeepAwake compact={variant === 'panel'} />}
        {body}
        {/* CH-37: ⌘F in this chat. */}
        {find.open && state.phase === 'ready' && (
          <div className="cd-find-host">
            <ChatFindBar chatId={chatId} items={state.log.items} root={root} nonce={find.nonce} onClose={() => find.setOpen(false)} />
          </div>
        )}
      </ChatIntakeScope>
    </section>
  )
}

/**
 * CO-20 / DS-72: the live companion standing in an empty chat, waiting. It
 * greets once, follows the chat's presence (listening while you type, thinking
 * once you send), looks at the caret while you type, and is sized to the room.
 * As it leaves on the first send, it notes its place for the face it flies into.
 */
function WaitingCompanion({ chatId, companion, variant, lookAt }: { chatId: string; companion: CompanionRecord; variant: ChatVariant; lookAt: { x: number; y: number } | null }): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  // The greeting is a one-time speech bubble beside the figure (CO-20, DS-72), then it idles.
  const [greeting, setGreeting] = useState<'on' | 'leaving' | 'off'>('on')
  useEffect(() => {
    setGreeting('on')
    const leave = setTimeout(() => setGreeting('leaving'), GREETING_MS)
    const gone = setTimeout(() => setGreeting('off'), GREETING_MS + 400)
    return () => {
      clearTimeout(leave)
      clearTimeout(gone)
    }
  }, [chatId])
  const tr = useT()
  const shell = useShell()
  const [room, setRoom] = useState<number | null>(null)
  // DS-80: the greeting goes beside the head on the side with room, wrapping inside it.
  const [place, setPlace] = useState<GreetingPlace>({ side: 'left', maxWidth: 260 })
  const size = waitingSize(variant, room)
  const still = useCompanionImage(companion.look, size * 2, { framing: 'full' })
  const latest = useRef({ still, rect: null as DOMRect | null })
  latest.current.still = still

  useLayoutEffect(() => {
    const el = host.current
    const view = el?.closest('.chat-view')
    if (!el || !view) return
    const measure = (): void => {
      const box = view.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      setRoom(box.height)
      latest.current.rect = rect
      const next = greetingPlacement(box, rect)
      setPlace((p) => (p.side === next.side && p.maxWidth === next.maxWidth ? p : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    // DS-108: the figure grows once the room is known, after the view's last resize; measure that too,
    // so the greeting never takes the side that has no room (the side panel cut it off).
    observer.observe(el)
    return () => {
      observer.disconnect()
      const rect = el.getBoundingClientRect()
      noteStanding(chatId, rect.width > 0 ? rect : (latest.current.rect ?? rect), latest.current.still)
    }
  }, [chatId])

  return (
    <div ref={host} className="chat-empty__companion" style={{ width: size, height: size }}>
      {/* DS-72: the figure is a square button with a pencil badge and a tooltip; it opens the companion's card. */}
      <button type="button" className="nt__figure-button chat-start__figure" aria-label={tr('tabs.newTab.openCard', { name: companion.name })} onClick={() => shell.openCompanionCard(companion.id)}>
        <Companion profile={companion} chatId={chatId} size={size} framing="full" floor greet lookAt={lookAt} title={companion.name} priority={variant === 'page' ? 2 : 1} />
        <span className="nt__badge" aria-hidden="true">
          <Pencil />
        </span>
        <span className="nt__tip" aria-hidden="true">{tr('tabs.newTab.openCard', { name: companion.name })}</span>
      </button>
      {greeting !== 'off' && (
        <span
          className={cx('chat-empty__greeting', `chat-empty__greeting--${place.side}`, greeting === 'leaving' && 'chat-empty__greeting--leaving')}
          style={{ '--greeting-max': `${place.maxWidth}px` } as CSSProperties}
        >
          <Bubble text={tr('tabs.chatStart.greeting', { name: companion.name })} side={place.side} tint={companion.look.colors.accent} revealKey={chatId} announce />
        </span>
      )}
    </div>
  )
}

/** The companion's mood for one chat; timed moods (talking, celebrating) settle on their own. */
export function useChatMood(state: ChatState, listening: boolean): CompanionMood {
  const [, tick] = useState(0)
  const { mood, changesIn } = chatMood({
    status: state.log.status,
    activity: state.activity,
    activityAt: state.activityAt,
    outcome: state.outcome,
    outcomeAt: state.outcomeAt,
    listening,
    now: Date.now(),
  })
  useEffect(() => {
    if (changesIn === null) return
    const timer = setTimeout(() => tick((n) => n + 1), changesIn + 16)
    return () => clearTimeout(timer)
  }, [changesIn, mood])
  // A message on its way already has the companion thinking.
  return state.sentAt !== null && state.log.status === 'idle' ? 'thinking' : mood
}
