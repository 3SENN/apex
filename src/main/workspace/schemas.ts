/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace service schemas: search everything, watched
// folders, versions, projects, spaces and Recently Deleted.
import { z } from 'zod'
import { SEARCH_SOURCES, TRASH_KINDS, type WorkspaceServices } from '@shared/workspace'
import { chatIdSchema, companionIdSchema, idSchema, limitSchema, offsetSchema, ownerSchema, relPathSchema, tabIdSchema, textSchema } from '../serviceKit'
import { viewerTargetSchema } from '../files/schemas'
import { windowIdSchema, type SchemaMap } from '../schemas/types'

export const fileRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), folderId: idSchema, path: relPathSchema }).strict(),
  z.object({ kind: z.literal('companion'), companionId: companionIdSchema, path: relPathSchema }).strict(),
  z.object({ kind: z.literal('memory'), owner: ownerSchema, path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('skill'), skillId: idSchema, path: relPathSchema }).strict(),
  z.object({ kind: z.literal('library'), id: idSchema }).strict(),
  z.object({ kind: z.literal('app'), appId: idSchema }).strict(),
])

const folderMode = z.enum(['read', 'read-write'])
const folderScope = z.union([z.literal('all-chats'), z.object({ chatId: chatIdSchema }).strict()])
/** An absolute folder path the person picked; FolderAccess re-checks it with realpath. */
const absolutePath = z.string().min(1).max(4096).refine((p) => !p.includes('\0'), 'Invalid path.')
const windowId = windowIdSchema
const project = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^[a-z0-9-]{1,32}$/),
  description: textSchema(2_000),
  instructions: textSchema(20_000),
}).strict()

export const WORKSPACE_SCHEMAS: SchemaMap<WorkspaceServices> = {
  search: {
    query: z.tuple([textSchema(500), z.object({ sources: z.array(z.enum(SEARCH_SOURCES)).max(SEARCH_SOURCES.length).optional(), limit: limitSchema.optional(), offset: offsetSchema.optional() }).strict().optional()]),
    recent: z.tuple([z.object({ sources: z.array(z.enum(SEARCH_SOURCES)).max(SEARCH_SOURCES.length).optional(), limit: limitSchema.optional() }).strict().optional()]),
    state: z.tuple([]),
    rebuild: z.tuple([]),
  },
  folders: {
    list: z.tuple([]),
    pick: z.tuple([]),
    grant: z.tuple([z.object({ path: absolutePath, mode: folderMode, scope: folderScope, companionId: companionIdSchema.nullable().optional() }).strict()]),
    update: z.tuple([idSchema, z.object({ mode: folderMode.optional(), scope: folderScope.optional() }).strict()]),
    revoke: z.tuple([idSchema]),
    entries: z.tuple([idSchema, relPathSchema]),
    readText: z.tuple([idSchema, relPathSchema.min(1)]),
    reveal: z.tuple([idSchema, relPathSchema]),
    open: z.tuple([idSchema, relPathSchema.min(1)]),
  },
  versions: {
    list: z.tuple([fileRef]),
    read: z.tuple([fileRef, idSchema]),
    restore: z.tuple([fileRef, idSchema]),
    refFor: z.tuple([viewerTargetSchema]),
  },
  projects: {
    list: z.tuple([]),
    get: z.tuple([idSchema]),
    save: z.tuple([project]),
    remove: z.tuple([idSchema]),
    addChats: z.tuple([idSchema, z.array(chatIdSchema).min(1).max(1000)]),
    removeChats: z.tuple([idSchema, z.array(chatIdSchema).min(1).max(1000)]),
    addFiles: z.tuple([idSchema, z.array(fileRef).min(1).max(500)]),
    removeFiles: z.tuple([idSchema, z.array(fileRef).min(1).max(500)]),
    newChat: z.tuple([idSchema, textSchema(20_000).optional()]),
    contextFiles: z.tuple([idSchema]),
  },
  spaces: {
    list: z.tuple([windowId.optional()]),
    switchTo: z.tuple([idSchema.nullable(), windowId.optional()]),
    moveTabs: z.tuple([z.array(tabIdSchema).min(1).max(2000), idSchema.nullable()]),
  },
  trash: {
    list: z.tuple([z.object({ kind: z.enum(TRASH_KINDS).optional(), query: textSchema(500).optional() }).strict().optional()]),
    restore: z.tuple([z.array(idSchema).min(1).max(1000)]),
    purge: z.tuple([z.array(idSchema).min(1).max(1000)]),
    empty: z.tuple([]),
  },
}
