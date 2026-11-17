/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { DESKTOP_CALL_APPS } from '@shared/desktopCalls'
import {
  CARD_ACTIONS,
  cardPermissionBody,
  WRAP_UP_ACTIONS,
  detectMeeting,
  type CalendarEvent,
  type CalendarSource,
  type CardAction,
  type CardPayload,
  type MeetingCaptureServices,
  type MeetingRecorder,
  type RecordingPayload,
} from '@shared/meetingCapture'
import type { MeetingStore, MeetingSummarizer } from '@shared/meetings'
import { BUNDLE_ID } from '@shared/release'
import type { NotificationHandle } from '@shared/notifications'
import { SpeechError, encodeSpeechError, type SpeechBroker, type SpeechErrorCode } from '@shared/speech'
import { chatUrl, parseInternalUrl } from '@shared/url'
import type { AppContext, WindowContext } from '../../features/types'
import type { FloatManager } from '../../float/manager'
import { mainT } from '../../i18n/mainT'
import { log } from '../../log'
import { notifications } from '../../notifications'
import { onSessionEnd } from '../../system/sessionEnd'
import type { Tab } from '../../tabs'
import { CALENDAR_LEAD_MS, CardQueue, appCardFor, appMutePatch, calendarCardsFor, callKey, continueCard, mutePatch, siteCardFor, type CardEntry } from './cards'
import { CALL_EVENT_AHEAD_MS, CALL_TIMING, DesktopCallWatcher, SMOKE_CALL_TIMING, calendarEventForCall, callTitle, type DesktopCall } from './desktopCalls'
import { quitSaver } from './quitSave'
import { CONTINUE_COUNTDOWN_MS, Recorder } from './recorder'
import { SeenKeys } from './seen'
import { WidgetVisibility, originInView, widgetWanted, type OriginView } from './widget'
import { fixScreenBlocked } from '../../voice/apexNav'

// Meeting capture's entry point: meeting detection on `navigated`,
// the meeting-card queue (MV-09), the recorder, and the recording widget
// with its wrap-up (MV-10, MV-11). The card and widget are floats; their
// buttons arrive as 'card:action' and 'wrapup:action', validated here.

export interface MeetingCaptureSetup {
  recorder: MeetingRecorder
  services: MeetingCaptureServices
  /** Feature.window: navigations, tab switches and focus changes in one window. */
  attachWindow(win: WindowContext): void
  dispose(): void
}

let calendar: CalendarSource | null = null

/** The apps feature (apps/feature.ts) supplies the Calendar helper's source; null turns the calendar card and alert off. */
export function setCalendarSource(source: CalendarSource | null): void {
  calendar = source
}

/** The current calendar source, for the card queue. */
export function calendarSource(): CalendarSource | null {
  return calendar
}

let desktopWatcher: DesktopCallWatcher | null = null

/** Whether this Mac can spot calls in desktop apps (Settings › Transcription); null until the helper has said. */
export function desktopCallsSupported(): boolean | null {
  return desktopWatcher?.supported() ?? null
}

/** Apex's own bundle id (electron-builder's appId); its helpers and the speech helper share the prefix. */
const OWN_BUNDLE = BUNDLE_ID

const CALENDAR_POLL_MS = 60_000
/** The widget's view is also rechecked on this beat while recording, for changes no event reports. */
const VIEW_POLL_MS = 1500

/** What the smoke checks reach (APEX_SMOKE only). */
export interface CaptureSmokeHooks {
  recorder: Recorder
  float: FloatManager
  card(): CardEntry | null
  widget(): RecordingPayload
  widgetShown(): boolean
  cardAction(action: CardAction): Promise<void>
  /** Queues a card as a trigger would (the screenshot tour). */
  offerCard(payload: CardPayload): void
  /** Desktop calls: the watcher (feed snapshots through the fake helper or directly). */
  calls: DesktopCallWatcher
}

/** The longest a quit waits for a running recording to be saved: the broker's own limit for a stop (merging a long call's audio takes a while). */
const QUIT_SAVE_MS = 120_000

let smokeHooks: CaptureSmokeHooks | null = null

export function captureSmokeHooks(): CaptureSmokeHooks | null {
  return smokeHooks
}

const cardArgs = z.tuple([z.enum(CARD_ACTIONS)]).or(z.tuple([z.enum(CARD_ACTIONS), z.string().max(64)]))
const wrapArgs = z.tuple([z.enum(WRAP_UP_ACTIONS)]).or(z.tuple([z.enum(WRAP_UP_ACTIONS), z.string().min(1).max(64)]))

function errorText(err: unknown): string {
  const code: SpeechErrorCode | null = err instanceof SpeechError ? err.code : null
  if (code === 'mic-denied') return mainT('capture.error.micDenied')
  if (code === 'speech-denied') return mainT('capture.error.speechDenied')
  if (code === 'busy') return mainT('capture.error.busy')
  if (code === 'helper-missing' || code === 'unsupported-platform' || code === 'helper-outdated') return mainT('capture.error.unavailable')
  return mainT('capture.error.failed')
}

export function setupMeetingCapture(ctx: AppContext, deps: { broker: SpeechBroker; store: MeetingStore; summarizer: MeetingSummarizer }): MeetingCaptureSetup {
  const { float } = ctx
  const seen = new SeenKeys(join(ctx.dataDir, 'meeting-cards.json'))
  const cleanups: Array<() => void> = []

  // Desktop calls (see below), declared first: the recorder's status listener clears them.
  /** The desktop call the running recording was started for: its end wraps the recording up. */
  let recordingCall: { callId: string; meetingId: string } | null = null
  let callNote: { entryId: string; handle: NotificationHandle } | null = null
  const clearCallNote = (entryId?: string): void => {
    if (!callNote || (entryId && callNote.entryId !== entryId)) return
    callNote.handle.clear()
    callNote = null
  }

  // ── where Apex is ──

  const focusedWindow = (): WindowContext | null =>
    ctx.windows.all().find((w) => !w.window.isDestroyed() && w.window.isVisible() && !w.window.isMinimized() && w.window.isFocused()) ?? null
  const appHidden = (): boolean => process.platform === 'darwin' && app.isHidden()
  const appInView = (): boolean => !appHidden() && focusedWindow() !== null

  const currentView = (): OriginView => {
    const win = focusedWindow()
    if (!win) return { appHidden: appHidden(), window: null }
    const split = win.tabs.split()
    return {
      appHidden: appHidden(),
      window: {
        activeTabId: win.tabs.activeId(),
        splitTabIds: split ? [split.primaryId, split.secondaryId] : [],
        railUrl: win.tabs.rail(),
        activeInternalUrl: win.tabs.active()?.internalUrl ?? null,
        hasTab: (id) => Boolean(win.tabs.find(id)),
      },
    }
  }

  /** Brings Apex forward with `url` (an apex:// page) in the focused or first window. */
  const openPage = (url: string): void => {
    const win = ctx.windows.focused()
    if (!win || win.window.isDestroyed()) return
    try {
      win.tabs.openInternal(url)
    } catch (err) {
      log.warn('meeting-capture', 'Opening a page failed', { error: String(err) })
      return
    }
    if (win.window.isMinimized()) win.window.restore()
    win.window.show()
    win.window.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  }

  /** Opens a web address (a calendar meeting's link) in a new foreground tab; resolves to the tab. */
  const openWeb = (url: string): Tab | null => {
    const win = ctx.windows.focused()
    if (!win || win.window.isDestroyed()) return null
    const tab = win.tabs.create(url, { activate: true })
    if (win.window.isMinimized()) win.window.restore()
    win.window.show()
    win.window.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
    return tab
  }

  // ── the recorder ──

  const recorder = new Recorder({
    broker: deps.broker,
    store: deps.store,
    summarizer: deps.summarizer,
    transcription: () => ctx.settings.get().transcription,
    systemLocale: () => app.getSystemLocale() || 'en-US',
    appInView,
    notify: (n) => ctx.notify({ category: 'meetings', ...n }),
    transcribed: () => ctx.signal('meeting-transcribed'),
    smoke: ctx.smoke,
    warn: (message, data) => log.warn('meeting-capture', message, data),
  })

  // ── the meeting card (MV-09) ──

  let hidingCard = false
  const queue = new CardQueue({
    show: (entry) => float.open('meeting-card', entry.payload),
    hide: () => {
      hidingCard = true
      try {
        float.close('meeting-card')
      } finally {
        hidingCard = false
      }
    },
  })

  const offerContinue = (reason: 'long' | 'silent'): void => {
    queue.offer({ payload: continueCard(reason, CONTINUE_COUNTDOWN_MS, mainT('capture.card.continueTitle')), tabId: null, url: null, key: null })
  }
  recorder.on('ask', (question) => {
    if (question) offerContinue(question.reason)
    else queue.withdraw((e) => e.payload.mode === 'continue')
  })

  const startFromCard = async (entry: CardEntry, withUrl: boolean): Promise<void> => {
    if (entry.call) return startCall(entry, entry.call)
    let tabId = entry.tabId
    let url = entry.url
    // A calendar card joins the meeting first; its own site card is then already seen.
    if (withUrl && url) {
      const meeting = detectMeeting(url, { smoke: ctx.smoke })
      if (meeting) seen.add(meeting.key)
      tabId = openWeb(url)?.id ?? null
    } else if (entry.payload.mode === 'calendar') {
      url = null
    }
    try {
      await recorder.start({ kind: 'meeting', tabId: tabId ?? undefined, url: url ?? undefined, title: entry.payload.title || undefined, ...(entry.payload.audioOnly ? { audioOnly: true } : {}) })
    } catch (err) {
      log.warn('meeting-capture', 'Starting from the meeting card failed', { error: err instanceof Error ? err.message : String(err) })
      ctx.notify({ category: 'meetings', title: mainT('capture.notify.startFailedTitle'), body: errorText(err), target: 'apex://settings/transcription' })
    }
  }

  const cardAction = async (action: CardAction, cardId?: string): Promise<void> => {
    const entry = queue.current()
    if (!entry || (cardId && cardId !== entry.payload.id)) return
    // Answered here, so its notification has nothing left to ask.
    if (entry.call) clearCallNote(entry.id)
    const close = (): void => float.close('meeting-card')
    switch (action) {
      case 'record':
        close()
        await startFromCard(entry, entry.payload.mode === 'calendar')
        return
      case 'join-only':
        close()
        if (entry.payload.mode === 'calendar' && entry.url) {
          const meeting = detectMeeting(entry.url, { smoke: ctx.smoke })
          if (meeting) seen.add(meeting.key)
          openWeb(entry.url)
        }
        return
      case 'settings':
      case 'setup':
        close()
        openPage('apex://settings/transcription')
        return
      case 'continue':
        close()
        recorder.answer('continue')
        return
      case 'stop':
        close()
        recorder.answer('stop')
        return
      case 'dismiss':
        close()
        // Dismissing the question keeps the recording going.
        if (entry.payload.mode === 'continue') recorder.answer('continue')
        return
      case 'dont-show-again':
      case 'mute-kind':
      case 'mute-site':
      case 'mute-all':
      case 'mute-app': {
        const appPatch = appMutePatch(action, entry.payload, ctx.settings.get().transcription)
        const patch = appPatch ? null : mutePatch(action, entry.payload, ctx.settings.get().meetingCards)
        if (appPatch) ctx.settings.update({ transcription: appPatch })
        else if (patch) ctx.settings.update({ meetingCards: patch })
        close()
        return
      }
    }
  }

  cleanups.push(
    float.handle('card:action', async (_kind, args) => {
      const parsed = cardArgs.safeParse(args)
      if (!parsed.success) throw new Error('Unknown card action.')
      await cardAction(parsed.data[0], parsed.data[1])
    }),
  )

  const onFloatClosed = (kind: string): void => {
    if (kind === 'meeting-card' && !hidingCard) queue.done()
    if (kind === 'recording' && !hidingWidget) {
      // Closed from inside (its error card): the wrap-up goes, and the widget waits for the next change.
      recorder.dismissWrapUp()
      visibility.update(false, true)
    }
  }
  float.on('closed', onFloatClosed)
  cleanups.push(() => float.off('closed', onFloatClosed))

  // ── the widget and wrap-up (MV-10, MV-11) ──

  const payload = (): RecordingPayload => ({ status: recorder.status(), wrapUp: recorder.wrapUp() })
  let hidingWidget = false
  const visibility = new WidgetVisibility((show) => {
    if (show) float.open('recording', payload())
    else {
      hidingWidget = true
      try {
        float.close('recording')
      } finally {
        hidingWidget = false
      }
    }
  })

  const recheck = (immediate = false): void => {
    const status = recorder.status()
    const wanted = widgetWanted({ state: status.state, originInView: originInView(status.origin, currentView(), (url) => parseInternalUrl(url)?.page === 'meetings'), wrapUp: recorder.wrapUp() !== null })
    visibility.update(wanted, immediate)
  }

  let viewPoll: ReturnType<typeof setInterval> | null = null
  recorder.on('status', (status) => {
    ctx.broadcast({ type: 'meeting-capture', status })
    if (float.isOpen('recording')) float.update('recording', payload())
    recheck(status.state === 'idle')
    const running = recorder.isLive()
    if (running && !viewPoll) {
      viewPoll = setInterval(() => recheck(), VIEW_POLL_MS)
      viewPoll.unref?.()
    } else if (!running && viewPoll) {
      clearInterval(viewPoll)
      viewPoll = null
    }
    // Nothing to suggest while recording, and nothing to continue once it ends.
    if (running) {
      queue.withdraw((e) => e.payload.mode === 'site' || e.payload.mode === 'calendar' || e.payload.mode === 'permissions' || e.payload.mode === 'app')
      clearCallNote()
    } else queue.withdraw((e) => e.payload.mode === 'continue')
    if (status.state === 'idle') recordingCall = null
  })
  // The wrap-up appears and goes at once; only the live widget waits out the debounce.
  recorder.on('wrap-up', () => {
    if (float.isOpen('recording')) float.update('recording', payload())
    recheck(true)
  })
  recorder.on('level', (level) => {
    if (float.isOpen('recording')) float.send('recording', { type: 'level', ...level })
  })

  // The widget's mic-only icon: ask for Screen Recording, open its pane, or relaunch once it's on.
  cleanups.push(float.handle('recording:fix-screen', async () => void (await fixScreenBlocked())))
  // Its audio-only icon (this Mac couldn't transcribe): Settings › Transcription says why and how.
  cleanups.push(float.handle('recording:transcription-settings', async () => openPage('apex://settings/transcription')))

  // Quitting mid-recording saves it first (quitSave.ts). Prepended here, so it runs after the
  // private-chat question (prepended later, in startCore) and before every other listener: the
  // widget stays up to show "Finishing…", and features are still there. An update marks the
  // windows quitting and stops the recording itself first.
  const holdQuit = quitSaver({
    live: () => recorder.isLive(),
    stop: () => recorder.stop(),
    updating: () => ctx.windows.quitting,
    quit: () => {
      // A private chat's question was answered already, and closing windows now isn't "recently closed".
      ctx.windows.setQuitting(true)
      app.quit()
    },
    timeoutMs: QUIT_SAVE_MS,
    warn: (message, data) => log.warn('meeting-capture', message, data),
  })
  app.prependListener('before-quit', holdQuit)
  cleanups.push(() => app.off('before-quit', holdQuit))
  // Windows shutting down or signing out sends no before-quit: the save starts, and what the helper
  // can't finish before Windows ends it is put back together on the next start (the library's recovery).
  cleanups.push(
    onSessionEnd(() => {
      if (recorder.isLive()) void recorder.stop().catch((err: unknown) => log.warn('meeting-capture', 'Saving the recording as Windows ended the session failed', { error: String(err) }))
    }),
  )
  cleanups.push(
    float.handle('wrapup:action', async (_kind, args) => {
      const parsed = wrapArgs.safeParse(args)
      if (!parsed.success) throw new Error('Unknown wrap-up action.')
      const [action, arg] = parsed.data
      const wrap = recorder.wrapUp()
      if (!wrap) return
      switch (action) {
        case 'discuss':
          // The float started the chat through meetings.discuss; `arg` is its id.
          if (arg) openPage(chatUrl(arg))
          break
        case 'view-summary':
          openPage(`apex://meetings/${wrap.meetingId}`)
          break
        case 'open-meetings':
          openPage('apex://meetings')
          break
        case 'dismiss':
          break
      }
      recorder.dismissWrapUp()
    }),
  )


  const pollCalendar = async (): Promise<void> => {
    const source = calendar
    if (!source) return
    const speech = (() => {
      try {
        return deps.broker.status()
      } catch {
        return null
      }
    })()
    let events
    try {
      events = await source.upcoming(CALENDAR_LEAD_MS + CALENDAR_POLL_MS)
    } catch (err) {
      log.debug('meeting-capture', 'The calendar had no answer', { error: String(err) })
      return
    }
    for (const due of calendarCardsFor(events, { now: Date.now(), recording: recorder.isLive(), available: speech?.available ?? false, seen: (k) => seen.has(k), settings: ctx.settings.get() })) {
      seen.add(due.key)
      queue.offer({ payload: due.payload, tabId: null, url: due.event.url, key: due.key })
    }
  }
  const calendarTimer = setInterval(() => void pollCalendar(), CALENDAR_POLL_MS)
  calendarTimer.unref?.()
  cleanups.push(() => clearInterval(calendarTimer))

  // ── calls in desktop apps ──

  const startCall = async (entry: CardEntry, call: NonNullable<CardEntry['call']>): Promise<void> => {
    clearCallNote()
    try {
      const id = await recorder.start({ kind: 'meeting', title: entry.payload.title || undefined, call: { app: call.app, audio: call.audio }, ...(entry.payload.audioOnly ? { audioOnly: true } : {}) })
      recordingCall = { callId: call.id, meetingId: id }
      // The call ended while the recording started: wrap up straight away.
      if (!desktop.calls().some((c) => c.id === call.id)) await recorder.stop()
    } catch (err) {
      log.warn('meeting-capture', 'Taking notes on a desktop call failed', { error: err instanceof Error ? err.message : String(err) })
      ctx.notify({ category: 'meetings', title: mainT('capture.notify.startFailedTitle'), body: errorText(err), target: 'apex://settings/transcription' })
    }
  }

  /** The notification's Take notes: the card's own action when it is in front, or straight from the queue. */
  const takeNotes = async (entryId: string): Promise<void> => {
    if (queue.current()?.id === entryId) return cardAction('record', entryId)
    const waiting = queue.waiting().find((e) => e.id === entryId)
    if (!waiting) return
    queue.withdraw((e) => e.id === entryId)
    await startFromCard(waiting, false)
  }

  /** The card's twin as a system notification, for when Apex isn't in front (the presenter skips it otherwise). */
  const notifyCall = (entry: CardEntry): void => {
    clearCallNote()
    const card = entry.payload
    const canRecord = card.mode === 'app' || card.canRecord === true
    const handle = notifications.notify({
      category: 'meetings',
      title: mainT(card.audioOnly ? 'capture.card.appPromptAudio' : 'capture.card.appPrompt', { title: card.title }),
      body: card.mode === 'app' ? mainT(card.audioOnly ? 'capture.notify.callAudioBody' : 'capture.notify.callBody') : canRecord ? mainT(cardPermissionBody(card)) : mainT('capture.card.permissionsTitle'),
      target: canRecord ? {} : { url: 'apex://settings/transcription' },
      ...(canRecord ? { actions: [card.audioOnly ? ('record' as const) : ('take-notes' as const)] } : {}),
      onAction: (action) => {
        if (action === 'take-notes' || action === 'record') void takeNotes(entry.id).catch((err: unknown) => log.warn('meeting-capture', 'Take notes failed', { error: String(err) }))
      },
    })
    callNote = { entryId: entry.id, handle }
  }

  const offerCall = async (call: DesktopCall): Promise<void> => {
    if (recorder.isLive()) return
    let available = false
    try {
      available = deps.broker.status().available
    } catch {
      available = false
    }
    if (!available) return
    let event: CalendarEvent | null = null
    const source = calendar
    if (source) {
      try {
        event = calendarEventForCall(await source.upcoming(CALL_EVENT_AHEAD_MS), { now: Date.now(), provider: DESKTOP_CALL_APPS[call.app].provider })
      } catch (err) {
        log.debug('meeting-capture', 'The calendar had no answer for a call', { error: String(err) })
      }
    }
    const permissions = await deps.broker.permissions().catch(() => null)
    // It may have ended while Apex looked.
    if (!desktop.calls().some((c) => c.id === call.id)) return
    const card = appCardFor({
      app: call.app,
      callId: call.id,
      title: callTitle(call.app, event, (name) => mainT('capture.app.callTitle', { app: name })),
      eventStartsAt: event?.startsAt ?? null,
      recording: recorder.isLive(),
      available,
      permissions,
      seen: (k) => seen.has(k),
      settings: ctx.settings.get(),
    })
    if (!card) return
    // A call's id never comes back, so its key stays in memory only.
    seen.add(card.key, { private: true })
    if (event) {
      // The calendar card for the same meeting would only repeat this one.
      const key = `calendar:${event.id}`
      seen.add(key)
      queue.withdraw((e) => e.key === key)
    }
    const entry = queue.offer({ payload: card.payload, tabId: null, url: null, key: card.key, call: { id: call.id, app: call.app, audio: call.audio } })
    notifyCall(entry)
  }

  const onCallEnded = (call: DesktopCall): void => {
    const key = callKey(call.id)
    const entry = [queue.current(), ...queue.waiting()].find((e) => e?.key === key)
    if (entry) clearCallNote(entry.id)
    queue.withdraw((e) => e.key === key)
    if (recordingCall?.callId === call.id && recorder.isLive()) {
      recordingCall = null
      void recorder.stop().catch((err: unknown) => log.warn('meeting-capture', 'Wrapping up a desktop call failed', { error: String(err) }))
    }
  }

  const ownPids = (): Set<number> => {
    const pids = new Set<number>([process.pid])
    try {
      for (const m of app.getAppMetrics()) pids.add(m.pid)
    } catch {
      // Metrics aren't there before ready; the bundle id still covers the packaged app.
    }
    return pids
  }

  const desktop = new DesktopCallWatcher({
    broker: deps.broker,
    enabled: () => (ctx.smoke || process.platform === 'darwin') && ctx.settings.get().transcription.alertDesktopCalls,
    own: () => ({ ownPids: ownPids(), ownBundles: [OWN_BUNDLE] }),
    started: (call) => void offerCall(call).catch((err: unknown) => log.warn('meeting-capture', 'Offering notes for a call failed', { error: String(err) })),
    ended: onCallEnded,
    timing: ctx.smoke ? SMOKE_CALL_TIMING : CALL_TIMING,
  })
  desktopWatcher = desktop
  const onSettings = (): void => desktop.sync()
  ctx.settings.on('changed', onSettings)
  cleanups.push(() => {
    ctx.settings.off('changed', onSettings)
    clearCallNote()
    desktop.dispose()
    if (desktopWatcher === desktop) desktopWatcher = null
  })

  // ── meeting sites (MV-09) ──

  const onNavigated = async (win: WindowContext, tab: Tab, url: string): Promise<void> => {
    const meeting = detectMeeting(url, { smoke: ctx.smoke })
    // A tab that left its meeting takes its card with it.
    queue.withdraw((e) => e.tabId === tab.id && e.key !== (meeting?.key ?? null) && (e.payload.mode === 'site' || e.payload.mode === 'permissions'))
    if (!meeting || tab.agentControlled || recorder.isLive() || seen.has(meeting.key)) return
    let available = false
    try {
      available = deps.broker.status().available
    } catch {
      available = false
    }
    const permissions = available ? await deps.broker.permissions().catch(() => null) : null
    const card = siteCardFor({
      url,
      agentControlled: tab.agentControlled,
      recording: recorder.isLive(),
      available,
      permissions,
      seen: (k) => seen.has(k),
      settings: ctx.settings.get(),
      smoke: ctx.smoke,
    })
    if (!card) return
    seen.add(card.key, { private: win.kind === 'private' })
    queue.offer({ payload: card.payload, tabId: tab.id, url, key: card.key })
  }

  const attachWindow = (win: WindowContext): void => {
    win.tabs.on('navigated', (tab, nav) => {
      if (nav.mainFrame) void onNavigated(win, tab, nav.url).catch((err: unknown) => log.warn('meeting-capture', 'Checking a navigation failed', { error: String(err) }))
    })
    win.tabs.on('closed', (tab) => {
      queue.withdraw((e) => e.tabId === tab.id && e.payload.mode !== 'continue')
      recheck()
    })
    win.tabs.on('activated', () => recheck())
    win.tabs.on('changed', () => {
      // The agent taking over a tab withdraws its card.
      queue.withdraw((e) => e.tabId !== null && win.tabs.find(e.tabId)?.agentControlled === true)
      recheck()
    })
    const onWindow = (): void => recheck()
    win.window.on('focus', onWindow)
    win.window.on('blur', onWindow)
    win.window.on('minimize', onWindow)
    win.window.on('restore', onWindow)
    win.window.on('show', onWindow)
    win.window.on('hide', onWindow)
  }

  const onAppActive = (): void => recheck()
  app.on('did-become-active', onAppActive)
  app.on('did-resign-active', onAppActive)
  cleanups.push(() => {
    app.off('did-become-active', onAppActive)
    app.off('did-resign-active', onAppActive)
  })

  if (ctx.smoke) {
    smokeHooks = {
      recorder,
      float,
      card: () => queue.current(),
      widget: payload,
      widgetShown: () => visibility.shown(),
      cardAction: (action) => cardAction(action),
      offerCard: (card) => {
        queue.offer({ payload: card, tabId: null, url: null, key: null })
      },
      calls: desktop,
    }
  }

  const services: MeetingCaptureServices = {
    meetingCapture: {
      status: () => recorder.status(),
      // A speech failure crosses tagged with its code, so the meetings page can offer its fix.
      start: (o) => recorder.start(o).catch((err: unknown) => Promise.reject(err instanceof SpeechError ? new Error(encodeSpeechError(err)) : err)),
      stop: () => recorder.stop(),
      pause: () => recorder.pause('user'),
      resume: () => recorder.resume('user'),
    },
  }

  return {
    recorder,
    services,
    attachWindow,
    dispose: () => {
      for (const fn of cleanups.splice(0)) fn()
      if (viewPoll) clearInterval(viewPoll)
      visibility.dispose()
      recorder.dispose()
      smokeHooks = null
    },
  }
}

