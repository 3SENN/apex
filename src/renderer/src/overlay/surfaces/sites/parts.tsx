/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import { AppWindow, Bell, Bluetooth, Cable, Camera, Clipboard, Coffee, ExternalLink, FolderOpen, MapPin, Mic, MonitorUp, Network, Piano, Speaker, Type, Usb, Cpu } from 'lucide-react'
import type { AppEvent } from '@shared/services'
import type { SitePermission } from '@shared/sites'
import { apex } from '../../../api'

// Small pieces the site surfaces share: a glyph per permission, and the hook a
// surface uses to follow its request in main (closed early, or a device list
// that moved).

const ICONS: Record<SitePermission, typeof Camera> = {
  camera: Camera,
  microphone: Mic,
  location: MapPin,
  notifications: Bell,
  'clipboard-read': Clipboard,
  'local-fonts': Type,
  'idle-detection': Coffee,
  hid: Cpu,
  usb: Usb,
  serial: Cable,
  bluetooth: Bluetooth,
  'speaker-selection': Speaker,
  'local-network': Network,
  midi: Piano,
  screen: MonitorUp,
  'file-system': FolderOpen,
  'external-app': ExternalLink,
  'window-management': AppWindow,
}

export function PermIcon({ perm, size = 16 }: { perm: SitePermission; size?: number }): ReactElement {
  const Icon = ICONS[perm] ?? AppWindow
  return <Icon size={size} aria-hidden />
}

type RequestEvent = Extract<AppEvent, { type: 'site-request' }>

/** Follows main's updates for one request: `onClosed` when it ended there, `onChange` for anything else. */
export function useSiteRequest(requestId: string, handlers: { onClosed(): void; onChange?(e: RequestEvent): void }): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(
    () =>
      apex.onAppEvent((event) => {
        if (event.type !== 'site-request' || event.requestId !== requestId) return
        if (event.closed) latest.current.onClosed()
        else latest.current.onChange?.(event)
      }),
    [requestId],
  )
}
