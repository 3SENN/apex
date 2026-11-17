/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, type Input } from 'electron'
import { z } from 'zod'
import type { MessageAttachment } from '@shared/chats'
import { chatUrl } from '@shared/url'
import { LAUNCHER_ACTIONS, LAUNCHER_PRESENCE, QUICK_ASK_SIGNALS, type LauncherPayload, type QuickAskSignal, type VoiceErrorCode } from '@shared/voice'
import { SpeechError, type SpeechSession } from '@shared/speech'
import type { AppContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { errorMessage, log } from '../log'
import { screenAccess } from '../speech/screenAccess'
import { fixMicBlocked, fixScreenBlocked, openInAtelier } from './atelierNav'
import { matchesChord } from './keys'
import { closedLauncher, launcherKeyAction, reduceLauncher, type LauncherEvent } from './launcher'
import { captureScreen, type Shot } from './platform'
import { voiceErrorFor } from './router'
import type { VoiceRuntime } from './runtime'

// The quick-ask launcher (MV-02, MV-03): a float at the bottom centre
// of the cursor's display that listens straight away, shows the words as
// they come, and sends them to a new chat in a foreground tab. Opened by the
// global shortcut (outside Atelier) or voice.launcherToggle.

/** How long "working" shows before the launcher steps aside for the chat. */
const WORKING_MS = 700
const TEXT_MAX = 20_000

export class QuickAsk {
  readonly #ctx: AppContext
  readonly #rt: VoiceRuntime
  #payload: LauncherPayload = closedLauncher()
  #open = false
  #session: SpeechSession | null = null
  #sessionSeq = 0
  #shot: Shot | null = null
  /** The app that was in front when the launcher opened, to hand focus back to. */
  #frontPid: number | null = null
  #keysWired: number | null = null
  readonly #disposers: Array<() => void> = []
  /** DS-68: whether the chrome last heard "typing" from this launcher, so closing it puts companions back at rest. */
  #presenceTyping = false

  constructor(ctx: AppContext, rt: VoiceRuntime) {
    this.#ctx = ctx
    this.#rt = rt
    const [submit, type, screenshot, dismiss, listen, fix] = LAUNCHER_ACTIONS
    this.#disposers.push(
      ctx.float.handle(submit, (_k, args) => this.#submit(args)),
      ctx.float.handle(type, (_k, args) => this.#type(args)),
      ctx.float.handle(screenshot, (_k, args) => this.#screenshot(args)),
      ctx.float.handle(dismiss, () => this.hide(true)),
      ctx.float.handle(listen, () => this.#listen()),
      ctx.float.handle(fix, () => this.#fix()),
      ctx.float.handle(LAUNCHER_PRESENCE, (_k, args) => this.#presence(args)),
    )
    ctx.float.on('closed', (kind) => {
      if (kind !== 'launcher' || !this.#open) return
      this.#open = false
      this.#stopSession(true)
      this.#rt.changed()
    })
  }

  get isOpen(): boolean {
    return this.#open
  }

  payload(): LauncherPayload {
    return this.#payload
  }

  /** The launcher key: open, stop listening, or hide; a running meeting's transcript opens instead. */
  toggle(): void {
    const meetingId = this.#rt.recordingMeeting()
    if (meetingId && !this.#open) {
      openInAtelier(this.#ctx, `atelier://meetings/${meetingId}`)
      return
    }
    const action = launcherKeyAction(this.#open, this.#payload)
    if (action === 'open') void this.#openLauncher()
    else if (action === 'stop') void this.#stopListening()
    else this.hide(true)
  }

  hide(returnFocus: boolean): void {
    if (!this.#open) return
    this.#open = false
    if (this.#presenceTyping) this.#relayPresence('idle', null)
    this.#stopSession(true)
    this.#ctx.float.close('launcher')
    const pid = this.#frontPid
    this.#frontPid = null
    if (returnFocus && pid !== null) {
      try {
        this.#rt.broker().activate(pid)
      } catch {
        // No helper: macOS picks the next app itself.
      }
    }
    this.#rt.changed()
  }

  dispose(): void {
    this.#stopSession(true)
    for (const off of this.#disposers.splice(0)) off()
  }

  async #openLauncher(): Promise<void> {
    const v = this.#ctx.settings.get().voice
    this.#open = true
    this.#shot = null
    // Only an app outside Atelier gets focus back; inside Atelier it stays where it was.
    this.#frontPid = null
    if (!BrowserWindow.getFocusedWindow()) {
      this.#frontPid = await this.#rt
        .broker()
        .frontmost()
        .then((f) => f?.pid ?? null)
        .catch(() => null)
    }
    if (!this.#open) return
    this.#apply({ type: 'open', attach: v.launcherScreenshot, screenshot: null, screenshotBlocked: false, chord: v.chord, sounds: v.sounds })
    this.#ctx.float.open('launcher', this.#payload)
    this.#wireKeys()
    this.#rt.changed()
    const listening = this.#listen()
    // The float has content protection (or hides for the capture), so capturing after it shows never includes it.
    if (v.launcherScreenshot) await this.#capture(true)
    await listening
  }

  async #capture(attach: boolean): Promise<void> {
    const result = await captureScreen('cursor', this.#ctx.smoke, (capture) => this.#ctx.float.keepOutOf(capture))
    if (result.ok) this.#shot = result.shot
    const blocked = !result.ok && result.reason === 'screen-missing' && !this.#ctx.smoke
    // On in System Settings since launch: the chip offers a relaunch instead of the pane.
    const relaunch = blocked && (await screenAccess().status().catch(() => null)) === 'relaunch'
    if (!this.#open) return
    this.#apply({ type: 'shot', screenshot: this.#shot?.thumbnail ?? null, blocked, relaunch, attach })
  }

  /** Inside the launcher the launcher key arrives as a key event (the global shortcut is off while Atelier has focus). */
  #wireKeys(): void {
    const win = this.#ctx.float.window('launcher')
    if (!win || this.#keysWired === win.webContents.id) return
    this.#keysWired = win.webContents.id
    win.webContents.on('before-input-event', (event, input: Input) => {
      const v = this.#ctx.settings.get().voice
      if (input.type !== 'keyDown' || input.isAutoRepeat || !matchesChord(input, v.chord, v.readAloudModifier)) return
      event.preventDefault()
      this.toggle()
    })
  }

  async #listen(): Promise<void> {
    if (!this.#open) return
    this.#stopSession(true)
    this.#apply({ type: 'listen' })
    const seq = ++this.#sessionSeq
    try {
      const session = await this.#rt.broker().begin({ purpose: 'launcher', mode: 'dictation', levels: true })
      if (seq !== this.#sessionSeq || !this.#open) {
        session.cancel()
        return
      }
      this.#session = session
      session.on((e) => {
        if (this.#session !== session) return
        if (e.type === 'partial') this.#apply({ type: 'partial', text: e.text })
        else if (e.type === 'final') this.#apply({ type: 'final', text: e.text })
        else if (e.type === 'level') this.#ctx.float.send('launcher', { type: 'level', source: e.source, rms: e.rms, peak: e.peak })
        else if (e.type === 'error' && e.fatal) {
          this.#session = null
          this.#noteBlocked(e.code)
          this.#apply({ type: 'error', code: voiceErrorFor({ code: e.code }) })
        }
      })
    } catch (err) {
      if (seq !== this.#sessionSeq) return
      log.info('voice', 'launcher could not listen', { error: errorMessage(err) })
      if (err instanceof SpeechError) this.#noteBlocked(err.code)
      this.#apply({ type: 'error', code: voiceErrorFor(err) })
    }
  }

  /** Remembers which permission a mic-blocked error came from, so the fix opens that pane (as hold-to-talk does). */
  #noteBlocked(code: string): void {
    if (code === 'mic-denied' || code === 'speech-denied') this.#rt.noteBlocked(code)
  }

  async #stopListening(): Promise<void> {
    const session = this.#session
    this.#session = null
    this.#apply({ type: 'stop' })
    if (session) await session.stop().catch(() => undefined)
    this.#apply({ type: 'stopped' })
  }

  #stopSession(cancel: boolean): void {
    this.#sessionSeq++
    const session = this.#session
    this.#session = null
    if (session && cancel) session.cancel()
  }

  #type(args: unknown[]): void {
    void args
    this.#stopSession(true)
    this.#apply({ type: 'type' })
  }

  async #screenshot(args: unknown[]): Promise<void> {
    const on = z.boolean().safeParse(args[0])
    if (!on.success) return
    // The choice is remembered for next time (MV-03).
    this.#ctx.settings.update({ voice: { launcherScreenshot: on.data } })
    if (on.data && this.#payload.screenshotBlocked) await this.#fixScreen()
    else if (on.data && !this.#shot) await this.#capture(true)
    else this.#apply({ type: 'attach', on: on.data })
  }

  /** The blocked chip: macOS asks the first time (then the chip tries again), later System Settings or a relaunch. */
  async #fixScreen(): Promise<void> {
    const result = await fixScreenBlocked()
    if (result === 'opened') this.hide(false)
    else if (result !== 'relaunched' && this.#open) await this.#capture(true)
  }

  async #submit(args: unknown[]): Promise<void> {
    const parsed = z.tuple([z.string().max(TEXT_MAX), z.boolean()]).safeParse(args.slice(0, 2))
    if (!parsed.success) return
    const [text, attach] = parsed.data
    this.#stopSession(true)
    this.#apply({ type: 'type' })
    this.#apply({ type: 'edit', text })
    this.#apply({ type: 'attach', on: attach })
    this.#apply({ type: 'send' })
    if (this.#payload.state !== 'sending') return
    const ready = await this.#ctx.quick.ready().catch(() => ({ ok: false }))
    if (!ready.ok) return this.#fail('no-engine')
    const attachments: MessageAttachment[] =
      this.#payload.attachScreenshot && this.#shot ? [{ kind: 'image', mediaType: 'image/jpeg', data: this.#shot.data, label: mainT('voice.screenshot.label'), masked: false }] : []
    let chatId: string
    try {
      chatId = this.#ctx.agent.start(text.trim(), {}, attachments)
    } catch (err) {
      log.warn('voice', 'launcher send failed', { error: errorMessage(err) })
      return this.#fail('failed')
    }
    if (!openInAtelier(this.#ctx, chatUrl(chatId))) return this.#fail('failed')
    this.#apply({ type: 'sent' })
    this.#frontPid = null
    setTimeout(() => this.hide(false), WORKING_MS)
  }

  /** DS-68: the launcher's composer is a presence input; every window's companions react to it. */
  #presence(args: unknown[]): void {
    const parsed = z.tuple([z.enum(QUICK_ASK_SIGNALS), z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable()]).safeParse(args.slice(0, 2))
    if (!parsed.success || !this.#open) return
    this.#relayPresence(parsed.data[0], parsed.data[1])
  }

  #relayPresence(signal: QuickAskSignal, companionId: string | null): void {
    this.#presenceTyping = signal === 'typing'
    this.#ctx.broadcast({ type: 'quick-ask-presence', signal, companionId })
  }

  #fail(code: VoiceErrorCode): void {
    this.#apply({ type: 'error', code })
  }

  #fix(): void {
    const code = this.#payload.error
    if (code === 'mic-blocked') {
      // From the permissions as they are now: macOS asks when it never has, else the right pane opens.
      void fixMicBlocked(this.#rt.broker(), this.#rt.blockedPane()).then((result) => {
        if (result === 'retry') void this.#listen()
        else if (result === 'opened') this.hide(false)
      })
      return
    }
    if (code === 'no-engine') openInAtelier(this.#ctx, 'atelier://settings/model')
    else if (code === 'another-recording') {
      const meetingId = this.#rt.recordingMeeting()
      if (meetingId) openInAtelier(this.#ctx, `atelier://meetings/${meetingId}`)
    } else if (this.#payload.screenshotBlocked) return void this.#fixScreen()
    else return void this.#listen()
    this.hide(false)
  }

  #apply(e: LauncherEvent): void {
    const next = reduceLauncher(this.#payload, e)
    if (next === this.#payload) return
    this.#payload = next
    if (this.#open) this.#ctx.float.update('launcher', next)
  }
}
