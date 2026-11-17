/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { MainMenuSurfaceProps } from '@shared/menuBase'
import type { MenuItemModel } from '@shared/menuModel'
import type { SurfaceModule } from '../../../types'
import { CASCADE_MENU_POLICY } from '../../../kit/host'
import { MainMenu } from './MainMenu'

// The `main-menu` surface (SH-54, SH-16, DS-93): the model main built,
// checked again at open. Menus close on a tab switch, a click outside and
// Escape, and exit at once (DS-83's instant exit). Its side cards reach past
// the root card, so it takes the cascade policy (the window as a layer).

const menuItem: z.ZodType<MenuItemModel> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(8300),
      label: z.string().max(300),
      type: z.enum(['normal', 'separator', 'checkbox', 'radio']).optional(),
      commandId: z.string().max(64).optional(),
      accelerator: z.string().max(64).optional(),
      enabled: z.boolean().optional(),
      checked: z.boolean().optional(),
      icon: z.string().max(64).optional(),
      role: z.string().max(64).optional(),
      submenu: z.array(menuItem).max(200).optional(),
      variant: z.enum(['switch', 'header', 'note']).optional(),
      visible: z.boolean().optional(),
      image: z.string().max(8192).optional(),
    })
    .strict(),
) as z.ZodType<MenuItemModel>

const props = z
  .object({
    model: z
      .object({
        platform: z.string().max(32),
        appName: z.string().max(100),
        items: z.array(menuItem).max(200),
        theme: z.enum(['system', 'light', 'dark']),
        layout: z.enum(['sidebar', 'horizontal']),
        accent: z.string().max(32),
        adblock: z.boolean(),
        zoomPercent: z.number().finite().min(0).max(1000).nullable(),
      })
      .strict(),
    profile: z
      .object({
        name: z.string().max(200),
        avatar: z.string().max(2_000_000).nullable(),
        engine: z.string().min(1).max(64),
        hasApiKey: z.boolean(),
      })
      .strict(),
    spend: z.object({ usd: z.number().finite().min(0), budgetUsd: z.number().finite().min(0).nullable() }).strict().nullable(),
    placement: z.enum(['above', 'below']),
  })
  .strict()

export const mainMenuSurface: SurfaceModule<MainMenuSurfaceProps> = {
  component: MainMenu,
  props: props as unknown as z.ZodType<MainMenuSurfaceProps>,
  policy: CASCADE_MENU_POLICY,
}
