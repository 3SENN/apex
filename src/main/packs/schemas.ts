/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The packs service's zod contracts (docs/packs.md): what the chrome may send.
import { z } from 'zod'
import { PACK_AUTH_ID_PATTERN, PACK_ENV_NAME_PATTERN, PACK_ID_PATTERN, PACK_ITEM_ID_PATTERN, PACK_SECRET_LIMITS, PACK_SHARE_IMAGE_MAX, PACK_SHARE_NOTE_MAX, isPackPath, type PacksServices } from '@shared/packs'
import type { SchemaMap } from '../schemas/types'

const id = z.string().regex(PACK_ID_PATTERN)
const itemId = z.string().regex(PACK_ITEM_ID_PATTERN)
const token = z.string().uuid()
const https = z.string().min(8).max(2048).regex(/^https?:\/\//i)
const path = z.string().max(300).refine(isPackPath)

export const PACKS_SCHEMAS: SchemaMap<PacksServices> = {
  packs: {
    state: z.tuple([]),
    get: z.tuple([id]),
    setEnabled: z.tuple([id, z.boolean()]),
    remove: z.tuple([id]),
    openedReview: z.tuple([token]),
    reviewFile: z.tuple([]),
    reviewLink: z.tuple([https]),
    reviewDraft: z.tuple([id]),
    reviewIndexEntry: z.tuple([https, id]),
    reviewUpdate: z.tuple([id]),
    confirmInstall: z.tuple([token]),
    cancelReview: z.tuple([token]),
    exportPack: z.tuple([
      id,
      z.enum(['installed', 'draft']),
      z
        .object({
          note: z.string().max(PACK_SHARE_NOTE_MAX).optional(),
          // A PNG data URL: base64 is a third larger than the bytes.
          image: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(Math.ceil((PACK_SHARE_IMAGE_MAX * 4) / 3) + 32).optional(),
        })
        .strict()
        .optional(),
    ]),
    appStill: z.tuple([id, itemId]),
    revokeGranted: z.tuple([id]),
    loadFolder: z.tuple([]),
    chooseAssets: z.tuple([id, itemId, itemId, z.string().max(80).regex(/^[a-z0-9][a-z0-9-]{1,31}\/[a-z0-9][a-z0-9-]{0,31}$/).nullable()]),
    reloadFolder: z.tuple([id]),
    openWorld: z.tuple([z.string().max(400).regex(/^(own:[a-z0-9][a-z0-9-]{0,47}|pack:[a-z0-9][a-z0-9-]{1,31}\/.{1,300})$/)]),
    setSecret: z.tuple([id, z.string().regex(PACK_ENV_NAME_PATTERN), z.string().max(PACK_SECRET_LIMITS.valueChars + 200)]),
    clearSecret: z.tuple([id, z.string().regex(PACK_ENV_NAME_PATTERN)]),
    signIn: z.tuple([id, z.string().regex(PACK_AUTH_ID_PATTERN)]),
    signOut: z.tuple([id, z.string().regex(PACK_AUTH_ID_PATTERN)]),
    remix: z.tuple([id, z.string().min(1).max(64).optional()]),
    startBuild: z.tuple([z.string().trim().min(1).max(10_000), z.string().min(1).max(64).optional()]),
    editDraft: z.tuple([id, z.string().min(1).max(64).optional()]),
    removeDraft: z.tuple([id]),
    revealDraft: z.tuple([id]),
    openPanel: z.tuple([id, itemId, z.boolean().optional()]),
    openApp: z.tuple([id, itemId]),
    sidebar: z.tuple([]),
    items: z.tuple([]),
    cards: z.tuple([]),
    openCard: z.tuple([id, itemId]),
    addRoutine: z.tuple([id, itemId]),
    addCompanion: z.tuple([id, path]),
    addConnector: z.tuple([id, itemId]),
    checkUpdates: z.tuple([]),
    addIndex: z.tuple([https]),
    signInIndex: z.tuple([https]),
    removeIndex: z.tuple([z.string().min(1).max(2048)]),
    browse: z.tuple([]),
    browseImage: z.tuple([z.string().min(8).max(2048), id]),
    findInBrowse: z.tuple([id]),
    clearLog: z.tuple([id]),
    saveLog: z.tuple([id]),
    shareAs: z.tuple([z.enum(['skill', 'tweak', 'app', 'companion']), z.string().min(1).max(128)]),
  },
}
