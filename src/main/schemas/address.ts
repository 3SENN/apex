/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { BOOKMARK_DEPTH_MAX, BOOKMARK_TITLE_MAX, BOOKMARK_URL_MAX, type BookmarkItem } from '@shared/bookmarks'
import { FIND_QUERY_MAX } from '@shared/find'
import { isCommandId } from '@shared/shortcuts'
import type { AddressServices, BookmarksServiceAdditions, FindServiceAdditions, PeekServiceAdditions } from '@shared/services/address'
import { idSchema, stepSchema, tabIdSchema, urlSchema, type AdditionSchemas, type SchemaMap } from './types'

// Argument schemas for the address services: zoom, the command bar and
// universal search, and the methods added to find and bookmarks.

const commandIdSchema = z.string().max(64).refine(isCommandId, 'Unknown command')

export const omniboxActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal('switch-tab'), tabId: tabIdSchema }).strict(),
  z.object({ kind: z.literal('command'), id: commandIdSchema }).strict(),
  z.object({ kind: z.literal('open-internal'), url: z.string().startsWith('apex://').max(2048) }).strict(),
  z.object({ kind: z.literal('ask'), text: z.string().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal('web-app'), appId: z.string().min(1).max(64) }).strict(),
])

const omniboxText = z.string().max(2048)
const bookmarkTitle = z.string().max(BOOKMARK_TITLE_MAX)
const bookmarkUrl = z.string().min(1).max(BOOKMARK_URL_MAX)
const parentIdSchema = idSchema
const indexSchema = z.number().int().min(0).max(100_000)

// A removed item comes back whole for Undo: a bounded tree.
const bookmarkItemSchema: z.ZodType<BookmarkItem> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('bookmark'),
        id: idSchema,
        title: bookmarkTitle,
        url: bookmarkUrl,
        createdAt: z.number().finite(),
        favicon: z.string().max(2048).nullable().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('folder'),
        id: idSchema,
        title: bookmarkTitle,
        createdAt: z.number().finite(),
        children: z.array(bookmarkItemSchema).max(10_000),
      })
      .strict(),
  ]),
) as z.ZodType<BookmarkItem>

function depthOk(item: BookmarkItem, depth = 0): boolean {
  if (depth > BOOKMARK_DEPTH_MAX) return false
  return item.kind === 'bookmark' || item.children.every((c) => depthOk(c, depth + 1))
}

export const ADDRESS_SCHEMAS: SchemaMap<AddressServices> = {
  zoom: {
    step: z.tuple([tabIdSchema, stepSchema]),
    reset: z.tuple([tabIdSchema]),
    get: z.tuple([tabIdSchema]),
  },
  omnibox: {
    query: z.tuple([omniboxText]),
    complete: z.tuple([omniboxText]),
    draft: z.tuple([tabIdSchema]),
    setDraft: z.tuple([tabIdSchema, omniboxText.nullable()]),
    commit: z.tuple([tabIdSchema, omniboxText, omniboxActionSchema, z.object({ background: z.boolean().optional(), newTab: z.boolean().optional() }).strict().optional()]),
    removeHistory: z.tuple([urlSchema]),
    universal: z.tuple([omniboxText, z.enum(['all', 'tabs', 'chats', 'pages'])]),
  },
}

export const FIND_SCHEMA_ADDITIONS: AdditionSchemas<FindServiceAdditions> = {
  open: z.tuple([tabIdSchema]),
  query: z.tuple([tabIdSchema, z.string().max(FIND_QUERY_MAX)]),
  step: z.tuple([tabIdSchema, z.boolean()]),
  close: z.tuple([tabIdSchema]),
  state: z.tuple([tabIdSchema]),
}

export const BOOKMARKS_SCHEMA_ADDITIONS: AdditionSchemas<BookmarksServiceAdditions> = {
  tree: z.tuple([]),
  add: z.tuple([z.object({ url: bookmarkUrl, title: bookmarkTitle, parentId: parentIdSchema.optional(), index: indexSchema.optional() }).strict()]),
  createFolder: z.tuple([parentIdSchema, bookmarkTitle, indexSchema.optional()]),
  update: z.tuple([idSchema, z.object({ title: bookmarkTitle.optional(), url: bookmarkUrl.optional(), parentId: parentIdSchema.optional() }).strict()]),
  move: z.tuple([idSchema, parentIdSchema, indexSchema]),
  removeItem: z.tuple([idSchema]),
  restore: z.tuple([z.object({ item: bookmarkItemSchema.refine((i) => depthOk(i), 'Too deep'), parentId: parentIdSchema, index: indexSchema }).strict()]),
  openAll: z.tuple([idSchema, z.object({ background: z.boolean().optional() }).strict().optional()]),
  exportHtml: z.tuple([]),
  importHtml: z.tuple([]),
  forUrl: z.tuple([urlSchema]),
}

export const PEEK_SCHEMA_ADDITIONS: AdditionSchemas<PeekServiceAdditions> = {
  showTab: z.tuple([tabIdSchema]),
}
