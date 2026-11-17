/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { TWEAK_COLORS, TWEAK_EXPORT_FORMAT, TWEAK_FONTS, TWEAK_LIMITS, type TweakColor, type TweaksServices } from '@shared/tweaks'
import type { SchemaMap } from '../schemas/types'

// Tweaks' zod contracts: the services the chrome calls, the page preload's
// messages, the tweaks file and the export format. Text limits are generous
// on the way in (the store trims and sanitises), strict on shape.
//
// Compatibility: files written before tweaks had their name (the old profile
// file, exports) still read, under today's names; see renamed() below.

const id = z.string().min(1).max(128)
const tabId = z.string().min(1).max(64)
const host = z.string().min(1).max(2048)
const color = z.string().regex(/^#[0-9a-f]{6}$/i)
const time = z.number().int().min(0).max(8_640_000_000_000_000)

const style = z
  .object({
    font: z.enum(TWEAK_FONTS),
    tint: z.enum(TWEAK_COLORS as [TweakColor, ...TweakColor[]]).nullable(),
    accent: color.nullable(),
    focus: z.boolean(),
  })
  .strict()

const hiddenElement = z.object({
  id: id.optional(),
  selector: z.string().min(1).max(TWEAK_LIMITS.selector),
  label: z.string().max(400).optional(),
  createdAt: time.optional(),
})

/** Compatibility: an object's old key read under its new name, when the new one isn't there. */
function renamed(raw: unknown, from: string, to: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const { [from]: old, ...rest } = raw as Record<string, unknown>
  return old === undefined || to in rest ? raw : { ...rest, [to]: old }
}

export const LEGACY_TWEAK_EXPORT_FORMAT = 'atelier-boosts' // compatibility: the export format before the rename

/** A tweak's shape in files (the tweaks file, an export) and when one comes back after removal. */
const tweakShape = z.object({
  id: id.optional(),
  host,
  subdomains: z.boolean().default(false),
  enabled: z.boolean().default(true),
  hidden: z.array(hiddenElement).max(TWEAK_LIMITS.hidden * 2).default([]),
  style: style.partial().default({}),
  css: z.string().max(TWEAK_LIMITS.css * 2).default(''),
  js: z.string().max(TWEAK_LIMITS.js * 2).default(''),
  jsEnabled: z.boolean().optional(),
  createdAt: time.optional(),
  updatedAt: time.optional(),
})

export type ImportedTweak = z.output<typeof tweakShape>

/** A tweak as a file holds it, today's or one written before the rename. */
const tweak = z.preprocess((raw) => renamed(raw, 'zaps', 'hidden'), tweakShape) // compatibility: hidden elements' old name

/** The profile's tweaks file: today's, or one from before the rename (version 1). */
export const tweakFileSchema = z.preprocess(
  (raw) => renamed(raw, 'boosts', 'tweaks'), // compatibility: the profile file's list before the rename
  z.object({
    version: z.number().int().min(1).optional(),
    scriptsAllowed: z.boolean().default(false),
    tweaks: z.array(tweak).max(TWEAK_LIMITS.tweaks * 2).default([]),
  }),
)

/** An exported file: today's, or one exported before the rename. */
export const tweakExportSchema = z.preprocess(
  (raw) => renamed(raw, 'boosts', 'tweaks'), // compatibility: exports before the rename
  z.object({
    format: z.enum([TWEAK_EXPORT_FORMAT, LEGACY_TWEAK_EXPORT_FORMAT]),
    version: z.number().int().min(1).max(1),
    tweaks: z.array(tweak).max(TWEAK_LIMITS.tweaks),
  }),
)

const patch = z
  .object({
    enabled: z.boolean(),
    subdomains: z.boolean(),
    css: z.string().max(TWEAK_LIMITS.css),
    js: z.string().max(TWEAK_LIMITS.js),
    jsEnabled: z.boolean(),
    style: style.partial(),
  })
  .partial()
  .strict()

/** A removed tweak handed back for Undo: its full shape, with its id. */
const restored = tweakShape.extend({ id })

export const TWEAKS_SCHEMAS: SchemaMap<TweaksServices> = {
  tweaks: {
    state: z.tuple([]),
    forTab: z.tuple([tabId]),
    create: z.tuple([host]),
    update: z.tuple([id, patch]),
    remove: z.tuple([id]),
    restore: z.tuple([restored]),
    removeHidden: z.tuple([id, id]),
    clearHidden: z.tuple([id]),
    setScriptsAllowed: z.tuple([z.boolean()]),
    hideElements: z.tuple([tabId]),
    openAndHide: z.tuple([id]),
    exportFile: z.tuple([z.array(id).max(TWEAK_LIMITS.tweaks).optional()]),
    importFile: z.tuple([]),
  },
}

/** PAGE.tweaks from the page preload. */
export const pageTweakMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('get'), url: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal('hide'), selector: z.string().min(1).max(TWEAK_LIMITS.selector), label: z.string().max(400) }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
  z.object({ kind: z.literal('done') }).strict(),
])
