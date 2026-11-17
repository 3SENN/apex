/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clipboard, type WebContents } from 'electron'
import { z } from 'zod'
import type { ChatAgentEvent, MessageAttachment, QueuedMessage } from '@shared/chats'
import { parseInternalUrl } from '@shared/url'
import { SpeechError, type SpeechSession, type SpeechSessionEvent } from '@shared/speech'
import { HUD_SPEECH, type HudAction, type HudPayload, type VoiceErrorCode, type VoiceSettings } from '@shared/voice'
import type { AppContext, WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { errorMessage, log } from '../log'
import { screenAccess } from '../speech/screenAccess'
import { bringForward, fixMicBlocked, fixScreenBlocked, openInApex, targetWindow } from './apexNav'
import { voiceChatTap } from './chatTap'
import { idleHud, reduceHud, type HudEvent } from './hud'
import { captureScreen, captureTab, insertText, readFocus, replaceFieldText, type FocusRead, type Shot, type ShotResult } from './platform'
import { companionChat, hudTarget, joinTranscript, rewritePrompt, routeCommand, voiceErrorFor, type RouteDecision } from './router'
import type { VoiceRuntime } from './runtime'
import { dictationOnly, voiceForCompanion } from '../decisions/uses' // DC-09, DC-12

// One hold-to-talk turn at a time (MV-01, MV-04 to MV-06): listen through
// the broker, route the text to the focused field or the companion, preview
// the reply in the HUD, read it aloud on request, then close on a countdown.

/** Coalesces streamed reply chunks into HUD updates. */
const REPLY_FLUSH_MS = 120
const PREVIEW_MAX = 1200

export interface KeyContext {
  wc: WebContents
  win: WindowContext | null
}

interface Turn {
  id: number
  context: KeyContext
  session: Promise<SpeechSession | null>
  finals: string[]
  partial: string
  failed: boolean
  cancelled: boolean
  route: Promise<RouteDecision>
  focus: FocusRead | null
  shot: Promise<ShotResult | null>
  /** The settled text, once released. */
  text: string
}

interface ReplyWatch {
  turn: number
  chatId: string | null
  text: string
  started: boolean
  markdown: string
  turnId: string | null
}

export class VoiceTurns {
  readonly #ctx: AppContext
  readonly #rt: VoiceRuntime
  #hud: HudPayload = idleHud()
  #hovered = false
  #countdown: NodeJS.Timeout | null = null
  #countdownKey = ''
  #turn: Turn | null = null
  #seq = 0
  #watch: ReplyWatch | null = null
  #flush: NodeJS.Timeout | null = null
  #lastVoiceChat: string | null = null
  /** The last released turn's window and screenshot, so a command switched to the companion afterwards keeps its picture. */
  #released: { id: number; win: WindowContext | null; shot: Promise<ShotResult | null> } | null = null
  /** Texts sent by voice that still wait in a chat's queue. */
  readonly #waiting = new Map<string, string[]>()
  readonly #queues = new Map<string, QueuedMessage[]>()
  readonly #disposers: Array<() => void> = []

  constructor(ctx: AppContext, rt: VoiceRuntime) {
    this.#ctx = ctx
    this.#rt = rt
    this.#disposers.push(
      voiceChatTap.onEvent((e) => this.#onChatEvent(e)),
      voiceChatTap.onQueue((chatId, queued) => this.#onQueue(chatId, queued)),
      ctx.float.handle(HUD_SPEECH, (_kind, args) => this.#onSpeech(args)),
    )
    ctx.float.on('closed', (kind) => {
      // A hidden HUD gets no mouseleave: a pointer that was on it (the close button) must not pause the next one's countdown.
      if (kind === 'voice-hud') this.#hovered = false
      if (kind === 'voice-hud' && this.#hud.state !== 'idle' && this.#hud.state !== 'listening' && this.#hud.state !== 'transcribing') this.#set({ ...this.#hud, state: 'idle', countdownMs: null }, false)
    })
  }

  hud(): HudPayload {
    return this.#hud
  }

  get speaking(): boolean {
    return this.#hud.state === 'speaking'
  }

  get busy(): boolean {
    return this.#turn !== null
  }

  // ── the chord ──

  start(context: KeyContext, readAloud: boolean): void {
    const v = this.#ctx.settings.get().voice
    this.#cancelTurn()
    this.#watch = null
    const id = ++this.#seq
    const provisional = v.target === 'field' ? 'field' : 'companion'
    if (!this.#ctx.float.isOpen('voice-hud')) this.#hovered = false
    this.#apply({ type: 'start', target: provisional, readAloud, sounds: v.sounds, chord: v.chord, voiceName: v.voiceName })
    this.#ctx.float.open('voice-hud', this.#hud)
    const win = context.win ?? this.#ctx.windows.fromWebContents(context.wc.id) ?? targetWindow(this.#ctx)
    const turn: Turn = {
      id,
      context: { wc: context.wc, win },
      session: this.#begin(id),
      finals: [],
      partial: '',
      failed: false,
      cancelled: false,
      route: Promise.resolve({ kind: 'companion' }),
      focus: null,
      shot: Promise.resolve(null),
      text: '',
    }
    turn.route = readFocus(context.wc).then((focus) => {
      turn.focus = focus
      const decision = routeCommand(v.target, focus)
      if (this.#turn === turn) this.#apply({ type: 'target', target: hudTarget(decision) })
      return decision
    })
    turn.shot = v.screenshot ? this.#screenshot(v, win) : Promise.resolve(null)
    this.#turn = turn
    this.#rt.changed()
  }

  readAloud(): void {
    this.#apply({ type: 'read-aloud-on' })
  }

  async end(readAloud: boolean): Promise<void> {
    const turn = this.#turn
    if (!turn) return
    if (readAloud) this.#apply({ type: 'read-aloud-on' })
    this.#apply({ type: 'release' })
    const session = await turn.session
    if (session) await session.stop().catch((err: unknown) => log.warn('voice', 'stop failed', { error: errorMessage(err) }))
    if (this.#turn !== turn || turn.cancelled) return
    this.#turn = null
    this.#rt.changed()
    if (turn.failed) return
    turn.text = joinTranscript(turn.finals, turn.partial)
    this.#released = { id: turn.id, win: turn.context.win, shot: turn.shot }
    if (!turn.text) return this.#error('no-speech')
    const decision = await turn.route
    if (this.#hud.turn !== turn.id) return
    // DC-12: in auto mode a request for the companion ("open my calendar") leaves the focused field alone when a decision model is sure.
    if (this.#hud.target === 'field' && decision.kind === 'field' && this.#ctx.settings.get().voice.target === 'auto' && turn.focus) {
      const attrs = turn.focus.attrs
      const forCompanion = await voiceForCompanion(turn.text, { label: attrs?.label || attrs?.placeholder || attrs?.name || '', value: turn.focus.value }, turn.context.win?.kind === 'private')
      if (this.#hud.turn !== turn.id) return
      if (forCompanion && this.#hud.target === 'field') this.#apply({ type: 'target', target: 'companion' })
    }
    if (this.#hud.target === 'field') {
      if (decision.kind !== 'field') return this.#error('no-field', turn.text)
      return this.#toField(turn)
    }
    return this.#toCompanion(turn.text, turn.context.win, await turn.shot)
  }

  /** Esc, a new hold, or dismiss: speech stops at once. */
  stopSpeech(): boolean {
    if (this.#hud.state !== 'speaking') return false
    this.#apply({ type: 'speech-ended' })
    return true
  }


  action(action: HudAction): void {
    switch (action) {
      case 'dismiss':
        this.#cancelTurn()
        this.close()
        return
      case 'open-chat': {
        const chatId = this.#hud.chatId
        if (!chatId) return
        const win = targetWindow(this.#ctx)
        if (win) {
          win.send({ type: 'voice-open-chat', chatId })
          bringForward(win)
        } else openInApex(this.#ctx, `apex://chat/${chatId}`)
        this.close()
        return
      }
      case 'read-aloud':
        this.#apply({ type: 'speak' })
        return
      case 'copy':
        clipboard.writeText(this.#hud.error?.text ?? this.#hud.settled)
        return
      case 'cancel-queued':
        this.#cancelQueued()
        return
      case 'switch-target':
        this.#switchTarget()
        return
      case 'hover-start':
      case 'hover-end':
        this.#hovered = action === 'hover-start'
        this.#apply({ type: 'hover', on: this.#hovered })
        return
      case 'fix':
        this.#fix()
        return
    }
  }

  close(): void {
    this.#clearCountdown()
    this.#watch = null
    this.#hovered = false
    if (this.#hud.state !== 'idle') this.#set({ ...this.#hud, state: 'idle', countdownMs: null })
    this.#ctx.float.close('voice-hud')
  }

  dispose(): void {
    this.#cancelTurn()
    this.#clearCountdown()
    if (this.#flush) clearTimeout(this.#flush)
    for (const off of this.#disposers.splice(0)) off()
  }

  // ── listening ──

  async #begin(id: number): Promise<SpeechSession | null> {
    try {
      const session = await this.#rt.broker().begin({ purpose: 'voice-command', mode: 'dictation', levels: true })
      const turn = this.#turn
      if (!turn || turn.id !== id || turn.cancelled) {
        session.cancel()
        return null
      }
      session.on((e) => this.#onSession(id, e))
      return session
    } catch (err) {
      if (this.#turn?.id === id) {
        this.#turn.failed = true
        this.#error(voiceErrorFor(err), undefined, err)
      }
      return null
    }
  }

  #onSession(id: number, e: SpeechSessionEvent): void {
    const turn = this.#turn
    if (!turn || turn.id !== id) return
    switch (e.type) {
      case 'partial':
        turn.partial = e.text
        this.#apply({ type: 'partial', text: e.text })
        return
      case 'final':
        turn.finals.push(e.text)
        turn.partial = ''
        this.#apply({ type: 'final', text: e.text })
        return
      case 'level':
        this.#ctx.float.send('voice-hud', { type: 'level', source: e.source, rms: e.rms, peak: e.peak })
        return
      case 'error':
        if (!e.fatal) return
        turn.failed = true
        this.#error(voiceErrorFor(new SpeechError(e.code, e.message)), undefined, new SpeechError(e.code, e.message))
        return
      default:
        return
    }
  }

  #cancelTurn(): void {
    const turn = this.#turn
    if (!turn) return
    turn.cancelled = true
    this.#turn = null
    void turn.session.then((s) => s?.cancel())
    this.#rt.changed()
  }

  async #screenshot(v: VoiceSettings, win: WindowContext | null): Promise<ShotResult | null> {
    let result: ShotResult
    if (v.screenshotSource === 'screen') {
      const bounds = win && !win.window.isDestroyed() ? win.window.getBounds() : 'cursor'
      result = await captureScreen(bounds, this.#ctx.smoke, (capture) => this.#ctx.float.keepOutOf(capture))
    } else {
      const tab = win?.tabs.active() ?? null
      // apex:// pages and the new tab are Apex's own: nothing to show the model.
      if (!tab || win?.tabs.isChromeDrawn(tab)) return null
      result = await captureTab(this.#rt.masker(), tab.id)
    }
    if (!result.ok && this.#turn) {
      // Allowed in System Settings since launch: only a relaunch lets this process capture.
      const relaunch = result.reason === 'screen-missing' && !this.#ctx.smoke && (await screenAccess().status().catch(() => null)) === 'relaunch'
      if (this.#turn) this.#apply({ type: 'notice', notice: relaunch ? 'screen-relaunch' : result.reason })
    }
    return result
  }

  // ── routing ──

  async #toField(turn: Turn): Promise<void> {
    const v = this.#ctx.settings.get().voice
    const wc = turn.context.wc
    let text = turn.text
    let how: 'typed' | 'rewritten' = 'typed'
    // DC-09: plain dictation skips the rewrite when a decision model is sure; edit requests still wait on the companion.
    const dictated = v.rewriteField && turn.focus ? await dictationOnly(turn.text, turn.focus.value, turn.context.win?.kind === 'private') : false
    if (this.#hud.turn !== turn.id) return
    if (v.rewriteField && turn.focus && !dictated) {
      this.#apply({ type: 'rewriting' })
      try {
        const { system, prompt } = rewritePrompt(turn.focus.value, turn.text)
        text = (await this.#ctx.quick.text({ system, prompt, maxTokens: 2000 })).trim()
        how = 'rewritten'
      } catch (err) {
        if (this.#hud.turn === turn.id) this.#error(voiceErrorFor(err), turn.text, err)
        return
      }
    }
    if (this.#hud.turn !== turn.id) return
    try {
      if (how === 'rewritten') await replaceFieldText(wc, text)
      else await insertText(wc, text)
      this.#apply({ type: 'inserted', how, text })
    } catch (err) {
      this.#error('insert-failed', text, err)
    }
  }

  async #toCompanion(text: string, win: WindowContext | null, shot: ShotResult | null): Promise<void> {
    const turn = this.#hud.turn
    const ready = await this.#ctx.quick.ready().catch(() => ({ ok: false }))
    if (this.#hud.turn !== turn) return
    if (!ready.ok) return this.#error('no-engine', text)
    const attachments: MessageAttachment[] = shot?.ok ? [this.#attachment(shot.shot)] : []
    const tab = win?.tabs.active() ?? null
    const route = parseInternalUrl(tab?.internalUrl ?? '')
    const target = companionChat({
      chatPage: route?.page === 'chat' ? route.id : null,
      lastVoiceChat: this.#lastVoiceChat,
      tabChat: tab?.agentChatId ?? null,
      isViewed: (id) => this.#ctx.agent.isViewed(id),
    })
    this.#watch = { turn, chatId: target?.chatId ?? null, text, started: false, markdown: '', turnId: null }
    let chatId: string
    let queued = false
    try {
      if (target) {
        chatId = target.chatId
        queued = this.#ctx.agent.send(chatId, text, attachments).queued
      } else {
        chatId = this.#ctx.agent.start(text, {}, attachments)
      }
    } catch (err) {
      this.#watch = null
      return this.#error('failed', text, err)
    }
    if (this.#watch) this.#watch.chatId = chatId
    this.#lastVoiceChat = chatId
    if (queued) this.#waiting.set(chatId, [...(this.#waiting.get(chatId) ?? []), text])
    if ((!target || target.openPanel) && win) win.send({ type: 'voice-open-chat', chatId })
    let companionId = ''
    try {
      companionId = this.#ctx.agent.view(chatId).setup.companionId
    } catch {
      // The float shows the active companion.
    }
    const started = this.#watch?.started ?? false
    this.#apply({ type: 'sent', chatId, companionId, queued: queued ? Math.max(1, this.#queues.get(chatId)?.length ?? 1) : 0 })
    if (started) this.#apply({ type: 'reply-started' })
  }

  #attachment(shot: Shot): MessageAttachment {
    return { kind: 'image', mediaType: 'image/jpeg', data: shot.data, label: mainT('voice.screenshot.label'), masked: true }
  }

  // ── the reply (from the chat's own events) ──

  #onChatEvent({ chatId, event }: ChatAgentEvent): void {
    const watch = this.#watch
    if (!watch || this.#hud.turn !== watch.turn) return
    if (!watch.started) {
      if (event.type === 'user-message' && event.text === watch.text && (watch.chatId === null || watch.chatId === chatId)) {
        watch.started = true
        watch.chatId = chatId
        this.#dropWaiting(chatId, watch.text)
        if (this.#hud.chatId) this.#apply({ type: 'reply-started' })
      }
      return
    }
    if (chatId !== watch.chatId) return
    switch (event.type) {
      case 'text-delta':
        if (watch.turnId && watch.turnId !== event.turnId && watch.markdown) watch.markdown += '\n\n'
        watch.turnId = event.turnId
        watch.markdown += event.text
        this.#scheduleFlush()
        return
      case 'source':
        this.#apply({ type: 'citation', title: event.title, url: event.url })
        return
      case 'error':
        this.#watch = null
        this.#error('failed', undefined, new Error(event.message))
        return
      case 'status':
        if (event.status === 'running') return
        if (event.status === 'awaiting-approval') watch.markdown += `${watch.markdown ? '\n\n' : ''}_${mainT('voice.hud.needsYou')}_`
        this.#finishReply()
        return
      case 'stopped':
        this.#finishReply()
        return
      default:
        return
    }
  }

  #scheduleFlush(): void {
    if (this.#flush) return
    this.#flush = setTimeout(() => {
      this.#flush = null
      const watch = this.#watch
      if (watch) this.#apply({ type: 'reply', markdown: preview(watch.markdown) })
    }, REPLY_FLUSH_MS)
  }

  #finishReply(): void {
    const watch = this.#watch
    if (!watch) return
    if (this.#flush) clearTimeout(this.#flush)
    this.#flush = null
    this.#watch = null
    this.#apply({ type: 'reply', markdown: preview(watch.markdown) })
    this.#apply({ type: 'reply-done' })
  }

  #onQueue(chatId: string, queued: QueuedMessage[]): void {
    this.#queues.set(chatId, queued)
    const mine = this.#waiting.get(chatId)
    if (mine) {
      const still = mine.filter((text) => queued.some((q) => q.text === text))
      if (still.length) this.#waiting.set(chatId, still)
      else this.#waiting.delete(chatId)
    }
    if (this.#hud.chatId === chatId && this.#hud.state === 'thinking') this.#apply({ type: 'queued', count: queued.length })
  }

  #dropWaiting(chatId: string, text: string): void {
    const mine = this.#waiting.get(chatId)
    if (!mine) return
    const i = mine.indexOf(text)
    if (i >= 0) mine.splice(i, 1)
    if (!mine.length) this.#waiting.delete(chatId)
  }

  /** Cancel removes the voice commands still waiting in this chat's queue. */
  #cancelQueued(): void {
    const chatId = this.#hud.chatId
    if (!chatId) return
    const mine = this.#waiting.get(chatId) ?? []
    for (const q of this.#queues.get(chatId) ?? []) {
      if (!mine.includes(q.text)) continue
      try {
        this.#ctx.agent.editQueued(chatId, q.id, null)
      } catch (err) {
        log.warn('voice', 'cancel queued failed', { error: errorMessage(err) })
      }
    }
    this.#waiting.delete(chatId)
    this.#watch = null
    this.close()
  }

  #switchTarget(): void {
    const p = this.#hud
    if (p.state === 'listening' || p.state === 'transcribing') {
      this.#apply({ type: 'target', target: p.target === 'field' ? 'companion' : 'field' })
      return
    }
    // A command that could not be typed (no field, failed insert) can still go to the companion.
    if (p.state === 'error' && p.error?.text && (p.error.code === 'no-field' || p.error.code === 'insert-failed')) {
      const released = this.#released?.id === p.turn ? this.#released : null
      const win = released?.win ?? targetWindow(this.#ctx)
      const text = p.error.text
      this.#set({ ...p, state: 'transcribing', target: 'companion', settled: text, error: null, countdownMs: null })
      void (released?.shot ?? Promise.resolve(null)).then((shot) => this.#toCompanion(text, win, shot))
    }
  }

  #fix(): void {
    const code = this.#hud.error?.code
    // Asks macOS when it never has, else opens the pane for what is off now; holding the keys again retries.
    if (code === 'mic-blocked') void fixMicBlocked(this.#rt.broker(), this.#rt.blockedPane())
    else if (code === 'no-engine') openInApex(this.#ctx, 'apex://settings/model')
    else if (code === 'another-recording') {
      const meetingId = this.#rt.recordingMeeting()
      if (meetingId) openInApex(this.#ctx, `apex://meetings/${meetingId}`)
    } else if (!code && (this.#hud.notice === 'screen-missing' || this.#hud.notice === 'screen-relaunch')) void fixScreenBlocked()
    this.close()
  }

  #onSpeech(args: unknown[]): void {
    const parsed = z.enum(['started', 'boundary', 'ended', 'failed']).safeParse(args[0])
    if (!parsed.success) return
    if (parsed.data === 'ended' || parsed.data === 'failed') this.#apply({ type: 'speech-ended' })
  }

  // ── payload plumbing ──

  #error(code: VoiceErrorCode, text?: string, err?: unknown): void {
    if (err) log.info('voice', 'turn failed', { code, error: errorMessage(err) })
    if (err instanceof SpeechError && (err.code === 'mic-denied' || err.code === 'speech-denied')) this.#rt.noteBlocked(err.code)
    this.#apply({ type: 'error', code, text })
    if (!this.#ctx.float.isOpen('voice-hud')) this.#ctx.float.open('voice-hud', this.#hud)
  }

  #apply(e: HudEvent): void {
    this.#set(reduceHud(this.#hud, e, this.#hovered))
  }

  #set(next: HudPayload, push = true): void {
    const was = this.#hud
    this.#hud = next
    if (push) this.#ctx.float.update('voice-hud', next)
    this.#syncCountdown()
    if (was.state !== next.state || was.queued !== next.queued || was.chatId !== next.chatId || was.target !== next.target) this.#rt.changed()
  }

  #syncCountdown(): void {
    const p = this.#hud
    const key = p.countdownMs === null ? '' : `${p.turn}:${p.state}:${p.countdownMs}`
    if (key === this.#countdownKey) return
    this.#clearCountdown()
    this.#countdownKey = key
    if (p.countdownMs === null) return
    this.#countdown = setTimeout(() => {
      this.#countdown = null
      this.#countdownKey = ''
      this.close()
    }, p.countdownMs)
  }

  #clearCountdown(): void {
    if (this.#countdown) clearTimeout(this.#countdown)
    this.#countdown = null
    this.#countdownKey = ''
  }
}

/** The HUD previews the start of a long reply; the chat has the rest. */
function preview(markdown: string): string {
  const text = markdown.trim()
  if (text.length <= PREVIEW_MAX) return text
  const cut = text.slice(0, PREVIEW_MAX)
  const end = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '))
  return `${(end > PREVIEW_MAX / 2 ? cut.slice(0, end + 1) : cut).trimEnd()} …`
}
