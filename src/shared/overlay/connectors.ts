/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `connectors`: the custom server dialog and
// the confirmation before a local MCP server starts, showing the exact
// command (OV-09). Components and policies live in
// src/renderer/src/overlay/surfaces/connectors/index.ts.
export const CONNECTORS_SURFACES = ['connector-add-dialog', 'connector-local-approval'] as const

export type ConnectorsSurfaceId = (typeof CONNECTORS_SURFACES)[number]

export interface ConnectorsSurfaceProps {
  /** `connectorId` edits a custom server; absent adds one. */
  'connector-add-dialog': { connectorId?: string; mode?: 'remote' | 'local' | 'json' }
  /** Environment values never travel: only names, with secrets marked. */
  'connector-local-approval': {
    connectorId: string
    name: string
    command: string
    args: string[]
    cwd: string | null
    env: { name: string; secret: boolean }[]
  }
}
