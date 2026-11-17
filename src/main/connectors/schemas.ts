/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { DIRECTORY_ID, LOGO_MAX_BYTES, TOOL_POLICIES, type ConnectorsServices } from '@shared/connectors'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for the methods added to Services.connectors.
// main/services.ts merges them into the connectors namespace. Secrets and
// commands are size-capped here; nothing pasted or imported ever starts a
// local server without approveLocalStart.

const id = z.string().min(1).max(128)
const toolName = z.string().min(1).max(128)
const policy = z.enum(TOOL_POLICIES as [string, ...string[]])
const directoryId = z.string().regex(DIRECTORY_ID)
const fields = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(4096)).refine((r) => Object.keys(r).length <= 20)

export const CONNECTORS_SCHEMAS: SchemaMap<ConnectorsServices> = {
  connectors: {
    directory: z.tuple([]),
    setEnabled: z.tuple([id, z.boolean()]),
    rename: z.tuple([id, z.string().trim().min(1).max(48)]),
    setLabelColor: z.tuple([id, z.string().regex(/^#[0-9a-f]{6}$/i).nullable()]),
    setDefault: z.tuple([id]),
    setToolPolicy: z.tuple([id, toolName, policy]),
    setAllTools: z.tuple([id, policy]),
    check: z.tuple([id]),
    reconnect: z.tuple([id]),
    connectDirectory: z.tuple([directoryId, z.object({ token: z.string().min(1).max(4096).optional(), fields: fields.optional() }).strict().optional()]),
    approveLocalStart: z.tuple([id]),
    parseConfig: z.tuple([z.string().min(1).max(200_000)]),
    search: z.tuple([z.string().max(500), z.array(id).max(50).optional()]),
    readRecord: z.tuple([id, z.string().min(1).max(4096)]),
    favicon: z.tuple([z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i)]),
    logs: z.tuple([id]),
  },
}

// Connectors.save takes the legacy remote input or ConnectorInputV2; config.ts checks meaning
const owner = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const envEntry = z.object({ name: z.string().min(1).max(128), value: z.string().max(8192).nullable().optional(), secret: z.boolean() }).strict()
const transport = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), url: z.string().min(1).max(2048), headerName: z.string().max(64).nullable().optional() }).strict(),
  z.object({ kind: z.literal('local'), command: z.string().min(1).max(1024), args: z.array(z.string().max(4096)).max(64), env: z.array(envEntry).max(64), cwd: z.string().max(1024).nullable().optional() }).strict(),
])
export const connectorInputV2Schema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(48),
    displayName: z.string().max(48).optional(),
    source: z.enum(['directory', 'custom']).optional(),
    directoryId: directoryId.nullable().optional(),
    transport,
    auth: z.enum(['none', 'bearer', 'api-key', 'oauth']),
    secret: z.string().max(4096).nullable().optional(),
    enabled: z.boolean(),
    owner: owner.optional(),
    labelColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
    // Base64 of a 256 KB image plus its data: prefix.
    logo: z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64).nullable().optional(),
    settings: fields.optional(),
  })
  .strict()
const legacyInput = z.object({ id: id.optional(), name: z.string().max(48), url: z.string().min(1).max(8192), token: z.string().max(4096).nullable().optional(), enabled: z.boolean(), owner: owner.optional() })
export const CONNECTORS_SAVE_SCHEMA = z.tuple([z.union([connectorInputV2Schema, legacyInput])])
