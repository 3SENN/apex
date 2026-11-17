/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { desktopCapturer, webContents as allWebContents, type DesktopCapturerSource, type DisplayMediaRequestHandlerHandlerRequest, type NativeImage, type Session, type Streams } from 'electron'
import type { ScreenPickerAnswer } from '@shared/overlay/sites'
import type { AppEvent } from '@shared/services'
import type { ScreenSource, ScreenSources } from '@shared/sites'
import { siteKey } from '@shared/permissions'
import type { CaptureTracker } from './capture'
import { log } from './log'
import { permissionPolicy } from './permissionPolicy'
import { paneAnchor, presentSurface, resultValue, windowOfTab } from './siteOverlay'
import { sites } from './sites'
import { screenAccess } from './speech/screenAccess'
import type { TabRegistry } from './tabRegistry'
import type { Tab } from './tabs'
import type { WindowManager } from './windows'

// Screen sharing (OV-14). getDisplayMedia opens Apex's picker over the
// requesting tab: tabs of the same profile from every window (most recent
// first, never one the agent controls), windows and screens with fresh
// thumbnails, and a tab-audio switch when audio was asked for. Agent tabs
// are refused. The picker closes if its tab navigates or closes. macOS
// Screen Recording is asked for when you open Windows or Screens the first
// time (the picker calls speech.requestScreen), never when the picker opens.

const THUMB = { width: 320, height: 200 }

interface Pending {
  tab: Tab
  session: Session
  audio: boolean
  /** The sources last listed, by id: a tab or a desktop source. */
  sources: Map<string, { tab: Tab } | { desktop: DesktopCapturerSource }>
  settle(streams: Streams | null): void
}

export interface ScreenShareDeps {
  windows: WindowManager
  tabsRegistry: TabRegistry
  capture: CaptureTracker
  broadcast(event: AppEvent): void
  noteForAgent(tab: Tab, origin: string): void
  smoke: boolean
}

export class ScreenShare {
  readonly #deps: ScreenShareDeps
  readonly #pending = new Map<string, Pending>()

  constructor(deps: ScreenShareDeps) {
    this.#deps = deps
  }

  install(session: Session): void {
    session.setDisplayMediaRequestHandler((request, callback) => {
      void this.#handle(session, request)
        .then((streams) => callback(streams))
        .catch((err: unknown) => {
          log.warn('sites', 'Screen share request failed; refused', { error: err instanceof Error ? err.message : String(err) })
          callback(null)
        })
    })
  }

  /** The tab navigated or closed: its open picker goes, refused. */
  cancelTab(tabId: string): void {
    for (const [id, p] of this.#pending) {
      if (p.tab.id !== tabId) continue
      this.#pending.delete(id)
      p.settle(null)
      this.#deps.broadcast({ type: 'site-request', requestId: id, closed: true })
    }
  }

  async #handle(session: Session, request: DisplayMediaRequestHandlerHandlerRequest): Promise<Streams | null> {
    const frame = request.frame
    const wc = frame ? allWebContents.fromFrame(frame) : undefined
    const tab = wc ? this.#deps.tabsRegistry.byWebContents(wc.id) : undefined
    if (!tab || !wc) return null
    const origin = siteKey(request.securityOrigin) ?? request.securityOrigin
    const override = permissionPolicy.override({ origin, permission: 'display-capture', session, webContents: wc })
    if (override === 'deny') return null
    if (tab.agentControlled) {
      this.#deps.noteForAgent(tab, origin)
      return null
    }
    if (sites.storeFor(session)?.permission(origin, 'screen') === 'block') return null
    const win = windowOfTab(this.#deps.windows, tab)
    if (!win) return null

    const requestId = randomUUID()
    return new Promise<Streams | null>((resolve) => {
      let done = false
      const settle = (streams: Streams | null): void => {
        if (done) return
        done = true
        this.#pending.delete(requestId)
        resolve(streams)
      }
      this.#pending.set(requestId, { tab, session, audio: request.audioRequested, sources: new Map(), settle })
      void presentSurface(win, 'screen-picker', paneAnchor(win, tab), { requestId, host: hostOf(origin), audio: request.audioRequested }, tab.id).then((result) => {
        const pending = this.#pending.get(requestId)
        if (!pending) return
        const answer = parseAnswer(resultValue(result))
        settle(answer ? this.#streams(pending, answer) : null)
      })
    })
  }

  #streams(p: Pending, answer: ScreenPickerAnswer): Streams | null {
    const chosen = p.sources.get(answer.sourceId)
    if (!chosen) return null
    if ('tab' in chosen) {
      const target = chosen.tab
      if (target.view.webContents.isDestroyed() || target.agentControlled) return null
      const mainFrame = target.view.webContents.mainFrame
      this.#deps.capture.grant(p.tab.id, ['screen'], target.id)
      return { video: mainFrame, ...(p.audio && answer.audio ? { audio: mainFrame } : {}) }
    }
    this.#deps.capture.grant(p.tab.id, ['screen'])
    // System audio is only loopback-capturable on Windows.
    const audio = p.audio && answer.audio && process.platform === 'win32' && chosen.desktop.id.startsWith('screen:') ? { audio: 'loopback' as const } : {}
    return { video: chosen.desktop, ...audio }
  }

  /** The picker's sources for an open request, listed fresh each time it asks. */
  async sources(requestId: string): Promise<ScreenSources> {
    const p = this.#pending.get(requestId)
    if (!p) throw new Error('This screen share request has ended.')
    p.sources.clear()
    const tabs = await this.#tabSources(p)
    const access = await screenAccess().status()
    let desktop: ScreenSource[] = []
    // Without Screen Recording, listing would prompt or give blank pictures; smoke never lists the real screen.
    if (!this.#deps.smoke && (access === 'granted' || access === 'unsupported')) {
      try {
        const found = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: THUMB, fetchWindowIcons: true })
        desktop = found.map((s) => {
          p.sources.set(s.id, { desktop: s })
          const kind = s.id.startsWith('screen:') ? 'screen' : 'window'
          return { id: s.id, kind, name: s.name, thumbnail: s.thumbnail.isEmpty() ? null : jpeg(s.thumbnail), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32 }).toDataURL() : null, detail: null } satisfies ScreenSource
        })
      } catch (err) {
        log.warn('sites', 'Could not list windows and screens', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { sources: [...tabs, ...desktop], screenAccess: this.#deps.smoke && access !== 'granted' ? 'denied' : access }
  }

  async #tabSources(p: Pending): Promise<ScreenSource[]> {
    const candidates = this.#deps.windows
      .all()
      .flatMap((w) => w.tabs.all().map((tab) => ({ tab, win: w })))
      .filter(({ tab, win }) => win.session === p.session && tab !== p.tab && !tab.agentControlled && !tab.internalUrl && !tab.view.webContents.isDestroyed() && /^https?:/i.test(tab.view.webContents.getURL()))
      .sort((a, b) => b.tab.lastActiveAt - a.tab.lastActiveAt)
    const out: ScreenSource[] = []
    for (const { tab, win } of candidates) {
      const id = `tab:${tab.id}`
      p.sources.set(id, { tab })
      out.push({ id, kind: 'tab', name: tab.view.webContents.getTitle() || tab.view.webContents.getURL(), thumbnail: await tabThumbnail(tab), icon: tab.favicon, detail: win.window.isDestroyed() ? null : win.window.getTitle() || null })
    }
    return out
  }
}

async function tabThumbnail(tab: Tab): Promise<string | null> {
  try {
    const image = await tab.view.webContents.capturePage()
    if (image.isEmpty()) return null
    return jpeg(image.resize({ width: THUMB.width }))
  } catch {
    return null
  }
}

function jpeg(image: NativeImage): string {
  return `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`
}

function parseAnswer(value: unknown): ScreenPickerAnswer | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ScreenPickerAnswer>
  return typeof v.sourceId === 'string' ? { sourceId: v.sourceId, audio: v.audio === true } : null
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname || origin
  } catch {
    return origin
  }
}
