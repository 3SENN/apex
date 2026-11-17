/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SurfaceMap, SurfaceModule } from '../../types'
import { downloadFlightSurface } from './download-flight'
import { downloadsSurface } from './downloads'
import { dialogSurface } from './dialog'
import { qrSurface } from './qr-code'
import { taskManagerSurface } from './task-manager'
import { toastSurface } from './toast'
import { mainMenuSurface } from './main-menu'

// The menu surfaces (main menu, toasts, dialogs, QR code, task manager, downloads).
// Each surface is registered here.
export const MENUS_SURFACE_MAP: SurfaceMap = {
  'main-menu': mainMenuSurface as unknown as SurfaceModule<never>,
  toast: toastSurface as unknown as SurfaceModule<never>,
  dialog: dialogSurface as unknown as SurfaceModule<never>,
  'qr-code': qrSurface as unknown as SurfaceModule<never>,
  'task-manager': taskManagerSurface as unknown as SurfaceModule<never>,
  // The registry keeps modules with their props type erased; each schema checks props at open
  downloads: downloadsSurface as unknown as SurfaceModule<never>,
  'download-flight': downloadFlightSurface as unknown as SurfaceModule<never>,
}
