/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { MigrationsServices } from '@shared/migrations'

// Argument schemas for Services.migrations. main/services.ts spreads them.
const chatId = z.string().regex(/^[0-9a-f-]{36}$/)

export const MIGRATIONS_SCHEMAS: { migrations: { [M in keyof MigrationsServices['migrations']]: z.ZodType<unknown[]> } } = {
  migrations: {
    report: z.tuple([]),
    retry: z.tuple([chatId]),
    retryAll: z.tuple([]),
    restoreBackup: z.tuple([chatId]),
    revealFile: z.tuple([chatId]),
  },
}
