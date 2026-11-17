/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { KeyRound, TriangleAlert } from 'lucide-react'
import type { ConnectorsSurfaceProps } from '@shared/overlay/connectors'
import type { Connector } from '@shared/services'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Notice } from '../settings/kit'
import { Button, Dialog } from '../ui'
import { commandLine } from './logic/addForm'

// OV-09: before a local MCP server's first start, you see its exact
// command: the program, every argument, the working folder and the names of
// its environment variables (values never leave main; secret ones are marked).
// Starting approves that exact command; any change asks again.

export type LocalApprovalProps = ConnectorsSurfaceProps['connector-local-approval']

/** The approval's props for a local connector, or null for a remote one. */
export function localApprovalProps(c: Connector): LocalApprovalProps | null {
  if (c.transport.kind !== 'local') return null
  return { connectorId: c.id, name: c.displayName, command: c.transport.command, args: c.transport.args, cwd: c.transport.cwd, env: c.transport.env.map((e) => ({ name: e.name, secret: e.secret })) }
}

export interface LocalApprovalDialogProps {
  open: boolean
  data: LocalApprovalProps
  onClose(): void
  onApproved(): void
}

export function LocalApprovalDialog({ open, data, onClose, onApproved }: LocalApprovalDialogProps): ReactElement | null {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await call('connectors', 'approveLocalStart', data.connectorId)
      onApproved()
      // Starting and listing its tools runs on; the detail page shows how it goes.
      void call('connectors', 'check', data.connectorId).catch(() => undefined)
    } catch (err) {
      setFailure(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      size="md"
      title={t('connectors.local.approveTitle')}
      description={t('connectors.local.lede', { name: data.name })}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            {t('connectors.local.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy}>
            {t('connectors.local.start')}
          </Button>
        </>
      }
    >
      <div className="cx-approve-cmd">
        <p className="cx-label" id="cx-local-cmd">
          {t('connectors.local.command')}
        </p>
        <pre className="cx-code" aria-labelledby="cx-local-cmd" tabIndex={0}>
          {commandLine(data.command, data.args)}
        </pre>
        <p className="cx-label">{t('connectors.local.cwd')}</p>
        <p className="cx-mono-line">{data.cwd ?? t('connectors.detail.cwdDefault')}</p>
        <p className="cx-label">{t('connectors.local.env')}</p>
        {data.env.length === 0 ? (
          <p className="cx-muted">{t('connectors.local.envNone')}</p>
        ) : (
          <ul className="cx-env-list">
            {data.env.map((e) => (
              <li key={e.name}>
                <code>{e.name}</code>
                <span className="cx-muted">
                  {e.secret ? (
                    <>
                      <KeyRound size={12} aria-hidden /> {t('connectors.detail.envSecret')}
                    </>
                  ) : (
                    t('connectors.detail.envSet')
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="cx-note">
          <TriangleAlert size={14} aria-hidden /> {t('connectors.local.again')}
        </p>
      </div>
      {failure && <Notice tone="error">{failure}</Notice>}
    </Dialog>
  )
}
