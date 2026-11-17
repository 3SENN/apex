/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The open-at-login approval dialog (OV-09): explains the step, opens System
// Settings › Login Items (Windows: Startup apps) and waits there. Main
// rechecks when Apex regains focus; once approved it says so and closes.
// The same content renders as the overlay surface and, while the overlay
// host isn't available, as an in-chrome modal.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { CircleCheck } from 'lucide-react'
import type { Rect } from '@shared/overlay'
import type { LoginItemState } from '@shared/system'
import { apex, call, errorText } from '../api'
import { useEvent } from '../settings/data'
import { Button, Modal, Spinner } from '../ui'
import { useT, type MessageKey } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { platformKind } from './platform'
import './system.css'

/** How long the "all set" line shows before the dialog closes itself. */
const DONE_MS = 1400

interface Approval {
  approved: boolean
  waiting: boolean
  opening: boolean
  error: string | null
  open(): Promise<void>
}

function useApproval(onDone: () => void): Approval {
  const t = useT()
  const [state, setState] = useState<LoginItemState | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const read = (): void => void call('system', 'loginItem').then(setState, () => undefined)
    read()
    // Back from System Settings: ask again (main also rechecks on focus and sends login-item).
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])
  useEvent('login-item', (e) => setState(e.state))

  const approved = state?.status === 'enabled'
  useEffect(() => {
    if (!approved) return
    const timer = setTimeout(onDone, DONE_MS)
    return () => clearTimeout(timer)
  }, [approved])

  const open = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      await call('system', 'openLoginItemsSettings')
      setWaiting(true)
    } catch (err) {
      setError(t('system.loginItem.openFailed', { message: errorText(err) }))
    } finally {
      setOpening(false)
    }
  }
  return { approved, waiting, opening, error, open }
}

function Status({ approval }: { approval: Approval }): ReactElement | null {
  const t = useT()
  if (approval.approved) {
    return (
      <p className="sys-approval__status sys-approval__status--done" role="status">
        <CircleCheck aria-hidden size={16} />
        {t('system.loginItem.done')}
      </p>
    )
  }
  if (approval.error) {
    return (
      <p className="sys-approval__status sys-approval__status--error" role="alert">
        {approval.error}
      </p>
    )
  }
  if (!approval.waiting) return null
  return (
    <p className="sys-approval__status" role="status">
      <Spinner size={14} />
      {t('system.loginItem.waiting')}
    </p>
  )
}

/** Title, explanation, the live status and the two buttons. */
function ApprovalContent({ onClose, titleId, descId, onLayout }: { onClose(): void; titleId: string; descId: string; onLayout?(): void }): ReactElement {
  const t = useT()
  const win = platformKind(apex.platform) === 'win'
  const approval = useApproval(onClose)
  useLayoutEffect(() => onLayout?.(), [approval.waiting, approval.approved, approval.error])
  const body: MessageKey = win ? 'system.loginItem.body.win' : 'system.loginItem.body.mac'
  return (
    <>
      <header className="ui-dialog__header">
        <h2 id={titleId} className="ui-dialog__title">
          {t('system.loginItem.title')}
        </h2>
      </header>
      <p id={descId} className="ui-dialog__description">
        {t(body)}
      </p>
      <div className="sys-approval__live" aria-live="polite">
        <Status approval={approval} />
      </div>
      <footer className="ui-dialog__footer">
        <Button onClick={onClose}>{t('system.loginItem.notNow')}</Button>
        <Button variant="primary" loading={approval.opening} disabled={approval.approved} onClick={() => void approval.open()} data-autofocus>
          {t(win ? 'system.loginItem.openSettings.win' : 'system.loginItem.openSettings')}
        </Button>
      </footer>
    </>
  )
}

/** The overlay surface: a fixed modal card the host centres and dims behind. */
export function LoginItemApproval({ close, reportBounds }: SurfaceComponentProps<Record<string, never>>): ReactElement {
  const titleId = useId()
  const descId = useId()
  const card = useRef<HTMLDivElement>(null)
  const report = (): void => {
    const r = card.current?.getBoundingClientRect()
    if (r) reportBounds({ x: r.left, y: r.top, width: r.width, height: r.height } satisfies Rect)
  }
  return (
    <div ref={card} className="ui-dialog ui-dialog--sm sys-approval" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
      <ApprovalContent onClose={close} titleId={titleId} descId={descId} onLayout={report} />
    </div>
  )
}

/** The in-chrome stand-in while the overlay host isn't available: Esc, the scrim and Not now close it. */
export function LoginItemApprovalDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement | null {
  const titleId = useId()
  const descId = useId()
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} describedBy={descId} className="ui-dialog ui-dialog--sm sys-approval">
      <ApprovalContent onClose={onClose} titleId={titleId} descId={descId} />
    </Modal>
  )
}
