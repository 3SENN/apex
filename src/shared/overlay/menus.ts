/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The menu overlay surfaces: the main menu; toasts, dialogs, QR code and
// task manager; and the downloads popover and flight.
import type { DialogSurfaceProps, QrSurfaceProps, TaskManagerSurfaceProps, ToastSurfaceProps } from '../dialogs'
import type { DownloadFlightProps, DownloadsPopoverProps } from '../downloads'
import type { MainMenuSurfaceProps } from '../menuBase'

export const MENUS_SURFACES = ['main-menu', 'toast', 'dialog', 'qr-code', 'task-manager', 'downloads', 'download-flight'] as const

export type MenusSurfaceId = (typeof MENUS_SURFACES)[number]

type L5aSurfaceProps = { 'main-menu': MainMenuSurfaceProps }
type L5bSurfaceProps = { toast: ToastSurfaceProps; dialog: DialogSurfaceProps; 'qr-code': QrSurfaceProps; 'task-manager': TaskManagerSurfaceProps }
type L5cSurfaceProps = { downloads: DownloadsPopoverProps; 'download-flight': DownloadFlightProps }

/** Surfaces without their own props type take a plain record. */
export type MenusSurfaceProps = { [S in Exclude<MenusSurfaceId, keyof L5aSurfaceProps | keyof L5bSurfaceProps | keyof L5cSurfaceProps>]: Record<string, unknown> } & L5aSurfaceProps & L5bSurfaceProps & L5cSurfaceProps
