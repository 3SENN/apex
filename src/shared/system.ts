/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The system contract: background mode, the login item and OS integration
// (OV-09, ST-09, the Windows and Linux runtime). Login-item state is
// always read from the OS and never stored in settings.

import { BUNDLE_ID } from './release'

export type LoginItemStatus = 'enabled' | 'disabled' | 'requires-approval' | 'not-found' | 'unsupported'

export interface LoginItemState {
  supported: boolean
  openAtLogin: boolean
  status: LoginItemStatus
}

export const UNSUPPORTED_LOGIN_ITEM: LoginItemState = { supported: false, openAtLogin: false, status: 'unsupported' }

/** What a Windows taskbar overlay shows, highest priority first: attention, unread, then the companion (ST-09). */
export type TaskbarOverlayKind = 'companion' | 'attention' | 'unread'

/** NodeJS.Platform, spelled out: the renderer's typecheck has no Node types. */
export type OsPlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd'

export interface BackgroundPolicyInput {
  platform: OsPlatform
  /** The setting, and (on Linux) a tray to keep running in. */
  runInBackground: boolean
  /** Open app windows the person can see. */
  windowCount: number
  quitting: boolean
  /** True only for the start-up decision of a launch at login. */
  openedAtLogin: boolean
}

/** What to do when the last window closes or the app starts at login. */
export type BackgroundDecision = 'quit' | 'stay-in-tray' | 'hide-dock' | 'none'

export interface SystemServices {
  system: {
    loginItem(): LoginItemState
    setOpenAtLogin(on: boolean): LoginItemState
    /** macOS: opens System Settings › General › Login Items (Windows: Settings › Apps › Startup). */
    openLoginItemsSettings(): void
    /**
     * Windows: the image for one taskbar overlay kind; null clears that kind.
     * Main shows the highest-priority kind whose condition holds (attention,
     * then unread, then the companion). `description` is the accessible text.
     */
    setTaskbarOverlay(kind: TaskbarOverlayKind, pngDataUrl: string | null, description: string): void
    /** Linux without a tray hides the background-mode row. */
    trayAvailable(): boolean
  }
}

export type SystemEvent = { type: 'login-item'; state: LoginItemState }

/** The argument a launch at login carries (Windows Run key, Linux autostart), so Atelier can start without a window. */
export const LAUNCH_AT_LOGIN_FLAG = '--background'

/** The Linux desktop entry the installer adds (executableName `atelier`); xdg-settings and autostart name it. */
export const LINUX_DESKTOP_ENTRY = 'atelier.desktop'

/** Windows: the AppUserModelId, equal to electron-builder's appId, so notifications and the taskbar group under Atelier. */
export const APP_USER_MODEL_ID = BUNDLE_ID

/** Windows and Linux: the window controls overlay's height, matching the chrome's --bar-height. */
export const TITLE_BAR_HEIGHT = 40
