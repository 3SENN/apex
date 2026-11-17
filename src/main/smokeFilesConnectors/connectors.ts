/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectRequestOf, connectorConnectUrl, executionOf } from '@shared/connectors'
import { parseMcpConfig } from '../connectors/config'
import { DIRECTORY, directoryProblems } from '../connectors/directory'
import { ConnectorStore } from '../connectors/store'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Connectors: routing between server-side and local, the directory and its
// deep link, and pasted configs that never start on their own. Offline
// only: temp folders, no favicon fetches, no MCP server reached. The stdio
// runtime and OAuth run against fixtures in tests/localMcp and tests/mcpOauth.

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

const temp = (): string => mkdtempSync(join(tmpdir(), 'apex-smoke-c5-'))

export const checks: SmokeCheck[] = [
  {
    name: 'connectors: public https runs server-side; private, custom-header and local ones run through Apex',
    async run() {
      assert(executionOf({ kind: 'remote', url: 'https://mcp.example.com/mcp', headerName: null }, 'bearer') === 'server', 'a public https server did not route server-side')
      assert(executionOf({ kind: 'remote', url: 'http://127.0.0.1:8123/mcp', headerName: null }, 'none') === 'local', 'a loopback server did not route locally')
      assert(executionOf({ kind: 'remote', url: 'https://mcp.example.com/mcp', headerName: 'X-Key' }, 'api-key') === 'local', 'a custom header did not route locally')
      assert(executionOf({ kind: 'local', command: 'node', args: [], env: [], cwd: null }, 'none') === 'local', 'a command did not route locally')
    },
  },
  {
    name: 'connectors: the directory is valid and its deep link round-trips',
    async run() {
      assert(directoryProblems(DIRECTORY).length === 0, `directory problems: ${JSON.stringify(directoryProblems(DIRECTORY))}`)
      const first = DIRECTORY[0]
      assert(first && connectRequestOf(connectorConnectUrl(first.id)) === first.id, 'the connect link did not round-trip')
      assert(connectRequestOf('apex://connectors?connect=..%2Fx') === null, 'a crafted connect id was accepted')
    },
  },
  {
    name: 'connectors: a pasted local server waits for approval, and any change asks again',
    async run() {
      const store = new ConnectorStore(temp())
      const parsed = parseMcpConfig(JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['server.mjs'] } } }))
      assert(parsed.errors.length === 0 && parsed.inputs.length === 1, 'the config did not parse')
      const saved = store.save(parsed.inputs[0] as (typeof parsed.inputs)[number])
      assert(!store.isApproved(saved.id), 'an imported local server was approved on its own')
      store.patch(saved.id, { approvedHash: store.currentApprovalHash(saved.id) })
      assert(store.isApproved(saved.id), 'approval did not stick')
      const view = store.views().find((c) => c.id === saved.id)
      assert(view && view.transport.kind === 'local', 'the saved server is not local')
      store.save({ id: saved.id, name: view.name, transport: { kind: 'local', command: 'node', args: ['server.mjs', '--other'], env: [], cwd: null }, auth: 'none', enabled: true })
      assert(!store.isApproved(saved.id), 'a changed command kept its approval')
    },
  },
]

export const shots: ShotSpec[] = []
