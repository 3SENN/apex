/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import {
  ipcMain,
  systemPreferences,
  type IpcMainEvent,
  type MediaAccessPermissionRequest,
  type OpenExternalPermissionRequest,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron'
import { PAGE } from '@shared/ipc'
import type { OverlayResult } from '@shared/overlay'
import type { PermissionPromptProps } from '@shared/overlay/sites'
import {
  DEVICE_PERMISSIONS,
  QUERY_NAMES,
  QUIET_TIMEOUT_MS,
  asksQuietly,
  canRemember,
  classifyPermission,
  frameScope,
  oneOffAnswer,
  oneOffKey,
  promptKey,
  queryState,
  rememberable,
  secureEnough,
  siteKey,
  siteVerdict,
  type QueryState,
  type QueryStates,
} from '@shared/permissions'
import type { AppEvent } from '@shared/services'
import type { PermissionActivity as SharedPermissionActivity, SitePermission } from '@shared/sites'
import type { Perm } from '@shared/speech'
import { originOf } from '@shared/url'
import type { CaptureTracker } from './capture'
import { describeExternal, externalDecision, rememberExternal } from './externalApps'
import type { SessionInfo } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { PermissionHistory, historyFileFor } from './permissionHistory'
import { permissionPolicy } from './permissionPolicy'
import { PromptQueue, type PromptAnswer, type PromptHandle, type QueuedPrompt } from './promptQueue'
import { presentSurface, siteButtonAnchor, windowOfTab } from './siteOverlay'
import { sites } from './sites'
import type { TabRegistry } from './tabRegistry'
import type { Tab } from './tabs'
import type { WindowManager } from './windows'

// Web permissions on every browsing session (OV-10 to OV-12).
// Registered overrides answer first, then the policy table in
// shared/permissions.ts. A request is the top-level page's question, as in
// Chrome: a same-origin frame asks as the page, a cross-origin frame only for
// what its permission policy delegated, and a popup through its opener's tab.
// Asks consult the site's stored answer, the tab's one-off answers, the
// profile's defaults and the embargo, then macOS, then show the anchored
// prompt (or, for notifications, a quiet chip). A request on a tab the agent
// controls is refused at once, and the agent hears why. What the check
// handler can't say (never asked is 'prompt', not 'denied') reaches the page
// through PAGE.permissions (preload/page/permissionStatus.ts).

export interface PermissionDeps {
  windows: WindowManager
  tabsRegistry: TabRegistry
  /** AgentHost.noteForNextResult (OV-12). */
  noteForAgent(tabId: string, text: string): void
  capture: CaptureTracker
  broadcast(event: AppEvent): void
  /** Smoke runs never ask macOS for camera or microphone access. */
  smoke: boolean
  /** The profile's site permission defaults and quiet notification prompts. */
  settings?(): { sitePermissionDefaults?: Partial<Record<SitePermission, 'ask' | 'block'>>; quietNotificationPrompts?: boolean }
  /** Location Services for Apex, from the speech helper; undefined is unknown, which blocks nothing. */
  systemLocation?(): Promise<Perm | undefined>
  /** The page that opened a popup (popups.ts), so the popup asks through its opener's tab. */
  openerOf?(wc: WebContents): WebContents | null
}

type PromptProps = PermissionPromptProps
type SystemBlocked = PromptProps['systemBlocked'][number]

/** Where a request is asked: the tab (a popup's opener tab), and the site it is keyed on. */
interface Scope {
  tab: Tab
  popup: boolean
  key: string
  embedded: string | null
}

interface QuietRequest {
  origin: string
  waiters: ((answer: PromptAnswer | null) => void)[]
  timer: ReturnType<typeof setTimeout>
}

const MEDIA = new Set<SitePermission>(['camera', 'microphone'])
/** Silent for people, never for the agent (OV-12). */
const AGENT_REFUSED = new Set(['fullscreen', 'automatic-fullscreen', 'openExternal'])
const DISMISSED: PromptAnswer = { allow: false, remember: false, dismissed: true }
/** How long a location request waits for the speech helper's Location Services report. */
const LOCATION_WAIT_MS = 1500

/** A request that was refused or held back without a prompt, for the address bar's chips and site info (shared/sites.ts). */
export type PermissionActivity = SharedPermissionActivity

// The controller is made once in features/sites.ts; these module functions
// reach it so the address bar, site info and the sharing bar need no handle.
let active: PermissionController | null = null
const activityListeners = new Set<(a: PermissionActivity) => void>()

export function onPermissionActivity(fn: (a: PermissionActivity) => void): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

/** This page load's activity for a tab; cleared on navigation. */
export function tabPermissionActivity(tabId: string): PermissionActivity[] {
  return active?.activity(tabId) ?? []
}

/** Answers a quiet (chip) notification request. */
export function answerQuietRequest(tabId: string, permission: SitePermission, allow: boolean): void {
  active?.answerQuiet(tabId, permission, allow)
}

/** Permissions granted for this tab only (not remembered). */
export function oneTimeGrants(tabId: string): SitePermission[] {
  return active?.oneTimeGrants(tabId) ?? []
}

function emitActivity(a: PermissionActivity): void {
  for (const fn of activityListeners) {
    try {
      fn(a)
    } catch (err) {
      log.warn('sites', 'A permission activity listener failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export class PermissionController {
  readonly prompts: PromptQueue<PromptProps>
  readonly #deps: PermissionDeps
  /** One-off answers last the tab's session: tab id → "origin|permission" → allowed. */
  readonly #oneOff = new Map<string, Map<string, boolean>>()
  readonly #private = new WeakSet<Session>()
  readonly #sessions = new WeakSet<Session>()
  /** This page load's refused or held-back requests: tab id → activity. */
  readonly #activity = new Map<string, PermissionActivity[]>()
  /** Quiet notification requests waiting on the chip: "tabId|permission" → request. */
  readonly #quiet = new Map<string, QuietRequest>()
  /** Prompt history (dismissals, embargo) per site store, held weakly so a closed private window's goes with it; the memory one serves sessions without a store. */
  readonly #histories = new WeakMap<object, PermissionHistory>()
  readonly #historyRefs = new Set<WeakRef<PermissionHistory>>()
  readonly #memoryHistory = new PermissionHistory(null)
  /** The origin whose stored answer this controller is writing, so its own write doesn't clear the history. */
  #selfWrite: string | null = null
  #ipcReady = false

  constructor(deps: PermissionDeps) {
    this.#deps = deps
    this.prompts = new PromptQueue((prompt) => this.#present(prompt))
    active = this
  }

  install(session: Session, info: SessionInfo): void {
    if (info.private) this.#private.add(session)
    this.#sessions.add(session)
    session.setPermissionRequestHandler((wc, permission, callback, details) => {
      this.#request(session, wc, permission, details).then(callback, (err: unknown) => {
        log.warn('sites', 'Permission request failed; refused', { permission, error: err instanceof Error ? err.message : String(err) })
        callback(false)
      })
    })
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => this.#check(session, wc, permission, requestingOrigin, details))
    if (!this.#ipcReady && ipcMain) {
      this.#ipcReady = true
      ipcMain.on(PAGE.permissions, (event) => this.#onStatesAsked(event))
    }
  }

  isPrivate(session: Session): boolean {
    return this.#private.has(session)
  }

  activity(tabId: string): PermissionActivity[] {
    return [...(this.#activity.get(tabId) ?? [])]
  }

  /** The chip's Allow or Block for a quiet notification request; it is kept for the site where it can be. */
  answerQuiet(tabId: string, permission: SitePermission, allow: boolean): void {
    const list = this.#activity.get(tabId)
    if (list) this.#activity.set(tabId, list.filter((a) => !(a.permission === permission && a.outcome === 'quiet')))
    const answer: PromptAnswer = { allow, remember: true }
    const id = quietId(tabId, permission)
    // A waiting request takes the answer and records it as it settles.
    if (this.#quiet.has(id)) return this.#endQuiet(id, answer)
    // Nothing is waiting (it timed out): the answer still stands for the page's next request.
    const tab = this.#deps.tabsRegistry.get(tabId)
    const wc = tab?.view.webContents
    if (!tab || !wc || wc.isDestroyed()) return
    const key = siteKey(wc.getURL())
    if (key) this.#settle(wc.session, tabId, key, [permission], answer)
  }

  /** What this tab was allowed for its current site, this time only. */
  oneTimeGrants(tabId: string): SitePermission[] {
    const wc = this.#deps.tabsRegistry.get(tabId)?.view.webContents
    const key = wc && !wc.isDestroyed() ? siteKey(wc.getURL()) : null
    if (!key) return []
    const out: SitePermission[] = []
    for (const [k, allowed] of this.#oneOff.get(tabId) ?? []) if (allowed && k.startsWith(`${key}|`)) out.push(k.slice(key.length + 1) as SitePermission)
    return out
  }

  /** Takes back one permission this tab was allowed for its current site, this time only; the site asks again next time. */
  revokeOneTime(tabId: string, perm: SitePermission): void {
    const wc = this.#deps.tabsRegistry.get(tabId)?.view.webContents
    const key = wc && !wc.isDestroyed() ? siteKey(wc.getURL()) : null
    if (key) this.#oneOff.get(tabId)?.delete(`${key}|${perm}`)
  }

  /** The tab loaded a new page: its activity starts over and quiet requests end. */
  navigated(tabId: string): void {
    this.#activity.delete(tabId)
    this.#endQuietOf(tabId)
  }

  /** A tab closed: its prompts end and its one-off answers go. */
  forgetTab(tabId: string): void {
    this.prompts.cancelTab(tabId)
    this.#oneOff.delete(tabId)
    this.#activity.delete(tabId)
    this.#endQuietOf(tabId)
  }

  /** A site's stored answers changed (site info, the sharing bar's Revoke): its one-off answers and prompt history go too, so it asks again. */
  forgetOrigin(origin: string): void {
    for (const answers of this.#oneOff.values()) {
      for (const key of answers.keys()) if (key.startsWith(`${origin}|`)) answers.delete(key)
    }
    if (this.#selfWrite !== origin) {
      for (const ref of [...this.#historyRefs]) {
        const history = ref.deref()
        if (history) history.forget(origin)
        else this.#historyRefs.delete(ref)
      }
      this.#memoryHistory.forget(origin)
    }
    this.#pushStates(origin)
  }

  /** The profile's defaults changed: pages read their permission states again. */
  refresh(): void {
    this.#pushStates(null)
  }

  /** The agent took control of a tab: an open prompt closes, refused (OV-12). */
  agentTookOver(tab: Tab): void {
    this.#endQuietOf(tab.id)
    const pending = this.prompts.pending().filter((p) => p.tabId === tab.id)
    if (pending.length === 0) return
    this.prompts.cancelTab(tab.id)
    this.noteAgent(tab, tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL(), null)
  }

  /** Tells the agent a request on its tab was refused and a person must take over (OV-12). */
  noteAgent(tab: Tab, originOrUrl: string, perms: readonly SitePermission[] | 'fullscreen' | null): void {
    const host = hostOf(originOrUrl)
    const what = perms === 'fullscreen' ? mainT('sites.ask.fullscreen') : perms && perms.length > 0 ? describePerms(perms) : mainT('sites.ask.external-app')
    try {
      this.#deps.noteForAgent(tab.id, mainT('sites.agent.denied', { host, what }))
    } catch (err) {
      // Without the note, the refusal still stands.
      log.debug('sites', 'Could not note a refused request for the agent', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async #request(session: Session, wc: WebContents, permission: string, details: unknown): Promise<boolean> {
    const d = (details ?? {}) as Partial<MediaAccessPermissionRequest & OpenExternalPermissionRequest>
    const requestingUrl = d.requestingUrl || (wc.isDestroyed() ? '' : wc.getURL())
    const origin = originOf(requestingUrl)
    const override = permissionPolicy.override({ origin, permission, session, webContents: wc })
    if (override) return override === 'allow'
    const externalURL = permission === 'openExternal' ? (d.externalURL ?? '') : ''
    const policy = classifyPermission(permission, { mediaTypes: d.mediaTypes, origin, url: externalURL })
    const who = wc.isDestroyed() ? null : this.#attribute(wc)
    if (policy.action === 'deny') return false
    if (policy.action === 'allow') {
      if (who?.tab.agentControlled && AGENT_REFUSED.has(permission)) {
        this.noteAgent(who.tab, origin, permission === 'openExternal' ? ['external-app'] : 'fullscreen')
        return false
      }
      return true
    }
    const perms = policy.perms
    // Peek, previews and other views without a tab have nowhere to ask; the check agrees.
    if (!who) return false
    const { tab } = who
    if (tab.agentControlled) {
      this.noteAgent(tab, origin, perms)
      return false
    }
    if (permission === 'openExternal') {
      // External links stay the asking frame's question, as Chrome's external protocol dialog has it.
      const key = siteKey(origin)
      return key ? this.#external(session, tab, key, externalURL) : false
    }
    const scope = this.#scope(who, wc, origin, d.isMainFrame === true, perms)
    if (!scope) return false
    const { key } = scope
    const embedded = scope.embedded ? hostOf(scope.embedded) : null
    const verdict = this.#verdict(session, tab.id, key, perms)
    if (verdict.verdict === 'block') {
      this.#noteAll(tab.id, key, perms, 'blocked')
      return false
    }
    // The screen picker is screen sharing's prompt; this only checks the site isn't blocked.
    if (permission === 'display-capture') return true

    // macOS turned Apex off: allowing the site would not help, even where it already is. Say so once per page, with the way back.
    const system = await this.#systemBlocked(perms)
    if (system.length > 0) {
      const told = system.every((p) => this.#hasActivity(tab.id, key, p, 'blocked-by-macos'))
      this.#noteAll(tab.id, key, system, 'blocked-by-macos')
      if (!told) await this.#ask(session, tab, key, perms, { app: null, scheme: null, systemBlocked: system, embedded })
      return false
    }

    let allowed = verdict.verdict === 'allow'
    if (!allowed) {
      const quiet = asksQuietly(perms, this.#settings().quietNotificationPrompts === true, this.#history(session).get(key, perms[0]!))
      const answer = quiet ? await this.#askQuietly(tab.id, key, perms[0]!) : await this.#ask(session, tab, key, perms, { app: null, scheme: null, systemBlocked: [], embedded })
      allowed = this.#settle(session, tab.id, key, perms, answer)
    }
    if (!allowed) return false
    const refused = await this.#systemAccess(perms)
    if (refused.length > 0) {
      this.#noteAll(tab.id, key, refused, 'blocked-by-macos')
      return false
    }
    const media = perms.filter((p): p is 'camera' | 'microphone' => MEDIA.has(p))
    if (media.length > 0) this.#deps.capture.grant(tab.id, media)
    return true
  }

  async #external(session: Session, tab: Tab, origin: string, url: string): Promise<boolean> {
    const link = describeExternal(url)
    // Nothing on this computer opens it, so there is nothing to ask about.
    if (!link?.app) return false
    const store = sites.storeFor(session)
    if (externalDecision(store, origin, link) === 'allow') return true
    if (this.#settings().sitePermissionDefaults?.['external-app'] === 'block') {
      this.#noteAll(tab.id, origin, ['external-app'], 'blocked')
      return false
    }
    const answer = await this.#ask(session, tab, origin, ['external-app'], { app: link.app, scheme: link.scheme, systemBlocked: [] })
    if (!answer?.allow) return false
    // External apps keep only an allow, and only when asked to.
    if (answer.remember && store?.persistent && !this.#private.has(session)) rememberExternal(store, origin, link.scheme)
    return true
  }

  /** What an answered (or put away) prompt leaves behind; true when the request may go on. */
  #settle(session: Session, tabId: string, origin: string, perms: readonly SitePermission[], answer: PromptAnswer | null): boolean {
    // Cancelled (its tab closed, moved on, or the agent took over): nothing is decided.
    if (!answer) return false
    const history = this.#history(session)
    if (answer.dismissed) {
      // Put away without an answer: the third time in a row blocks the question for a week.
      if (history.dismissed(origin, perms)) {
        this.#noteAll(tabId, origin, perms, 'blocked')
        this.#pushStates(origin)
      }
      return false
    }
    history.answered(origin, perms, answer.allow)
    this.#record(session, tabId, origin, perms, answer)
    if (!answer.allow) this.#noteAll(tabId, origin, perms, 'blocked')
    return answer.allow
  }

  #record(session: Session, tabId: string, origin: string, perms: readonly SitePermission[], answer: PromptAnswer): void {
    const store = sites.storeFor(session)
    if (answer.remember && store?.persistent && !this.#private.has(session) && canRemember(perms, answer.allow)) {
      this.#selfWrite = origin
      try {
        store.set(origin, { permissions: Object.fromEntries(perms.map((p) => [p, answer.allow ? 'allow' : 'block'])) })
      } finally {
        this.#selfWrite = null
      }
      return
    }
    let answers = this.#oneOff.get(tabId)
    if (!answers) this.#oneOff.set(tabId, (answers = new Map()))
    for (const p of perms) answers.set(oneOffKey(origin, p), answer.allow)
    this.#pushStates(origin)
  }

  #ask(session: Session, tab: Tab, origin: string, perms: SitePermission[], extra: Pick<PromptProps, 'app' | 'scheme' | 'systemBlocked' | 'embedded'>): Promise<PromptAnswer | null> {
    const persistent = !this.#private.has(session) && !!sites.storeFor(session)?.persistent
    const props: PromptProps = {
      requestId: randomUUID(),
      tabId: tab.id,
      origin,
      host: hostOf(origin),
      perms,
      ...extra,
      remember: persistent && extra.systemBlocked.length === 0 ? rememberChoice(perms) : null,
    }
    return this.prompts.ask({ key: promptKey(tab.id, origin, perms, extra.scheme ?? extra.systemBlocked.join('+')), tabId: tab.id, props })
  }

  /** A notification request that waits on the address bar's chip instead of a prompt; unanswered, it ends as a dismissal. */
  #askQuietly(tabId: string, origin: string, perm: SitePermission): Promise<PromptAnswer | null> {
    this.#note({ tabId, origin, permission: perm, outcome: 'quiet' })
    const id = quietId(tabId, perm)
    return new Promise((resolve) => {
      const waiting = this.#quiet.get(id)
      if (waiting?.origin === origin) {
        waiting.waiters.push(resolve)
        return
      }
      if (waiting) this.#endQuiet(id, null)
      const timer = setTimeout(() => this.#endQuiet(id, DISMISSED), QUIET_TIMEOUT_MS)
      timer.unref?.()
      this.#quiet.set(id, { origin, waiters: [resolve], timer })
    })
  }

  #endQuiet(id: string, answer: PromptAnswer | null): void {
    const request = this.#quiet.get(id)
    if (!request) return
    clearTimeout(request.timer)
    this.#quiet.delete(id)
    for (const settle of request.waiters) settle(answer)
  }

  #endQuietOf(tabId: string): void {
    for (const id of [...this.#quiet.keys()]) if (id.startsWith(`${tabId}|`)) this.#endQuiet(id, null)
  }

  #present(prompt: QueuedPrompt<PromptProps>): PromptHandle {
    const tab = this.#deps.tabsRegistry.get(prompt.tabId)
    const win = tab ? windowOfTab(this.#deps.windows, tab) : null
    if (!tab || !win) return { result: Promise.resolve(null), close: () => undefined }
    const result = (async () => {
      const anchor = await siteButtonAnchor(win, tab)
      return answerOf(await presentSurface(win, 'permission-prompt', anchor, prompt.props, tab.id))
    })()
    // The surface listens for this and closes itself (its tab closed, or the agent took over).
    return { result, close: () => this.#deps.broadcast({ type: 'site-request', requestId: prompt.props.requestId, closed: true }) }
  }

  #check(session: Session, wc: WebContents | null, permission: string, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
    const origin = originOf(requestingOrigin || details.requestingUrl || '')
    const override = permissionPolicy.override({ origin, permission, session, webContents: wc })
    if (override) return override === 'allow'
    const mediaType = details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : undefined
    const policy = classifyPermission(permission, { mediaTypes: mediaType, origin })
    if (policy.action !== 'ask') return policy.action === 'allow'
    return this.#state(session, wc, origin, details.isMainFrame === true, policy.perms) === 'granted'
  }

  /**
   * What a check (and permissions.query) reads for `perms`: the request's own
   * rules without the prompt, so they never disagree. Never asked is 'prompt'.
   */
  #state(session: Session, wc: WebContents | null, frameOrigin: string, isMainFrame: boolean, perms: readonly SitePermission[], who = wc && !wc.isDestroyed() ? this.#attribute(wc) : null): QueryState {
    if (!wc || wc.isDestroyed()) {
      // A service worker has no page: the site's own answers count (stored, defaults, embargo).
      const key = siteKey(frameOrigin)
      if (!key || !secureEnough({ key, embedded: null }, perms)) return 'denied'
      return queryState(this.#verdict(session, null, key, perms).verdict)
    }
    const scope = who ? this.#scope(who, wc, frameOrigin, isMainFrame, perms) : null
    if (!scope) return 'denied'
    const { verdict } = this.#verdict(session, scope.tab.id, scope.key, perms)
    // The device chooser is the device classes' prompt, so their check passes unless the site is blocked.
    if (perms.some((p) => DEVICE_PERMISSIONS.has(p))) return !scope.tab.agentControlled && verdict !== 'block' ? 'granted' : 'denied'
    return queryState(verdict)
  }

  /** The tab a webContents asks through: its own, or (for a popup) its opener's. */
  #attribute(wc: WebContents): { tab: Tab; popup: boolean } | null {
    const tab = this.#deps.tabsRegistry.byWebContents(wc.id)
    if (tab) return { tab, popup: false }
    let opener = this.#deps.openerOf?.(wc) ?? null
    for (let hops = 0; opener && hops < 4; hops++) {
      const openerTab = this.#deps.tabsRegistry.byWebContents(opener.id)
      if (openerTab) return { tab: openerTab, popup: true }
      opener = this.#deps.openerOf?.(opener) ?? null
    }
    return null
  }

  /** Whose question it is (the top-level page's) and whether it may be asked from here at all. */
  #scope(who: { tab: Tab; popup: boolean }, wc: WebContents, requestingOrigin: string, isMainFrame: boolean, perms: readonly SitePermission[]): Scope | null {
    const frame = frameScope(requestingOrigin, originOf(wc.getURL()), isMainFrame, perms)
    if (!frame || !secureEnough(frame, perms)) return null
    // A popup has no capture indicator or Stop of its own, so it never gets the camera, microphone or screen.
    if (who.popup && perms.some((p) => MEDIA.has(p) || p === 'screen')) return null
    return { ...who, ...frame }
  }

  #verdict(session: Session, tabId: string | null, key: string, perms: readonly SitePermission[]): ReturnType<typeof siteVerdict> {
    const store = sites.storeFor(session)
    const history = this.#history(session)
    return siteVerdict({
      perms,
      stored: store ? store.get(key).permissions : {},
      once: tabId ? oneOffAnswer(this.#oneOff.get(tabId), key, perms) : undefined,
      defaults: this.#settings().sitePermissionDefaults ?? {},
      embargoed: (p) => history.embargoed(key, p),
    })
  }

  #history(session: Session): PermissionHistory {
    const store = sites.storeFor(session)
    if (!store) return this.#memoryHistory
    let history = this.#histories.get(store)
    if (!history) {
      history = new PermissionHistory(this.#private.has(session) ? null : historyFileFor(store.file))
      this.#histories.set(store, history)
      this.#historyRefs.add(new WeakRef(history))
    }
    return history
  }

  #settings(): NonNullable<ReturnType<NonNullable<PermissionDeps['settings']>>> {
    try {
      return this.#deps.settings?.() ?? {}
    } catch {
      return {}
    }
  }

  #note(a: PermissionActivity): void {
    const list = this.#activity.get(a.tabId) ?? []
    if (list.some((x) => x.origin === a.origin && x.permission === a.permission && x.outcome === a.outcome)) return
    list.push(a)
    this.#activity.set(a.tabId, list)
    emitActivity(a)
  }

  #noteAll(tabId: string, origin: string, perms: readonly SitePermission[], outcome: PermissionActivity['outcome']): void {
    for (const permission of perms) this.#note({ tabId, origin, permission, outcome })
  }

  #hasActivity(tabId: string, origin: string, permission: SitePermission, outcome: PermissionActivity['outcome']): boolean {
    return (this.#activity.get(tabId) ?? []).some((a) => a.origin === origin && a.permission === permission && a.outcome === outcome)
  }

  /** PAGE.permissions, sendSync from a frame's preload at document start. */
  #onStatesAsked(event: IpcMainEvent): void {
    try {
      const wc = event.sender
      const frame = event.senderFrame
      event.returnValue = frame && this.#sessions.has(wc.session) ? this.#frameStates(wc, frame) : null
    } catch {
      event.returnValue = null
    }
  }

  #frameStates(wc: WebContents, frame: WebFrameMain): QueryStates {
    // frame.origin is the real one (an about:blank frame inherits its parent's); an opaque one reads as 'null'.
    const origin = frame.origin && frame.origin !== 'null' ? frame.origin : frame.url
    const isMain = frame === wc.mainFrame
    const who = this.#attribute(wc)
    const out: QueryStates = {}
    for (const [name, perm] of Object.entries(QUERY_NAMES)) out[name] = this.#state(wc.session, wc, origin, isMain, [perm], who)
    return out
  }

  /** Sends fresh states to every frame of the tabs showing `origin` (or every tab). */
  #pushStates(origin: string | null): void {
    for (const tab of this.#deps.tabsRegistry.all()) {
      const wc = tab.view.webContents as WebContents | undefined
      if (!wc || wc.isDestroyed()) continue
      if (origin && siteKey(wc.getURL()) !== origin) continue
      for (const frame of wc.mainFrame.framesInSubtree) {
        try {
          frame.send(PAGE.permissions, this.#frameStates(wc, frame))
        } catch {
          // A frame mid-navigation asks again at its next document start.
        }
      }
    }
  }

  /** Camera, microphone or Location Services that macOS has turned off for Apex: allowing the site would not help. */
  async #systemBlocked(perms: readonly SitePermission[]): Promise<SystemBlocked[]> {
    if (process.platform !== 'darwin' || this.#deps.smoke) return []
    const out: SystemBlocked[] = []
    for (const p of perms) {
      if (!MEDIA.has(p)) continue
      const status = systemPreferences.getMediaAccessStatus(p as 'camera' | 'microphone')
      if (status === 'denied' || status === 'restricted') out.push(p as 'camera' | 'microphone')
    }
    if (perms.includes('location')) {
      const status = await this.#locationStatus()
      if (status === 'denied' || status === 'restricted') out.push('location')
    }
    return out
  }

  async #locationStatus(): Promise<Perm | undefined> {
    const read = this.#deps.systemLocation
    if (!read) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOCATION_WAIT_MS)
      })
      return await Promise.race([read(), late])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Camera and microphone first ask macOS, once, after the site was allowed; returns what macOS refused. */
  async #systemAccess(perms: readonly SitePermission[]): Promise<('camera' | 'microphone')[]> {
    if (process.platform !== 'darwin' || this.#deps.smoke) return []
    for (const p of perms) {
      if (!MEDIA.has(p)) continue
      const kind = p as 'camera' | 'microphone'
      const status = systemPreferences.getMediaAccessStatus(kind)
      if (status === 'granted') continue
      if (status !== 'not-determined' || !(await systemPreferences.askForMediaAccess(kind))) return [kind]
    }
    return []
  }
}

function quietId(tabId: string, perm: SitePermission): string {
  return `${tabId}|${perm}`
}

/** Which answers the prompt may offer to remember for these permissions. */
export function rememberChoice(perms: readonly SitePermission[]): PermissionPromptProps['remember'] {
  if (canRemember(perms, true) && canRemember(perms, false)) return 'both'
  if (perms.every((p) => rememberable(p) === 'allow-only')) return 'allow'
  if (perms.every((p) => rememberable(p) !== 'allow-only') && canRemember(perms, false)) return 'deny'
  return null
}

/** The prompt's result: an answer, a dismissal (Esc, or the prompt's own PermissionPromptDismissal), or null when it was closed for it. */
export function answerOf(result: OverlayResult | null): PromptAnswer | null {
  if (!result) return null
  if ('dismissed' in result) return result.dismissed === 'escape' ? DISMISSED : null
  const v = result.value as { allow?: unknown; remember?: unknown; dismissed?: unknown } | null
  if (!v || typeof v !== 'object') return null
  if (v.dismissed === true) return DISMISSED
  return typeof v.allow === 'boolean' ? { allow: v.allow, remember: v.remember === true } : null
}

function hostOf(originOrUrl: string): string {
  try {
    return new URL(originOrUrl).hostname || originOrUrl
  } catch {
    return originOrUrl
  }
}

/** "use your camera and microphone", for the agent's note. */
export function describePerms(perms: readonly SitePermission[]): string {
  if (perms.length === 2 && perms.includes('camera') && perms.includes('microphone')) return mainT('sites.ask.cameraAndMicrophone')
  return perms.map((p) => mainT(`sites.ask.${p}`)).reduce((a, b) => (a ? mainT('sites.and', { a, b }) : b), '')
}
