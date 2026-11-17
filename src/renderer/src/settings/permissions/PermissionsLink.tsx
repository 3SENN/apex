/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// "All permissions": the way to Settings › Privacy › Permissions from the
// pages that show one permission of their own (Transcription, Voice,
// Notifications, Agent permissions). `highlight` names a row to land on: a
// website row only, since landing focuses the row's first button and on a
// Mac row that can be Allow. Without it the page opens at This Mac.
import type { ReactElement } from 'react'
import { ShieldCheck } from 'lucide-react'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button } from '../../ui'
import { permissionsUrl } from '../logic/permissions'

export function PermissionsLink({ highlight }: { highlight?: string }): ReactElement {
  const t = useT()
  return (
    <Button size="sm" variant="ghost" icon={<ShieldCheck aria-hidden />} onClick={() => void Promise.resolve(call('pages', 'open', permissionsUrl(highlight))).catch(() => undefined)}>
      {t('permissionsHub.link')}
    </Button>
  )
}
