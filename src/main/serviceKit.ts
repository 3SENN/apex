/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A shared service kit: the 'Not available yet' stubs a feature answers
// with when it runs without its dependencies (unit tests with an empty
// context), and the zod atoms the newer service schemas share.
import { z } from 'zod'
import { COMPANION_ID } from './companions'
import { chatIdSchema, idSchema, originSchema, tabIdSchema } from './schemas/types'

export const NOT_YET = 'Not available yet'

export function notYet(): never {
  throw new Error(NOT_YET)
}

/** A namespace object whose every method throws 'Not available yet'. */
export function stubMethods<T extends object>(names: readonly (keyof T & string)[]): T {
  return Object.fromEntries(names.map((name) => [name, notYet])) as T
}

// ── Shared zod atoms for the service schemas (convention: .strict() objects, size caps) ──

// The base atoms (src/main/schemas/types.ts), so a service schema imports every atom from here.
export { chatIdSchema, idSchema, originSchema, tabIdSchema }
export const chatIdsSchema = z.union([chatIdSchema, z.array(chatIdSchema).min(1).max(1000)])
export const companionIdSchema = z.string().regex(COMPANION_ID)
/** A companion id or 'shared'. */
export const ownerSchema = z.string().regex(COMPANION_ID)
export const textSchema = (max: number): z.ZodString => z.string().max(max)
export const timeSchema = z.number().int().min(0).max(8_640_000_000_000_000)
export const rangeSchema = z.object({ from: timeSchema, to: timeSchema }).strict()
export const offsetSchema = z.number().int().min(0).max(1_000_000)
export const limitSchema = z.number().int().min(1).max(1000)
/** A relative path inside a granted root; the store confines it further (realpath, no escapes). */
export const relPathSchema = z.string().max(1024).refine((p) => !p.includes('\0') && !p.split(/[\\/]/).includes('..'), 'Path escapes its folder.')
export const base64Schema = (maxBytes: number): z.ZodString => z.string().max(Math.ceil((maxBytes * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/)
export const pngDataUrlSchema = z.string().max(4_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
