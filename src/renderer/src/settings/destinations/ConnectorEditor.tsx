/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import type { SurfaceAnchor } from '@shared/overlay'
import { AddServerDialog, type AddServerResult } from '../../connectors/AddServerDialog'
import { LocalApprovalDialog, type LocalApprovalProps } from '../../connectors/LocalApprovalDialog'
import type { ServerMode } from '../../connectors/logic/addForm'
import { anchorFromElement, openSurface } from '../../overlay/useSurface'

// Opens the custom server dialog (SK-15) and the local server approval
// (OV-09) as overlay surfaces over the window, and draws them inline here
// when the overlay can't open them.

type Inline =
  | { kind: 'add'; connectorId?: string; mode?: ServerMode; done(result: AddServerResult | null): void }
  | { kind: 'approve'; data: LocalApprovalProps; done(approved: boolean): void }

const WINDOW_ANCHOR: SurfaceAnchor = { kind: 'window', rect: { x: 0, y: 0, width: 0, height: 0 } }

export interface ConnectorDialogs {
  /** Resolves with what was saved, or null when cancelled. */
  openAdd(from: HTMLElement | null, options?: { connectorId?: string; mode?: ServerMode }): Promise<AddServerResult | null>
  /** Resolves true once the exact command is approved. */
  openApproval(from: HTMLElement | null, data: LocalApprovalProps): Promise<boolean>
  /** Render once: the inline fallbacks. */
  element: ReactElement
}

function isAddResult(value: unknown): value is AddServerResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as AddServerResult).saved)
}

export function useConnectorDialogs(): ConnectorDialogs {
  const [inline, setInline] = useState<Inline | null>(null)
  const anchor = (el: HTMLElement | null): SurfaceAnchor => (el ? anchorFromElement(el) : WINDOW_ANCHOR)

  const openAdd: ConnectorDialogs['openAdd'] = (from, options = {}) =>
    new Promise((resolve) => {
      const props = { ...(options.connectorId ? { connectorId: options.connectorId } : {}), ...(options.mode ? { mode: options.mode } : {}) }
      openSurface('connector-add-dialog', anchor(from), props).then(
        (result) => resolve('value' in result && isAddResult(result.value) ? result.value : null),
        () => setInline({ kind: 'add', ...options, done: resolve }),
      )
    })

  const openApproval: ConnectorDialogs['openApproval'] = (from, data) =>
    new Promise((resolve) => {
      openSurface('connector-local-approval', anchor(from), data).then(
        (result) => resolve('value' in result && Boolean(result.value)),
        () => setInline({ kind: 'approve', data, done: resolve }),
      )
    })

  const finish = (fn: () => void): void => {
    setInline(null)
    fn()
  }

  const element =
    inline?.kind === 'add' ? (
      <AddServerDialog
        open
        connectorId={inline.connectorId}
        mode={inline.mode}
        onClose={() => finish(() => inline.done(null))}
        onSaved={(result) => finish(() => inline.done(result))}
      />
    ) : inline?.kind === 'approve' ? (
      <LocalApprovalDialog open data={inline.data} onClose={() => finish(() => inline.done(false))} onApproved={() => finish(() => inline.done(true))} />
    ) : (
      <></>
    )

  return { openAdd, openApproval, element }
}

/** The inline host as a component, for pages that keep it in their tree. */
export function ConnectorEditor({ dialogs }: { dialogs: ConnectorDialogs }): ReactElement {
  return dialogs.element
}
