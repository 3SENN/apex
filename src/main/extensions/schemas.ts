/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { EXTENSION_ID, type ExtensionsServices } from '@shared/extensions'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for Services.extensions. main/services.ts spreads them.

const extensionId = z.string().regex(EXTENSION_ID)
const promptId = z.string().uuid()
const edge = z.number().finite().min(-10_000).max(100_000)
const anchor = z.object({ x: edge, y: edge, width: z.number().finite().min(0).max(10_000), height: z.number().finite().min(0).max(10_000) }).strict()

export const EXTENSIONS_SCHEMAS: SchemaMap<ExtensionsServices> = {
  extensions: {
    list: z.tuple([]),
    setEnabled: z.tuple([extensionId, z.boolean()]),
    pin: z.tuple([extensionId, z.boolean()]),
    remove: z.tuple([extensionId]),
    revoke: z.tuple([extensionId, z.string().min(1).max(256)]),
    runAction: z.tuple([extensionId, anchor]),
    openStore: z.tuple([]),
    report: z.tuple([extensionId]),
    respondInstall: z.tuple([promptId, z.boolean()]),
    respondNative: z.tuple([promptId, z.enum(['once', 'always', 'deny'])]),
  },
  applePasswords: {
    status: z.tuple([]),
    setOn: z.tuple([z.boolean()]),
    pairAgain: z.tuple([]),
  },
}
