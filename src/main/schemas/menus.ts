/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { DownloadsServiceAdditions, MenuServices } from '@shared/services/menus'
import { idSchema, rectSchema, tabIdSchema, urlSchema, type AdditionSchemas, type SchemaMap } from './types'
import { MAIN_MENU_SCHEMAS } from './mainMenu'
import { DIALOG_SCHEMAS } from './dialogs'

// Argument schemas for the menus services: page actions, and the methods added to the downloads service.
const tab = tabIdSchema.optional()

export const MENU_SCHEMAS: SchemaMap<MenuServices> = {
  menus: MAIN_MENU_SCHEMAS,
  ...DIALOG_SCHEMAS,
  pageActions: {
    copyUrl: z.tuple([tab]),
    copyMarkdownLink: z.tuple([tab]),
    copyAsMarkdown: z.tuple([tab]),
    screenshotToClipboard: z.tuple([tab]),
    copyLinkToHighlight: z.tuple([tab]),
    print: z.tuple([tab]),
    saveAsPdf: z.tuple([tab]),
    savePage: z.tuple([tab]),
    share: z.tuple([tab, rectSchema.optional()]),
    qrCode: z.tuple([tab]),
    viewSource: z.tuple([tab]),
    devtools: z.tuple([z.enum(['page', 'chrome', 'console', 'inspect'])]),
    copyQrCode: z.tuple([urlSchema]),
    saveQrCode: z.tuple([urlSchema]),
  },
}

export const DOWNLOADS_SCHEMA_ADDITIONS: AdditionSchemas<DownloadsServiceAdditions> = {
  retry: z.tuple([idSchema]),
  remove: z.tuple([idSchema]),
  keep: z.tuple([idSchema]),
  discard: z.tuple([idSchema]),
  startDrag: z.tuple([idSchema]),
  chooseFolder: z.tuple([]),
  resetFolder: z.tuple([]),
  folder: z.tuple([]),
}
