/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

// Shared pieces of the per-feature schema maps. Each feature exports a map
// with a zod tuple per method; main/services.ts spreads them and
// tests/core-schemaCoverage.test.ts fails when a method has none.

export type SchemaMap<T> = { [S in keyof T]: { [M in keyof T[S]]: z.ZodType<unknown[]> } }

/** Schemas for methods added to an existing namespace (tabs, split, chats, downloads). */
export type AdditionSchemas<T> = { [M in keyof T]: z.ZodType<unknown[]> }

export const tabIdSchema = z.string().min(1).max(64)
export const tabIdsSchema = z.array(tabIdSchema).min(1).max(2000)
export const chatIdSchema = z.string().regex(/^[0-9a-f-]{36}$/)
export const urlSchema = z.string().min(1).max(8192)
export const originSchema = z.string().min(1).max(2048).regex(/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/i)
export const idSchema = z.string().min(1).max(128)
export const windowIdSchema = z.number().int().min(1).max(1_000_000)
export const rectSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().min(0).max(100_000),
    height: z.number().finite().min(0).max(100_000),
  })
  .strict()
export const stepSchema = z.union([z.literal(1), z.literal(-1)])
