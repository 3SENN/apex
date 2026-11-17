/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { FilesServices, ViewerTarget } from '@shared/files'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for Services.files and viewer. main/services.ts
// spreads them. Paths are only shape-checked here; the viewer confines each
// one (realpath, symlinks) to Apex's folders or a path granted this session.

const fileId = z.string().uuid()
const token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
const name = z.string().trim().min(1).max(255).refine((n) => !/[\\/\0]/.test(n) && n !== '.' && n !== '..')
const relPath = z.string().min(1).max(1024).refine((p) => !p.includes('\0') && !p.split(/[\\/]/).includes('..'))
const recordId = z.string().min(1).max(128)
const chatId = z.string().regex(/^[0-9a-f-]{36}$/)

export const viewerTargetSchema: z.ZodType<ViewerTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), id: fileId }).strict(),
  z.object({ kind: z.literal('companion-file'), companionId: recordId, path: relPath }).strict(),
  z.object({ kind: z.literal('memory'), owner: recordId, path: relPath }).strict(),
  z.object({ kind: z.literal('skill'), skillId: recordId }).strict(),
  z.object({ kind: z.literal('meeting'), meetingId: recordId }).strict(),
  z.object({ kind: z.literal('chat-file'), chatId, path: relPath }).strict(),
  z.object({ kind: z.literal('attachment'), chatId, attachmentId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('local'), path: z.string().min(1).max(4096).regex(/^\//).refine((p) => !p.includes('\0')) }).strict(),
])

export const FILES_SCHEMAS: SchemaMap<FilesServices> = {
  files: {
    list: z.tuple([
      z.object({
        kind: z.enum(['generated', 'report', 'artifact']).optional(),
        chatId: chatId.optional(),
        companionId: recordId.optional(),
        query: z.string().max(500).optional(),
      }).strict().optional(),
    ]),
    rename: z.tuple([fileId, name]),
    remove: z.tuple([fileId]),
    reveal: z.tuple([fileId]),
    export: z.tuple([fileId]),
    openArtifact: z.tuple([fileId]),
  },
  viewer: {
    // The owner is the tab showing the document (a 't<n>' tab id); its token expires with it.
    open: z.tuple([viewerTargetSchema, z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()]),
    // Viewer edits are text files (Markdown, memory, skills); 2 MB like text attachments.
    save: z.tuple([token, z.string().max(2_000_000)]),
    rename: z.tuple([token, name]),
    remove: z.tuple([token]),
    reveal: z.tuple([token]),
    export: z.tuple([token]),
    pickLocal: z.tuple([]),
    // A dropped file's absolute path (the chrome reads it with webUtils); main checks it before granting.
    grantDropped: z.tuple([z.string().min(1).max(4096)]),
    release: z.tuple([token]),
    bytes: z.tuple([token]),
    openArtifact: z.tuple([token]),
  },
}
