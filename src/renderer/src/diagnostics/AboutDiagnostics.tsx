/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { LifeBuoy, ScrollText } from 'lucide-react'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { Row } from '../settings/kit'
import { Button, Kbd } from '../ui'
import { LOGS_URL, openProblemReport } from './menuItems'

// The diagnostics About rows (ST-56): Report a problem (⇧⌘H) and View logs.

export function AboutDiagnostics(): ReactElement {
  const t = useT()
  // Rows only: About Atelier places them inside its own card.
  return (
    <>
      <Row
        anchor="report-problem"
        icon={<LifeBuoy />}
        title={t('diagnostics.about.reportProblem')}
        description={
          <>
            {t('diagnostics.about.reportProblemDetail')} <Kbd shortcut="CmdOrCtrl+Shift+H" />
          </>
        }
      >
        <Button size="sm" onClick={() => void openProblemReport()}>
          {t('diagnostics.about.report')}
        </Button>
      </Row>
      <Row anchor="view-logs" icon={<ScrollText />} title={t('diagnostics.about.viewLogs')} description={t('diagnostics.about.viewLogsDetail')}>
        <Button size="sm" onClick={() => void call('pages', 'open', LOGS_URL)}>
          {t('diagnostics.about.open')}
        </Button>
      </Row>
    </>
  )
}
