/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { ArrowRight, Plug, Plus } from 'lucide-react'
import type { ConnectorV2, DirectoryEntry } from '@shared/connectors'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import type { LogCardProps } from '../chat/cards/registry'
import { useT } from '../i18n/useT'
import { useConnectorDialogs } from '../settings/destinations/ConnectorEditor'
import { Button, useToast } from '../ui'
import { ConnectForm, useConnectFlow } from './ConnectFlow'
import { ConnectorLogo } from './ConnectorLogo'
import { useConnectorList } from './status'
import './connectors.css'

// CH-41: the chat asked for a service that isn't connected. The card offers
// sign-in where the directory has an official server (a token otherwise),
// shows connecting and failed states, and then continues the request in a
// new chat, since a chat's tools are fixed when it starts.

let directoryOnce: Promise<DirectoryEntry[]> | null = null
function loadDirectory(): Promise<DirectoryEntry[]> {
  directoryOnce ??= call('connectors', 'directory').catch((err: unknown) => {
    directoryOnce = null
    throw err
  })
  return directoryOnce
}

export function ConnectConnectorCard({ item, chatId }: LogCardProps<'connector-needed'>): ReactElement {
  const t = useT()
  const toast = useToast()
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null)
  const list = useConnectorList()
  const dialogs = useConnectorDialogs()
  const [made, setMade] = useState<{ id: string; name: string } | null>(null)
  const [continuing, setContinuing] = useState(false)
  useEffect(() => {
    let live = true
    loadDirectory().then(
      (d) => live && setEntries(d),
      () => live && setEntries([]),
    )
    return () => {
      live = false
    }
  }, [])
  const entry = item.directoryId ? (entries?.find((e) => e.id === item.directoryId) ?? null) : null
  const flow = useConnectFlow(entry)
  // Already connected (here or from the page): straight to Continue.
  const existing = entry ? list?.find((c) => c.directoryId === entry.id && c.enabled && c.health !== 'needs-reconnect') : undefined
  const ready = made ?? (existing ? { id: existing.id, name: existing.displayName } : null)

  const continueChat = async (): Promise<void> => {
    if (!ready) return
    setContinuing(true)
    try {
      const next = await call('chats', 'continueInNewChat', chatId, { connectorIds: [ready.id] })
      await call('pages', 'open', chatUrl(next.id))
      toast.show({ message: t('connectors.needed.continued', { name: ready.name }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setContinuing(false)
    }
  }

  const addCustom = async (el: HTMLElement): Promise<void> => {
    const result = await dialogs.openAdd(el, { mode: 'remote' })
    const first = result?.saved[0]
    if (!first) return
    if (!first.local) void call('connectors', 'check', first.id).catch(() => undefined)
    setMade({ id: first.id, name: first.name })
  }

  return (
    <section className="cx-needed" aria-label={t('connectors.needed.title', { service: item.service })}>
      <div className="cx-needed__head">
        <ConnectorLogo name={item.service} site={entry?.site ?? null} category={entry?.category ?? null} size="md" />
        <div>
          <p className="cx-needed__title">{t('connectors.needed.title', { service: entry?.name ?? item.service })}</p>
          <p className="cx-muted">{item.reason}</p>
        </div>
      </div>
      {ready ? (
        <div className="cx-needed__done" role="status">
          <p className="cx-muted">{t('connectors.needed.continueNote')}</p>
          <Button variant="primary" size="sm" iconEnd={<ArrowRight />} loading={continuing} onClick={() => void continueChat()}>
            {t('connectors.needed.continue')}
          </Button>
        </div>
      ) : entry ? (
        <ConnectForm entry={entry} flow={flow} compact onConnected={(c: ConnectorV2) => setMade({ id: c.id, name: c.displayName })} />
      ) : entries === null ? null : (
        <div className="cx-needed__done">
          <p className="cx-muted">{t('connectors.needed.noEntry', { service: item.service })}</p>
          <span className="cx-row">
            <Button variant="secondary" size="sm" icon={<Plug />} onClick={() => void call('pages', 'open', 'apex://connectors')}>
              {t('connectors.needed.openPage')}
            </Button>
            <Button variant="primary" size="sm" icon={<Plus />} onClick={(e) => void addCustom(e.currentTarget)}>
              {t('connectors.needed.custom')}
            </Button>
          </span>
        </div>
      )}
      {dialogs.element}
    </section>
  )
}
