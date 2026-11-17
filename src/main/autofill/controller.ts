/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AutofillSettings, FrameReport, GuardKind, OfferAction, PickResult } from '@shared/autofill'
import type { ToastSpec } from '@shared/dialogs'
import { displayHost } from '@shared/domains'
import { isAddressKind, isCardKind, isLoginKind, type FieldKind } from '@shared/fields'
import type { Bounds } from '@shared/ipc'
import type { AutofillSurfaceId, AutofillSurfaceProps } from '@shared/overlay/autofill'
import type { AddressInput } from '@shared/passwords'
import type { Authenticator, AppNotice, VaultApi, Wallet } from '../features/personalRuntime'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { FrameLinker, rectInTop, scaleRect, type FrameHandle } from './frames'
import {
  addressFromValues, addressValues, cardFromValues, decideAddressOffer, decideCardOffer, decideLoginOffer, loginFromValues, maskedNumber,
  type SubmittedCard,
} from './offers'
import { cardSize, placeCard, placePopup, popupSize, type Size } from './placement'
import type { Presenter, SurfaceHandle } from './presenter'
import { GENERATED_ROW, MANAGE_ROW, addressRows, cardRows, loginRows, parseRowId } from './rows'
import { SplitLoginMemory, TYPED_TTL_MS } from './splitLogin'
import { StillnessGate } from './stillness'

// One tab's autofill: fed by PAGE_AUTOFILL reports from every frame
// of the tab, it decides when a fill popup opens (OV-26), keeps it placed and
// still (OV-25), fills on a pick, remembers split logins (OV-28) and offers to
// save what was submitted (OV-27, OV-29). Nothing here is reachable by the
// agent: popups never open on tabs it drives, and offers are withdrawn when
// it takes over.

/** What the controller needs from its tab, behind an interface for tests. */
export interface TabPort {
  id: string
  windowId: number
  /** The top frame's URL. */
  url(): string
  agentControlled(): boolean
  favicon(): string | null
  /** The page's zoom factor. */
  zoom(): number
  /** The chrome's zoom factor: tab-pane rects are chrome CSS px. */
  chromeZoom(): number
  /** The tab pane's size in DIP. */
  viewport(): Size
  certificateException(): boolean
  /** A modal surface is open in the window: fill popups stay hidden under it (OV-25). */
  modalOpen?(): boolean
  /** Atelier is the focused, visible app. */
  appInView(): boolean
  topFrame(): FrameHandle
  frames(): FrameHandle[]
}

export interface PopupRegistry {
  /** Closes any other popup in the same window, then records this one. */
  popupOpened(owner: AutofillController, popupId: string): void
  popupClosed(popupId: string): void
  offerOpened(owner: AutofillController, offerId: string): void
  offerClosed(offerId: string): void
}

export interface ControllerDeps {
  tab: TabPort
  vault: () => VaultApi
  wallet: () => Wallet
  auth: () => Authenticator
  settings(): AutofillSettings
  updateSettings(patch: Partial<AutofillSettings>): void
  presenter: Presenter
  registry: PopupRegistry
  notify(n: AppNotice): void
  toast(spec: ToastSpec): void
  openUrl(url: string): void
  importHint: { shouldShow(): boolean; markShown(): void }
  generatePassword(): string
  now(): number
  ids(): string
  /** Frame probe and reply wait; short in tests. */
  frameTimeoutMs?: number
}

type PopupSurface = 'autofill-login' | 'autofill-card' | 'autofill-address'

interface PopupPlan {
  surface: PopupSurface
  rows: AutofillSurfaceProps['autofill-login']['rows']
  active: number
  /** Login rows: the row's username, so a fill never needs another vault read. */
  usernames: Map<string, string>
  passwordOnly: boolean
  manageUrl: string
  siteLabel: string
  embeddingSite?: string
}

interface PopupState extends PopupPlan {
  id: string
  frame: FrameHandle
  fieldId: string
  formId: string
  kind: FieldKind
  field: Bounds
  rect: Bounds
  gate: StillnessGate
  handle: SurfaceHandle
}

type OfferState =
  | { id: string; kind: 'login'; handle: SurfaceHandle; origin: string; url: string; username: string; password: string; mode: 'save' | 'update'; site: string }
  | { id: string; kind: 'card'; handle: SurfaceHandle; card: SubmittedCard; fingerprint: string; site: string }
  | { id: string; kind: 'address'; handle: SurfaceHandle; address: AddressInput; site: string }
  | { id: string; kind: 'hint'; handle: SurfaceHandle; site: string }

interface PendingSubmit {
  frameToken: string
  origin: string
  url: string
  topUrl: string
  form: 'login' | 'card' | 'address'
  values: Record<string, string>
  at: number
}

/** https, or a loopback host: the secure contexts card fill is allowed in. */
export function isSecureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    if (u.protocol === 'https:') return true
    if (u.protocol !== 'http:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

function hostOf(url: string): string {
  return displayHost(url).host || url
}

function sameSite(a: string, b: string): boolean {
  const x = displayHost(a)
  const y = displayHost(b)
  return x.registrable !== '' && x.registrable === y.registrable
}

const REMOVED_OFFER_DELAY_MS = 400

export class AutofillController {
  readonly tabId: string
  readonly windowId: number
  readonly #d: ControllerDeps
  readonly #linker: FrameLinker
  readonly #split: SplitLoginMemory
  #popup: PopupState | null = null
  #offer: OfferState | null = null
  #pending: PendingSubmit | null = null
  #pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped on every focus, so a slow placement for an old focus is dropped. */
  #focusSeq = 0
  #lastFocus = 'none yet'
  /** Forms that showed the empty state on this page, so it shows once each. */
  readonly #emptyShown = new Set<string>()
  #disposed = false

  constructor(deps: ControllerDeps) {
    this.#d = deps
    this.tabId = deps.tab.id
    this.windowId = deps.tab.windowId
    this.#split = new SplitLoginMemory(deps.now)
    this.#linker = new FrameLinker({
      viewport: () => this.#cssViewport(),
      ids: deps.ids,
      timeoutMs: deps.frameTimeoutMs,
    })
  }

  get popupId(): string | null {
    return this.#popup?.id ?? null
  }

  get offerId(): string | null {
    return this.#offer?.id ?? null
  }

  /** The top viewport in page CSS px. */
  #cssViewport(): Size {
    const { width, height } = this.#d.tab.viewport()
    const zoom = this.#d.tab.zoom() || 1
    return { width: width / zoom, height: height / zoom }
  }

  /** The tab pane in chrome CSS px, where surfaces are placed. */
  #paneSize(): Size {
    const { width, height } = this.#d.tab.viewport()
    const k = this.#d.tab.chromeZoom() || 1
    return { width: width / k, height: height / k }
  }

  // ── reports ──

  onReport(frame: FrameHandle, report: FrameReport): void {
    if (this.#disposed) return
    switch (report.type) {
      case 'focus':
        void this.#onFocus(frame, report)
        return
      case 'moved':
        if (this.#popup && this.#popup.frame.token === frame.token && this.#popup.fieldId === report.fieldId) void this.#replace(report.rect)
        return
      case 'blur':
        if (this.#popup && this.#popup.frame.token === frame.token && this.#popup.fieldId === report.fieldId) this.closePopup()
        return
      case 'key':
        this.#onKey(frame, report.key)
        return
      case 'scroll':
        this.closePopup()
        return
      case 'submit':
        this.#onSubmit(frame, report)
        return
      case 'probe':
        this.#linker.onProbe(frame, report.nonce, report.childRect)
        return
      case 'guarded':
        this.#linker.onGuarded(frame, report.rects, report.focused ?? null)
        return
    }
  }

  /** What the last focus report came to (smoke diagnostics). */
  get lastFocus(): string {
    return this.#lastFocus
  }

  async #onFocus(frame: FrameHandle, r: Extract<FrameReport, { type: 'focus' }>): Promise<void> {
    const seq = ++this.#focusSeq
    const at = `${r.formRole}/${r.kind}${frame.isMain ? '' : ' in a frame'}`
    if (this.#d.tab.agentControlled()) {
      this.#lastFocus = `${at}: agent tab`
      this.closePopup()
      return
    }
    // A re-focus of the field the popup already serves keeps it.
    if (this.#popup && this.#popup.frame.token === frame.token && this.#popup.fieldId === r.fieldId) return
    let plan: PopupPlan | null = null
    try {
      plan = this.#plan(frame, r)
    } catch (err) {
      // The vault or wallet isn't available (locked keychain, or not wired yet).
      log.debug('autofill', 'no fill suggestions', { error: err instanceof Error ? err.message : String(err) })
    }
    if (!plan) {
      this.#lastFocus = `${at}: nothing to offer`
      this.closePopup()
      return
    }
    const field = await this.#fieldRect(frame, r.rect)
    if (seq !== this.#focusSeq || this.#disposed || this.#d.tab.agentControlled()) {
      this.#lastFocus = `${at}: superseded`
      return
    }
    if (!field) {
      this.#lastFocus = `${at}: no field box`
      this.closePopup()
      return
    }
    this.#lastFocus = `${at}: opened`
    this.#open(frame, r, plan, field)
  }

  /** Decides what a focus should offer, or null for nothing. Synchronous so a fast blur can't race it. */
  #plan(frame: FrameHandle, r: Extract<FrameReport, { type: 'focus' }>): PopupPlan | null {
    const settings = this.#d.settings()
    const siteLabel = hostOf(frame.url)
    const topUrl = this.#d.tab.url()
    const crossSite = !frame.isMain && !sameSite(frame.url, topUrl)
    const embeddingSite = crossSite ? hostOf(topUrl) : undefined

    if ((r.formRole === 'login' || r.formRole === 'signup') && isLoginKind(r.kind)) {
      const generated = r.kind === 'new-password' && settings.offerGenerated && !r.typed
      if (r.kind === 'new-password') {
        if (!generated) return null
        const rows = loginRows([], { favicon: null, generated: true, now: this.#d.now() })
        return { surface: 'autofill-login', rows, active: -1, usernames: new Map(), passwordOnly: false, manageUrl: this.#manageUrl(siteLabel), siteLabel, embeddingSite }
      }
      if (!settings.offerLogins || (r.filled.username && r.filled.password)) return null
      const creds = this.#d.vault().forUrl(frame.url).filter((c) => c.origin === frame.origin)
      const remembered = this.#split.username(frame.origin)
      const isPassword = r.kind === 'current-password'
      if (creds.length === 0) {
        if (r.typed || !isPassword) return null
        if (this.#d.importHint.shouldShow()) {
          this.#showImportHint(siteLabel)
          return null
        }
        const key = `${frame.token}:${r.formId}`
        if (this.#emptyShown.has(key)) return null
        this.#emptyShown.add(key)
      }
      const rows = loginRows(creds, { favicon: frame.isMain ? this.#d.tab.favicon() : null, generated: false, now: this.#d.now() })
      const usernames = new Map(creds.map((c) => [`l:${c.id}`, c.username]))
      // A saved username already in the page (or from the first page of a split login) is preselected.
      const known = (r.username || (isPassword ? remembered : null) || '').trim().toLowerCase()
      const active = known ? rows.findIndex((row) => usernames.get(row.id)?.toLowerCase() === known) : -1
      return { surface: 'autofill-login', rows, active, usernames, passwordOnly: isPassword && r.username === undefined && remembered !== null, manageUrl: this.#manageUrl(siteLabel), siteLabel, embeddingSite }
    }

    if (r.formRole === 'card' && isCardKind(r.kind) && r.kind !== 'cc-csc') {
      if (!settings.cards || !this.#cardAllowed(frame)) return null
      const cards = this.#d.wallet().cards()
      if (cards.length === 0) return null
      return { surface: 'autofill-card', rows: cardRows(cards), active: -1, usernames: new Map(), passwordOnly: false, manageUrl: 'atelier://settings/passwords', siteLabel, embeddingSite }
    }

    if (r.formRole === 'address' && isAddressKind(r.kind)) {
      if (!settings.addresses) return null
      const addresses = this.#d.wallet().addresses()
      if (addresses.length === 0) return null
      return { surface: 'autofill-address', rows: addressRows(addresses), active: -1, usernames: new Map(), passwordOnly: false, manageUrl: 'atelier://settings/passwords', siteLabel, embeddingSite }
    }
    return null
  }

  #manageUrl(site: string): string {
    return `atelier://passwords?site=${encodeURIComponent(site)}`
  }

  /** Card fill only in a secure context (the frame and the page) without a certificate exception. */
  #cardAllowed(frame: FrameHandle): boolean {
    return isSecureOrigin(frame.origin) && isSecureOrigin(this.#d.tab.url()) && !this.#d.tab.certificateException()
  }

  /** A field rect from its frame's viewport to tab-pane coordinates; null when it is out of view. */
  async #fieldRect(frame: FrameHandle, rect: Bounds): Promise<Bounds | null> {
    const box = await this.#linker.boxOf(frame)
    if (!box) return null
    // The field's own rect, unclipped, so the popup lines up with it; a field clipped away entirely is hidden.
    if (!rectInTop(box, rect, true)) return null
    const top = rectInTop(box, rect, false)
    if (!top) return null
    return scaleRect(top, (this.#d.tab.zoom() || 1) / (this.#d.tab.chromeZoom() || 1))
  }

  #props(p: Omit<PopupState, 'handle'>): AutofillSurfaceProps['autofill-login'] {
    return {
      popupId: p.id,
      rows: p.rows,
      anchorRect: p.field,
      siteLabel: p.siteLabel,
      ...(p.embeddingSite ? { embeddingSite: p.embeddingSite } : {}),
      activeId: p.active >= 0 ? (p.rows[p.active]?.id ?? null) : null,
    }
  }

  #open(frame: FrameHandle, r: { fieldId: string; formId: string; kind: FieldKind }, plan: PopupPlan, field: Bounds): void {
    const rect = placePopup(field, popupSize(plan.rows, { header: plan.embeddingSite !== undefined }), this.#paneSize())
    this.closePopup()
    if (!rect || this.#d.tab.modalOpen?.()) return
    const id = this.#d.ids()
    this.#d.registry.popupOpened(this, id)
    const base = { ...plan, id, frame, fieldId: r.fieldId, formId: r.formId, kind: r.kind, field, rect, gate: new StillnessGate() }
    const handle = this.#d.presenter.open(plan.surface, rect, this.#props(base), id)
    const state: PopupState = { ...base, handle }
    this.#popup = state
    void handle.done.then(() => {
      // Dismissed by the host (outside click, tab switch, Esc) or never shown.
      if (this.#popup?.id === id) this.closePopup()
    })
    frame.send({ type: 'popup', open: true, active: state.active >= 0 })
  }

  /** The field moved: the popup reopens at the new place, so the stillness wait starts over. */
  async #replace(rect: Bounds): Promise<void> {
    const p = this.#popup
    if (!p) return
    const field = await this.#fieldRect(p.frame, rect)
    if (this.#popup !== p) return
    if (!field) {
      this.closePopup()
      return
    }
    this.#open(p.frame, p, { ...p }, field)
  }

  #onKey(frame: FrameHandle, key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Escape'): void {
    const p = this.#popup
    if (!p || p.frame.token !== frame.token) return
    if (key === 'Escape') {
      this.closePopup()
      return
    }
    const n = p.rows.length
    if (key === 'Enter') {
      const row = p.rows[p.active]
      if (row) void this.pick(p.id, row.id)
      return
    }
    if (n === 0) return
    p.active = key === 'ArrowDown' ? (p.active + 1) % n : p.active <= 0 ? n - 1 : p.active - 1
    p.handle.update(this.#props(p))
    frame.send({ type: 'popup', open: true, active: true })
  }

  closePopup(): void {
    const p = this.#popup
    if (!p) return
    this.#popup = null
    p.gate.hidden()
    p.handle.close()
    this.#d.registry.popupClosed(p.id)
    if (p.frame.alive()) p.frame.send({ type: 'popup', open: false })
  }

  surfaceShown(popupId: string, rect: Bounds): void {
    if (this.#popup?.id === popupId) this.#popup.gate.shown(rect, this.#d.now())
  }

  dismissPopup(popupId: string): void {
    if (this.#popup?.id === popupId) this.closePopup()
  }

  // ── picks ──

  async pick(popupId: string, itemId: string): Promise<PickResult> {
    const p = this.#popup
    if (!p || p.id !== popupId) return 'gone'
    if (!p.frame.alive() || this.#d.tab.agentControlled()) {
      this.closePopup()
      return 'gone'
    }
    if (itemId === MANAGE_ROW) {
      // Opening Passwords fills nothing, so it needs no stillness wait.
      this.closePopup()
      this.#d.openUrl(p.manageUrl)
      return 'filled'
    }
    if (!p.rows.some((row) => row.id === itemId)) return 'gone'
    if (this.#d.tab.modalOpen?.()) {
      // A modal opened over the popup: nothing under it can be picked.
      this.closePopup()
      return 'gone'
    }
    if (!p.gate.ready(this.#d.now())) return 'too-soon'

    if (itemId === GENERATED_ROW) {
      const password = this.#d.generatePassword()
      p.frame.send({ type: 'fill', values: { 'new-password': password }, formId: p.formId })
      this.closePopup()
      return 'filled'
    }
    const row = parseRowId(itemId)
    if (!row) return 'gone'
    try {
      if (row.kind === 'login') return this.#fillLogin(p, row.recordId, itemId)
      if (row.kind === 'card') return await this.#fillCard(p, row.recordId)
      if (row.kind === 'address') return await this.#fillAddress(p, row.recordId)
    } catch (err) {
      log.warn('autofill', 'fill failed', { kind: row.kind, error: err instanceof Error ? err.message : String(err) })
      this.closePopup()
      return 'gone'
    }
    return 'gone'
  }

  #fillLogin(p: PopupState, credId: string, rowId: string): PickResult {
    const vault = this.#d.vault()
    const username = p.usernames.get(rowId) ?? ''
    const password = vault.reveal(credId)
    const values = p.passwordOnly ? { 'current-password': password } : { username, email: username, 'current-password': password }
    p.frame.send({ type: 'fill', values, formId: p.formId })
    vault.markUsed(credId)
    if (username) this.#split.rememberUsername(p.frame.origin, username)
    this.closePopup()
    return 'filled'
  }

  /** Auth (when that switch is on), then re-checks that the same popup still stands. */
  async #authorize(p: PopupState, needed: boolean, reason: string): Promise<'ok' | PickResult> {
    if (!needed) return 'ok'
    const result = await this.#d.auth().authenticate(reason)
    if (result !== 'ok') return 'auth-cancelled'
    if (this.#popup !== p || !p.frame.alive() || this.#d.tab.agentControlled()) return 'gone'
    return 'ok'
  }

  async #fillCard(p: PopupState, cardId: string): Promise<PickResult> {
    if (!this.#cardAllowed(p.frame)) {
      this.closePopup()
      return 'gone'
    }
    const ok = await this.#authorize(p, this.#d.settings().cardAuth, mainT('autofill.auth.card', { site: p.siteLabel }))
    if (ok !== 'ok') return ok
    if (!this.#cardAllowed(p.frame)) return 'gone'
    const card = this.#d.wallet().cardForFill(cardId)
    const month = String(card.expMonth).padStart(2, '0')
    p.frame.send({
      type: 'fill',
      formId: p.formId,
      values: {
        'cc-number': card.number,
        'cc-name': card.holder,
        'cc-exp': `${month}/${String(card.expYear % 100).padStart(2, '0')}`,
        'cc-exp-month': month,
        'cc-exp-year': String(card.expYear),
      },
    })
    this.closePopup()
    return 'filled'
  }

  async #fillAddress(p: PopupState, addressId: string): Promise<PickResult> {
    const ok = await this.#authorize(p, this.#d.settings().addressAuth, mainT('autofill.auth.address', { site: p.siteLabel }))
    if (ok !== 'ok') return ok
    p.frame.send({ type: 'fill', formId: p.formId, values: addressValues(this.#d.wallet().addressForFill(addressId)) })
    this.closePopup()
    return 'filled'
  }

  // ── submissions and offers ──

  #onSubmit(frame: FrameHandle, r: Extract<FrameReport, { type: 'submit' }>): void {
    if (this.#d.tab.agentControlled()) return
    const values = { ...r.values }
    delete values['cc-csc']
    if (r.form === 'login') {
      const login = loginFromValues(values, this.#split.username(frame.origin))
      if (!login) return
      if (!login.password) {
        // The first page of a split login: keep the username for the password page.
        this.#split.rememberUsername(frame.origin, login.username)
        return
      }
      this.#split.rememberTyped({ url: frame.url, origin: frame.origin, username: login.username, password: login.password })
    }
    this.#pending = { frameToken: frame.token, origin: frame.origin, url: frame.url, topUrl: this.#d.tab.url(), form: r.form, values, at: this.#d.now() }
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = null
    // A form that vanished without a navigation (a single-page app's sign-in) offers on its own.
    if (r.trigger === 'removed') this.#pendingTimer = setTimeout(() => this.#maybeOffer(), REMOVED_OFFER_DELAY_MS)
  }

  /** A main-frame navigation (full or in-page), or the submitting frame navigating. */
  onNavigated(nav: { mainFrame: boolean; inPage: boolean; frameToken?: string }): void {
    if (this.#popup && (nav.mainFrame || nav.frameToken === this.#popup.frame.token)) this.closePopup()
    if (nav.mainFrame && !nav.inPage) this.#emptyShown.clear()
    if (this.#pending && (nav.mainFrame || nav.frameToken === this.#pending.frameToken)) this.#maybeOffer()
  }

  #maybeOffer(): void {
    const pending = this.#pending
    this.#pending = null
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = null
    if (!pending || this.#disposed || this.#d.now() - pending.at > TYPED_TTL_MS || this.#d.tab.agentControlled()) return
    try {
      if (pending.form === 'login') this.#offerLogin(pending)
      else if (pending.form === 'card') this.#offerCard(pending)
      else this.#offerAddress(pending)
    } catch (err) {
      log.debug('autofill', 'no save offer', { form: pending.form, error: err instanceof Error ? err.message : String(err) })
    }
  }

  #offerLogin(p: PendingSubmit): void {
    const typed = this.#split.typed(p.url) ?? this.#split.latest(p.origin)
    const login = typed ? { username: typed.username, password: typed.password } : loginFromValues(p.values, this.#split.username(p.origin))
    if (!login?.password) return
    const vault = this.#d.vault()
    const offer = decideLoginOffer({
      settings: this.#d.settings(),
      agentControlled: this.#d.tab.agentControlled(),
      neverSave: vault.isNeverSave(p.origin),
      username: login.username,
      password: login.password,
      decision: vault.decide(p.url, login.username, login.password),
    })
    if (!offer) return
    if (offer.mode === 'used') {
      vault.markUsed(offer.id)
      return
    }
    const site = hostOf(p.url)
    const id = this.#d.ids()
    const handle = this.#present(id, 'save-login', 'login', {
      offerId: id,
      kind: 'login',
      mode: offer.mode,
      fields: [
        { key: 'username', label: mainT('autofill.save.username'), value: login.username },
        { key: 'password', label: mainT('autofill.save.password'), value: login.password, masked: true },
      ],
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      siteLabel: site,
    })
    this.#offer = { id, kind: 'login', handle, origin: p.origin, url: p.url, username: login.username, password: login.password, mode: offer.mode, site }
    if (!this.#d.tab.appInView()) {
      this.#d.notify({ category: 'passwords', title: mainT(offer.mode === 'save' ? 'autofill.notify.offerSave' : 'autofill.notify.offerUpdate', { site }), body: login.username || undefined })
    }
  }

  #offerCard(p: PendingSubmit): void {
    const card = cardFromValues(p.values)
    if (!card) return
    const wallet = this.#d.wallet()
    const site = displayHost(p.topUrl).registrable || hostOf(p.topUrl)
    const fingerprint = wallet.fingerprint(card.number)
    const offered = decideCardOffer({
      settings: this.#d.settings(),
      agentControlled: this.#d.tab.agentControlled(),
      secure: isSecureOrigin(p.origin) && isSecureOrigin(p.topUrl),
      certificateException: this.#d.tab.certificateException(),
      card,
      saved: wallet.cards(),
      offerAllowed: wallet.offerAllowed(fingerprint, site),
    })
    if (!offered) return
    const id = this.#d.ids()
    const fields = [
      ...(card.holder ? [{ key: 'holder', label: mainT('autofill.save.holder'), value: card.holder }] : []),
      { key: 'number', label: mainT('autofill.save.number'), value: maskedNumber(card.number) },
      { key: 'expiry', label: mainT('autofill.save.expiry'), value: `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear % 100).padStart(2, '0')}` },
    ]
    const embedding = !sameSite(p.url, p.topUrl) ? { embeddingSite: hostOf(p.topUrl) } : {}
    const handle = this.#present(id, 'save-card', 'card', { offerId: id, kind: 'card', mode: 'save', fields, anchorRect: { x: 0, y: 0, width: 0, height: 0 }, siteLabel: hostOf(p.url), ...embedding })
    this.#offer = { id, kind: 'card', handle, card, fingerprint, site }
  }

  #offerAddress(p: PendingSubmit): void {
    const address = addressFromValues(p.values)
    const offered = decideAddressOffer({ settings: this.#d.settings(), agentControlled: this.#d.tab.agentControlled(), address, saved: this.#d.wallet().addresses() })
    if (!offered) return
    const id = this.#d.ids()
    const name = [address.givenName, address.additionalName, address.familyName].filter(Boolean).join(' ')
    const fields = [
      { key: 'name', label: mainT('autofill.save.name'), value: name },
      { key: 'organization', label: mainT('autofill.save.organization'), value: address.organization },
      { key: 'line1', label: mainT('autofill.save.street'), value: [address.line1, address.line2].filter(Boolean).join(', ') },
      { key: 'city', label: mainT('autofill.save.city'), value: [address.postalCode, address.city].filter(Boolean).join(' ') },
      { key: 'country', label: mainT('autofill.save.country'), value: address.country },
      { key: 'email', label: mainT('autofill.save.email'), value: address.email },
      { key: 'tel', label: mainT('autofill.save.tel'), value: address.tel },
    ].filter((f) => f.value)
    const site = hostOf(p.url)
    const handle = this.#present(id, 'save-address', 'address', { offerId: id, kind: 'address', mode: 'save', fields, anchorRect: { x: 0, y: 0, width: 0, height: 0 }, siteLabel: site })
    this.#offer = { id, kind: 'address', handle, address, site }
  }

  #showImportHint(site: string): void {
    this.#d.importHint.markShown()
    const id = this.#d.ids()
    const handle = this.#present(id, 'password-import-hint', 'hint', { offerId: id, anchorRect: { x: 0, y: 0, width: 0, height: 0 }, siteLabel: site })
    this.#offer = { id, kind: 'hint', handle, site }
    void handle.done.then((result) => {
      if (!result || this.#offer?.id !== id) return
      if ('value' in result && result.value === 'import') {
        this.#d.openUrl('atelier://settings/passwords')
        this.dismissImportHint()
      } else if ('value' in result || result.dismissed === 'escape') {
        this.dismissImportHint()
      }
    })
  }

  /** Opens a top-right card, replacing this tab's earlier one. */
  #present<S extends 'save-login' | 'save-card' | 'save-address' | 'password-import-hint'>(id: string, surface: S, kind: 'login' | 'card' | 'address' | 'hint', props: AutofillSurfaceProps[S]): SurfaceHandle {
    this.closeOffer()
    const fields = 'fields' in props ? (props as { fields: unknown[] }).fields.length : 0
    const rect = placeCard(cardSize(kind, fields), this.#paneSize())
    const placed = { ...props, anchorRect: rect } as AutofillSurfaceProps[S]
    this.#d.registry.offerOpened(this, id)
    const handle = this.#d.presenter.open(surface as AutofillSurfaceId, rect, placed, id)
    void handle.done.then((result) => {
      if (this.#offer?.id !== id) return
      // Esc is a dismissal (a strike, for cards); a card the host never showed just goes.
      if (result && 'dismissed' in result && result.dismissed === 'escape') void this.respondOffer(id, 'dismiss')
      else if (!result || 'dismissed' in result) this.closeOffer()
    })
    return handle
  }

  closeOffer(): void {
    const o = this.#offer
    if (!o) return
    this.#offer = null
    o.handle.close()
    this.#d.registry.offerClosed(o.id)
  }

  async respondOffer(offerId: string, action: OfferAction, edited?: { username: string; password: string }): Promise<void> {
    const o = this.#offer
    if (!o || o.id !== offerId) return
    this.closeOffer()
    if (o.kind === 'hint') {
      this.dismissImportHint()
      return
    }
    if (o.kind === 'login') return this.#respondLogin(o, action, edited)
    const wallet = this.#d.wallet()
    if (o.kind === 'card') {
      if (action === 'save' || action === 'update') {
        wallet.saveCard({ number: o.card.number, holder: o.card.holder, expMonth: o.card.expMonth, expYear: o.card.expYear })
        this.#saved(mainT('autofill.toast.cardSaved'), 'atelier://settings/passwords')
      } else {
        // Each dismissal is a strike; "never" uses them all up at once.
        const strikes = action === 'never' ? 3 : 1
        for (let i = 0; i < strikes; i++) wallet.strike(o.fingerprint, o.site)
      }
      return
    }
    if (action === 'save' || action === 'update') {
      wallet.saveAddress(o.address)
      this.#saved(mainT('autofill.toast.addressSaved'), 'atelier://settings/passwords')
    }
  }

  #respondLogin(o: Extract<OfferState, { kind: 'login' }>, action: OfferAction, edited?: { username: string; password: string }): void {
    const vault = this.#d.vault()
    if (action === 'never') {
      vault.neverSave(o.origin)
      this.#d.toast({ kind: 'info', text: mainT('autofill.toast.never', { site: o.site }), tabId: this.tabId })
      return
    }
    if (action === 'dismiss') return
    const username = (edited?.username ?? o.username).trim()
    const password = edited?.password ?? o.password
    const decision = vault.decide(o.url, username, password)
    if (decision?.kind === 'update') vault.update(decision.id, { password })
    else if (decision?.kind === 'same') vault.markUsed(decision.id)
    else vault.save(o.url, username, password)
    this.#split.forget(o.url)
    this.#saved(mainT(decision?.kind === 'update' ? 'autofill.toast.updated' : 'autofill.toast.saved', { site: o.site }), `atelier://passwords?site=${encodeURIComponent(o.site)}`)
  }

  /** A toast in the tab, and a passwords notification when Atelier isn't in view. */
  #saved(text: string, target: string): void {
    this.#d.toast({ kind: 'success', text, tabId: this.tabId })
    if (!this.#d.tab.appInView()) this.#d.notify({ category: 'passwords', title: text, target })
  }

  dismissImportHint(): void {
    this.#d.updateSettings({ importHintDismissed: true })
    this.closeImportHint()
  }

  closeImportHint(): void {
    if (this.#offer?.kind === 'hint') this.closeOffer()
  }

  // ── tab events ──

  /** The agent took the tab: popups close, offers are withdrawn and pending submits dropped. */
  onAgentControl(): void {
    this.closePopup()
    this.closeOffer()
    this.#pending = null
  }


  /**
   * Guarded rects in DIP, relative to the tab view. `unresolved` is true when
   * a frame with guarded fields couldn't be placed; the masker then covers
   * everything rather than guess.
   */
  async guardedRects(): Promise<{ rects: Bounds[]; unresolved: boolean }> {
    const replies = await this.#linker.guarded(this.#d.tab.frames())
    const memo = new Map()
    const zoom = this.#d.tab.zoom() || 1
    const rects: Bounds[] = []
    let unresolved = false
    for (const reply of replies) {
      if (reply.rects.length === 0) continue
      const box = await this.#linker.boxOf(reply.frame, memo)
      if (!box) {
        unresolved = true
        continue
      }
      for (const rect of reply.rects) {
        const top = rectInTop(box, rect)
        if (top) rects.push(scaleRect(top, zoom))
      }
    }
    return { rects, unresolved }
  }

  /** The guard of the field focused in any frame. */
  async focusedGuard(): Promise<GuardKind | null> {
    const replies = await this.#linker.guarded(this.#d.tab.frames())
    return replies.find((r) => r.focused)?.focused ?? null
  }

  dispose(): void {
    if (this.#disposed) return
    this.closePopup()
    this.closeOffer()
    this.#disposed = true
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pending = null
    this.#split.clear()
    this.#linker.dispose()
  }
}
