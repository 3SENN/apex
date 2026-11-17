/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { webContents as allWebContents, type BluetoothDevice, type HIDDevice, type SerialPort, type Session, type USBDevice, type WebContents, type WebFrameMain } from 'electron'
import type { DeviceChooserAnswer, DeviceChooserProps } from '@shared/overlay/sites'
import { siteKey } from '@shared/permissions'
import type { AppEvent } from '@shared/services'
import type { DeviceEntry, DeviceKind, GrantedDevice, PairingStep } from '@shared/sites'
import { log } from './log'
import { permissionPolicy } from './permissionPolicy'
import { presentSurface, paneAnchor, resultValue, windowOfTab } from './siteOverlay'
import { sites } from './sites'
import type { TabRegistry } from './tabRegistry'
import type { Tab } from './tabs'
import type { WindowManager } from './windows'

// The device chooser (OV-15): HID, USB, serial and Bluetooth requests
// open one modal chooser with a live list. A connected device can be
// remembered for the site (sites.json, never in a private window); otherwise
// the grant lasts while one of the site's tabs in that session is open, and
// site info shows it with Revoke. Resetting the site or blocking the kind
// ends it too. Agent-controlled tabs are refused (the chooser, and the
// permission check behind getDevices()), and Bluetooth pairing (Windows and
// Linux) asks through the same surface.

type AnyDevice = HIDDevice | USBDevice | SerialPort | BluetoothDevice

interface Pending {
  kind: DeviceKind
  tab: Tab
  session: Session
  origin: string
  /** Electron's device id → what the list shows and what a grant keeps. */
  devices: Map<string, { entry: DeviceEntry; key: string }>
  scanning: boolean
  settle(deviceId: string | null): void
}

export interface DeviceDeps {
  windows: WindowManager
  tabsRegistry: TabRegistry
  broadcast(event: AppEvent): void
  noteForAgent(tab: Tab, origin: string, kind: DeviceKind): void
  isPrivate(session: Session): boolean
}

/** A device's identity that survives restarts (Electron's ids are per session). */
export function deviceKey(kind: DeviceKind, d: AnyDevice): string {
  if (kind === 'bluetooth') return (d as BluetoothDevice).deviceId
  if (kind === 'serial') {
    const p = d as SerialPort
    return p.vendorId && p.productId ? `${p.vendorId}:${p.productId}:${p.serialNumber ?? ''}` : `port:${p.portName}`
  }
  const u = d as HIDDevice | USBDevice
  return `${u.vendorId}:${u.productId}:${u.serialNumber ?? ''}`
}

/** What the chooser shows for a device. */
export function deviceEntry(kind: DeviceKind, d: AnyDevice, unnamed: string): DeviceEntry {
  const hex = (n: number | string | undefined): string => (typeof n === 'number' ? n.toString(16).padStart(4, '0') : (n ?? ''))
  switch (kind) {
    case 'hid': {
      const h = d as HIDDevice
      return { id: h.deviceId, name: h.name || unnamed, detail: `${hex(h.vendorId)}:${hex(h.productId)}` }
    }
    case 'usb': {
      const u = d as USBDevice
      return { id: u.deviceId, name: u.productName || u.manufacturerName || unnamed, detail: u.productName && u.manufacturerName ? u.manufacturerName : `${hex(u.vendorId)}:${hex(u.productId)}` }
    }
    case 'serial': {
      const p = d as SerialPort
      return { id: p.portId, name: p.displayName || p.portName || unnamed, detail: p.portName || null }
    }
    case 'bluetooth': {
      const b = d as BluetoothDevice
      return { id: b.deviceId, name: b.deviceName || unnamed, detail: null }
    }
  }
}

export class DeviceChooser {
  readonly #deps: DeviceDeps
  readonly #pending = new Map<string, Pending>()
  /** Grants made without "remember": session → "origin|kind|key" → the device. */
  readonly #sessionGrants = new WeakMap<Session, Map<string, { origin: string; device: GrantedDevice }>>()
  readonly #unnamed: string

  constructor(deps: DeviceDeps, unnamed: string) {
    this.#deps = deps
    this.#unnamed = unnamed
  }

  install(session: Session): void {
    session.on('select-hid-device', (event, details, callback) => {
      event.preventDefault()
      this.#open(session, 'hid', frameContents(details.frame), details.deviceList, (id) => callback(id ?? undefined))
    })
    session.on('hid-device-added', (_e, d) => this.#change(frameContents(d.frame), 'hid', d.device, true))
    session.on('hid-device-removed', (_e, d) => this.#change(frameContents(d.frame), 'hid', d.device, false))
    session.on('select-usb-device', (event, details, callback) => {
      event.preventDefault()
      this.#open(session, 'usb', frameContents(details.frame), details.deviceList, (id) => callback(id ?? undefined))
    })
    session.on('usb-device-added', (_e, device, wc) => this.#change(wc, 'usb', device, true))
    session.on('usb-device-removed', (_e, device, wc) => this.#change(wc, 'usb', device, false))
    session.on('select-serial-port', (event, ports, wc, callback) => {
      event.preventDefault()
      this.#open(session, 'serial', wc, ports, (id) => callback(id ?? ''))
    })
    session.on('serial-port-added', (_e, port, wc) => this.#change(wc, 'serial', port, true))
    session.on('serial-port-removed', (_e, port, wc) => this.#change(wc, 'serial', port, false))
    session.setDevicePermissionHandler((details) => {
      const origin = siteKey(details.origin)
      if (!origin) return false
      // The check names no tab, so the agent at work on any of the site's tabs refuses it (OV-12).
      if (this.#agentOn(session, origin)) return false
      if (sites.storeFor(session)?.permission(origin, details.deviceType) === 'block') return false
      const key = deviceKey(details.deviceType, details.device)
      return this.isGranted(session, origin, details.deviceType, key)
    })
    // macOS pairs by itself; Windows and Linux ask through the chooser.
    if (process.platform !== 'darwin') {
      session.setBluetoothPairingHandler((details, callback) => {
        void this.#pair(details.deviceId, details.pairingKind, details.pin, frameContents(details.frame)).then(callback)
      })
    }
  }

  /** Bluetooth's chooser event belongs to each tab's webContents; it fires again as devices are found. */
  attachTab(tab: Tab, session: Session): () => void {
    const wc = tab.view.webContents
    let requestId: string | null = null
    const listener = (event: Electron.Event, devices: BluetoothDevice[], callback: (deviceId: string) => void): void => {
      event.preventDefault()
      const open = requestId ? this.#pending.get(requestId) : undefined
      if (open) {
        for (const d of devices) open.devices.set(d.deviceId, { entry: deviceEntry('bluetooth', d, this.#unnamed), key: deviceKey('bluetooth', d) })
        this.#publish(requestId!, open)
        return
      }
      requestId = this.#open(session, 'bluetooth', wc, devices, (id) => {
        requestId = null
        callback(id ?? '')
      })
    }
    wc.on('select-bluetooth-device', listener)
    return () => {
      if (!wc.isDestroyed()) wc.off('select-bluetooth-device', listener)
    }
  }

  isGranted(session: Session, origin: string, kind: DeviceKind, key: string): boolean {
    if (this.#sessionGrants.get(session)?.has(`${origin}|${kind}|${key}`)) return true
    return sites.storeFor(session)?.get(origin).devices.some((d) => d.kind === kind && d.id === key) ?? false
  }

  /** Site info's Revoke: the stored grant and the session's go. */
  revoke(session: Session, origin: string, device: Pick<GrantedDevice, 'kind' | 'id'>): void {
    this.#sessionGrants.get(session)?.delete(`${origin}|${device.kind}|${device.id}`)
    const store = sites.storeFor(session)
    const stored = store?.get(origin).devices ?? []
    if (stored.some((d) => d.kind === device.kind && d.id === device.id)) store?.set(origin, { devices: stored.filter((d) => !(d.kind === device.kind && d.id === device.id)) })
  }

  /** The site was reset (every kind) or a kind was blocked: its session grants go. */
  revokeSite(session: Session, origin: string, kinds?: readonly DeviceKind[]): void {
    const grants = this.#sessionGrants.get(session)
    for (const [key, g] of grants ?? []) if (g.origin === origin && (!kinds || kinds.includes(g.device.kind))) grants?.delete(key)
  }

  /** What a site may use until its tabs close, for site info. */
  sessionDevices(session: Session, origin: string): GrantedDevice[] {
    return [...(this.#sessionGrants.get(session)?.values() ?? [])].filter((g) => g.origin === origin).map((g) => ({ ...g.device }))
  }

  /** A tab closed: session grants of sites with no other tab open in that session end. */
  tabClosed(tabId: string, session: Session): void {
    const grants = this.#sessionGrants.get(session)
    if (!grants || grants.size === 0) return
    const open = new Set<string>()
    for (const t of this.#deps.tabsRegistry.all()) {
      if (t.id === tabId) continue
      const wc = t.view.webContents
      if (wc.isDestroyed() || wc.session !== session) continue
      const origin = siteKey(wc.getURL() || t.requestedUrl)
      if (origin) open.add(origin)
    }
    for (const [key, g] of grants) if (!open.has(g.origin)) grants.delete(key)
  }

  #agentOn(session: Session, origin: string): boolean {
    return this.#deps.tabsRegistry.all().some((t) => {
      const wc = t.view.webContents
      return t.agentControlled && !wc.isDestroyed() && wc.session === session && siteKey(wc.getURL()) === origin
    })
  }

  /** The tab navigated or closed: its chooser goes, cancelled. */
  cancelTab(tabId: string): void {
    for (const [id, p] of this.#pending) if (p.tab.id === tabId) this.#finish(id, null)
  }

  #open(session: Session, kind: DeviceKind, wc: WebContents | null | undefined, list: readonly AnyDevice[], settle: (deviceId: string | null) => void): string | null {
    const tab = wc && !wc.isDestroyed() ? this.#deps.tabsRegistry.byWebContents(wc.id) : undefined
    const origin = tab ? siteKey(tab.view.webContents.getURL()) : null
    if (!tab || !origin || !wc) {
      settle(null)
      return null
    }
    if (permissionPolicy.override({ origin, permission: kind, session, webContents: wc }) === 'deny' || sites.storeFor(session)?.permission(origin, kind) === 'block') {
      settle(null)
      return null
    }
    if (tab.agentControlled) {
      this.#deps.noteForAgent(tab, origin, kind)
      settle(null)
      return null
    }
    const win = windowOfTab(this.#deps.windows, tab)
    if (!win) {
      settle(null)
      return null
    }
    const requestId = randomUUID()
    const devices = new Map(list.map((d) => [deviceEntry(kind, d, this.#unnamed).id, { entry: deviceEntry(kind, d, this.#unnamed), key: deviceKey(kind, d) }]))
    const pending: Pending = { kind, tab, session, origin, devices, scanning: kind === 'bluetooth', settle }
    this.#pending.set(requestId, pending)
    const props: DeviceChooserProps = {
      requestId,
      kind,
      host: hostOf(origin),
      devices: [...devices.values()].map((d) => d.entry),
      scanning: pending.scanning,
      pairing: null,
      pairingName: null,
      canRemember: !this.#deps.isPrivate(session) && !!sites.storeFor(session)?.persistent,
    }
    void presentSurface(win, 'device-chooser', paneAnchor(win, tab), props, tab.id).then((result) => {
      const p = this.#pending.get(requestId)
      if (!p) return
      const answer = resultValue(result) as Partial<Extract<DeviceChooserAnswer, { deviceId: string }>> | null
      const chosen = answer && typeof answer.deviceId === 'string' ? p.devices.get(answer.deviceId) : undefined
      if (chosen) this.#grant(p, chosen.entry, chosen.key, answer?.remember === true)
      this.#finish(requestId, chosen ? chosen.entry.id : null)
    })
    // Bluetooth keeps scanning for a while; after that the list is what it is.
    if (kind === 'bluetooth') {
      setTimeout(() => {
        const p = this.#pending.get(requestId)
        if (!p) return
        p.scanning = false
        this.#publish(requestId, p)
      }, 10_000)
    }
    return requestId
  }

  #change(wc: WebContents | null | undefined, kind: DeviceKind, device: AnyDevice, added: boolean): void {
    if (!wc) return
    for (const [id, p] of this.#pending) {
      if (p.kind !== kind || p.tab.view.webContents !== wc) continue
      const entry = deviceEntry(kind, device, this.#unnamed)
      if (added) p.devices.set(entry.id, { entry, key: deviceKey(kind, device) })
      else p.devices.delete(entry.id)
      this.#publish(id, p)
    }
  }

  #publish(requestId: string, p: Pending): void {
    this.#deps.broadcast({ type: 'site-request', requestId, devices: [...p.devices.values()].map((d) => d.entry), scanning: p.scanning })
  }

  #grant(p: Pending, entry: DeviceEntry, key: string, remember: boolean): void {
    const store = sites.storeFor(p.session)
    if (remember && store?.persistent && !this.#deps.isPrivate(p.session)) {
      const devices = store.get(p.origin).devices.filter((d) => !(d.kind === p.kind && d.id === key))
      store.set(p.origin, { devices: [...devices, { kind: p.kind, id: key, name: entry.name }] })
      return
    }
    let grants = this.#sessionGrants.get(p.session)
    if (!grants) this.#sessionGrants.set(p.session, (grants = new Map()))
    grants.set(`${p.origin}|${p.kind}|${key}`, { origin: p.origin, device: { kind: p.kind, id: key, name: entry.name } })
  }

  #finish(requestId: string, deviceId: string | null): void {
    const p = this.#pending.get(requestId)
    if (!p) return
    this.#pending.delete(requestId)
    try {
      p.settle(deviceId)
    } catch (err) {
      log.debug('sites', 'A device request had already ended', { error: err instanceof Error ? err.message : String(err) })
    }
    this.#deps.broadcast({ type: 'site-request', requestId, closed: true })
  }

  async #pair(deviceId: string, kind: 'confirm' | 'confirmPin' | 'providePin', pin: string | undefined, wc: WebContents | null): Promise<{ confirmed: boolean; pin?: string | null }> {
    const tab = wc && !wc.isDestroyed() ? this.#deps.tabsRegistry.byWebContents(wc.id) : undefined
    const win = tab ? windowOfTab(this.#deps.windows, tab) : null
    if (!tab || !win || tab.agentControlled) return { confirmed: false }
    const origin = siteKey(tab.view.webContents.getURL()) ?? ''
    const step: PairingStep = kind === 'confirm' ? { kind: 'confirm' } : kind === 'confirmPin' ? { kind: 'confirm-pin', pin: pin ?? '' } : { kind: 'provide-pin' }
    const props: DeviceChooserProps = {
      requestId: randomUUID(),
      kind: 'bluetooth',
      host: hostOf(origin),
      devices: [],
      scanning: false,
      pairing: step,
      pairingName: this.#bluetoothName(deviceId),
      canRemember: false,
    }
    const answer = resultValue(await presentSurface(win, 'device-chooser', paneAnchor(win, tab), props, tab.id)) as Partial<Extract<DeviceChooserAnswer, { confirmed: boolean }>> | null
    if (!answer || answer.confirmed !== true) return { confirmed: false }
    return step.kind === 'provide-pin' ? { confirmed: typeof answer.pin === 'string' && answer.pin.length > 0, pin: answer.pin ?? null } : { confirmed: true }
  }

  #bluetoothName(deviceId: string): string | null {
    for (const p of this.#pending.values()) {
      const d = p.devices.get(deviceId)
      if (d) return d.entry.name
    }
    return null
  }
}

function frameContents(frame: WebFrameMain | null | undefined): WebContents | null {
  if (!frame) return null
  try {
    return allWebContents.fromFrame(frame) ?? null
  } catch {
    return null
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname || origin
  } catch {
    return origin
  }
}
