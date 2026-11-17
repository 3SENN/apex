/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Calls in desktop apps: the apps Apex knows, and how
// the speech helper's `calls` snapshot (native/speech/CallWatch.swift) maps
// onto them. The helper only reports facts it can read without a prompt:
// which processes have the microphone open (Core Audio's process objects,
// macOS 14.4+) and which of the asked-about apps are running (NSWorkspace).
// Main decides what counts as a call (src/main/meetings/capture/desktopCalls.ts).
import type { MeetingProvider } from './meetingCapture'

export type DesktopCallAppId = 'zoom' | 'teams' | 'facetime' | 'webex' | 'slack' | 'discord' | 'meet-app'

export const DESKTOP_CALL_APP_IDS: readonly DesktopCallAppId[] = ['zoom', 'teams', 'facetime', 'webex', 'slack', 'discord', 'meet-app']

export interface DesktopCallAppSpec {
  id: DesktopCallAppId
  /** The app's own name: a proper noun, so it is not translated. */
  name: string
  /** Its bundle ids; each also matches its helper processes (`<id>.…`). */
  bundles: readonly string[]
  /** The meeting service, for matching a calendar event's link. */
  provider: MeetingProvider | null
  /**
   * Whether the other side of the call can be recorded from this app alone.
   * FaceTime's call audio is played by a system service, not the app, so its
   * meetings record the Mac's sound instead.
   */
  appAudio: boolean
}

export const DESKTOP_CALL_APPS: Record<DesktopCallAppId, DesktopCallAppSpec> = {
  zoom: { id: 'zoom', name: 'Zoom', bundles: ['us.zoom.xos'], provider: 'zoom', appAudio: true },
  teams: { id: 'teams', name: 'Microsoft Teams', bundles: ['com.microsoft.teams2', 'com.microsoft.teams'], provider: 'teams', appAudio: true },
  facetime: { id: 'facetime', name: 'FaceTime', bundles: ['com.apple.FaceTime'], provider: null, appAudio: false },
  webex: { id: 'webex', name: 'Webex', bundles: ['Cisco-Systems.Spark', 'com.webex.meetingmanager', 'com.cisco.webexmeetingsapp'], provider: 'webex', appAudio: true },
  slack: { id: 'slack', name: 'Slack', bundles: ['com.tinyspeck.slackmacgap'], provider: null, appAudio: true },
  discord: { id: 'discord', name: 'Discord', bundles: ['com.hnc.Discord'], provider: null, appAudio: true },
  // A Google Meet web app installed from Chrome, Edge or Brave: its sound comes from the browser.
  'meet-app': { id: 'meet-app', name: 'Google Meet', bundles: [], provider: 'meet', appAudio: true },
}

/** Browsers whose installed web apps run as `<browser>.app.<id>`. */
export const PWA_BROWSERS: readonly string[] = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.dev', 'com.google.Chrome.canary', 'com.microsoft.edgemac', 'com.brave.Browser']

/** FaceTime's calls run their audio in this system service. */
const FACETIME_SERVICE = { bundle: 'com.apple.avconferenced', exe: 'avconferenced' }

/** One process with audio running, from the helper's snapshot. */
export interface CallAudioProcess {
  pid: number
  /** The process's own bundle id (a helper's, for Electron and Chromium apps). */
  bundleId: string | null
  /** Its executable name, for system services without a bundle. */
  exe: string | null
  /** The app it belongs to (itself, or the nearest app among its parents). */
  appPid: number | null
  appBundleId: string | null
  input: boolean
  output: boolean
}

export interface CallRunningApp {
  pid: number
  bundleId: string
  name: string
}

/** The helper's `calls` line. */
export interface CallsSnapshot {
  /** False before macOS 14.4, where Core Audio has no process objects. */
  supported: boolean
  audio: CallAudioProcess[]
  apps: CallRunningApp[]
}

/** What one known app is doing right now. */
export interface CallUse {
  app: DesktopCallAppId
  input: boolean
  output: boolean
  /** The app is open (a call ends when it quits). */
  running: boolean
  /** Bundle ids whose sound is the other side of the call; empty records the Mac's sound. */
  audio: string[]
}

/** `id` is `prefix`, one of its helpers (`prefix.…`), or starts with a prefix that ends in a dot. */
export function bundleMatches(id: string | null | undefined, prefix: string): boolean {
  if (!id) return false
  if (prefix.endsWith('.')) return id.startsWith(prefix)
  return id === prefix || id.startsWith(`${prefix}.`)
}

/** The prefixes the helper reports running apps for: every known app, and the browsers' installed web apps. */
export function watchedBundles(): string[] {
  const out = new Set<string>()
  for (const spec of Object.values(DESKTOP_CALL_APPS)) for (const b of spec.bundles) out.add(b)
  for (const browser of PWA_BROWSERS) {
    out.add(browser)
    out.add(`${browser}.app.`)
  }
  return [...out]
}

function knownApp(id: string | null): DesktopCallAppId | null {
  if (!id) return null
  for (const spec of Object.values(DESKTOP_CALL_APPS)) if (spec.bundles.some((b) => bundleMatches(id, b))) return spec.id
  return null
}

function browserOf(id: string | null): string | null {
  if (!id) return null
  // The longest match first, so Chrome Beta isn't read as Chrome.
  return [...PWA_BROWSERS].sort((a, b) => b.length - a.length).find((b) => bundleMatches(id, b) && !id.startsWith(`${b}.app.`)) ?? null
}

/** A running Google Meet web app from `browser`. */
function meetApp(apps: readonly CallRunningApp[], browser: string): boolean {
  return apps.some((a) => a.bundleId.startsWith(`${browser}.app.`) && /\bgoogle meet\b|^meet$/i.test(a.name.trim()))
}

export interface AttributeOptions {
  /** Apex's own processes (main, renderers, helpers): their microphone use is never a desktop call. */
  ownPids: ReadonlySet<number>
  /** Apex's own bundle ids (each with its helpers). */
  ownBundles: readonly string[]
}

/**
 * Pure: which known apps are using audio in a snapshot. Apex's own processes
 * are left out (its tabs have their own meeting cards), FaceTime's audio
 * service counts for FaceTime while it is open, and a browser's microphone
 * counts for an open Google Meet web app.
 */
export function attributeCalls(snapshot: CallsSnapshot, o: AttributeOptions): Map<DesktopCallAppId, CallUse> {
  const uses = new Map<DesktopCallAppId, CallUse>()
  const use = (app: DesktopCallAppId): CallUse => {
    let u = uses.get(app)
    if (!u) {
      u = { app, input: false, output: false, running: false, audio: [] }
      uses.set(app, u)
    }
    return u
  }
  const own = (p: { pid: number | null; bundleId: string | null }): boolean =>
    (p.pid !== null && o.ownPids.has(p.pid)) || o.ownBundles.some((b) => bundleMatches(p.bundleId, b))

  const apps = snapshot.apps.filter((a) => !own(a))
  for (const a of apps) {
    const id = knownApp(a.bundleId)
    if (id) use(id).running = true
  }
  for (const browser of PWA_BROWSERS) if (meetApp(apps, browser)) use('meet-app').running = true
  const facetimeOpen = uses.get('facetime')?.running === true

  for (const p of snapshot.audio) {
    if (!p.input && !p.output) continue
    if (own({ pid: p.pid, bundleId: p.bundleId }) || own({ pid: p.appPid, bundleId: p.appBundleId })) continue
    let app = knownApp(p.appBundleId) ?? knownApp(p.bundleId)
    let audio: string[] = []
    if (app) {
      audio = DESKTOP_CALL_APPS[app].appAudio ? [...DESKTOP_CALL_APPS[app].bundles] : []
    } else if (facetimeOpen && (p.bundleId === FACETIME_SERVICE.bundle || p.exe === FACETIME_SERVICE.exe)) {
      app = 'facetime'
    } else {
      const browser = browserOf(p.appBundleId) ?? browserOf(p.bundleId)
      if (browser && meetApp(apps, browser)) {
        app = 'meet-app'
        audio = [browser]
      }
    }
    if (!app) continue
    const u = use(app)
    u.input ||= p.input
    u.output ||= p.output
    for (const b of audio) if (!u.audio.includes(b)) u.audio.push(b)
  }
  return uses
}
