/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { NATIVE_TOP } from '@shared/menuBase'
import type { MainMenuServices } from '@shared/services/menus'

// Argument schemas for the main menu's service (SH-54 and SH-59).
const point = z.number().finite().min(-100_000).max(100_000)
// Item ids carry a page address for dynamic rows ('open:<url>'), so they allow a URL's length.
const itemId = z.string().min(1).max(8300)

export const MAIN_MENU_SCHEMAS: { [M in keyof MainMenuServices['menus']]: z.ZodType<unknown[]> } = {
  mainMenu: z.tuple([]),
  run: z.tuple([itemId]),
  popupTop: z.tuple([z.enum(NATIVE_TOP as [string, ...string[]]), point, point]),
}
