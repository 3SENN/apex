/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConnectorsServices } from '@shared/connectors'
import { mainT } from '../i18n/mainT'
import { ConnectorsCore } from './core'
import { parseMcpConfig } from './config'
import { FaviconCache, type IconFetch } from './favicons'
import type { FetchFn } from './oauth'
import type { ConnectorRuntime } from './runtime'
import { connectorStoreFor, type ConnectorStore } from './store'
import { registerPermissionSources } from '../agent/feature'

// Connectors: directory, custom and local servers, OAuth and record search,
// as the extended methods of the `connectors` namespace. The original list,
// save and remove (index.ts) run on the same ConnectorStore, which now holds v2
// records, so both halves agree.

export interface ConnectorsDeps {
  dataDir: string
  /** index.ts's store; found by data folder when omitted. */
  store?: ConnectorStore
  /** Favicons through the default profile's session; null turns them off (smoke). */
  iconFetch?: IconFetch | null
  fetchFn?: FetchFn
  openSignIn?(url: string): () => void
  loginPath?(): Promise<string | null>
  notify?(title: string, body: string, url: string): void
  home?: string
}

export interface ConnectorsSetup {
  services: ConnectorsServices
  runtime: ConnectorRuntime
  core: ConnectorsCore
  dispose(): void | Promise<void>
}

export function setupConnectors(deps: ConnectorsDeps): ConnectorsSetup {
  const store = deps.store ?? connectorStoreFor(deps.dataDir)
  const icons = new FaviconCache(deps.dataDir, deps.iconFetch ?? null)
  const core = new ConnectorsCore({
    store,
    dataDir: deps.dataDir,
    icons,
    fetchFn: deps.fetchFn ?? ((url, init) => fetch(url, init)),
    openSignIn:
      deps.openSignIn ??
      (() => {
        throw new Error(mainT('connectors.error.noWindow'))
      }),
    loginPath: deps.loginPath ?? (async () => null),
    notify: deps.notify ?? (() => undefined),
    home: deps.home,
  })
  const gone = (id: string): never => {
    void id
    throw new Error(mainT('connectors.error.gone'))
  }
  // Favicons only for sites Apex already knows: the directory's and your servers' hosts.
  const knownSite = (site: string): boolean =>
    core.directory().some((e) => e.site === site) ||
    store.list().some((c) => {
      if (c.transport.kind !== 'remote') return false
      try {
        return new URL(c.transport.url).hostname === site
      } catch {
        return false
      }
    })

  const services: ConnectorsServices = {
    connectors: {
      directory: () => core.directory(),
      setEnabled: (id, on) => (store.get(id) ? store.patch(id, { enabled: on }) : gone(id)),
      rename: (id, name) => (store.get(id) ? store.patch(id, { displayName: name.trim().slice(0, 48) }) : gone(id)),
      setLabelColor: (id, color) => (store.get(id) ? store.patch(id, { labelColor: color ? color.toLowerCase() : null }) : gone(id)),
      setDefault: (id) => store.setDefault(id),
      setToolPolicy: (id, tool, policy) => core.setToolPolicy(id, tool, policy),
      setAllTools: (id, policy) => core.setAllTools(id, policy),
      check: (id) => core.check(id),
      reconnect: (id) => core.reconnect(id),
      connectDirectory: (entryId, opts) => core.connectDirectory(entryId, opts),
      approveLocalStart: (id) => core.approveLocalStart(id),
      parseConfig: (json) => parseMcpConfig(json),
      search: (query, ids) => core.search(query, ids),
      readRecord: (id, uri) => core.readRecord(id, uri),
      favicon: async (site) => (knownSite(site.toLowerCase()) ? icons.get(site.toLowerCase()) : null),
      logs: (id) => (store.get(id) ? core.logs(id) : gone(id)),
    },
  }
  // Saved permissions lists the connectors from main; tool policies keep the renderer's default-aware view.
  registerPermissionSources({ connectors: () => store.list().map((c) => ({ id: c.id, name: c.displayName || c.name, enabled: c.enabled })) })
  return { services, runtime: core.runtime(), core, dispose: () => core.dispose() }
}
