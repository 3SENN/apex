/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ReactElement } from 'react'
import { ShieldCheck } from 'lucide-react'
import { t } from '@shared/i18n/core'
import { sandboxedDocument } from '@shared/filesLogic'
import { Button } from '../../ui'

// Sandboxed HTML (OV-32, CH-28): the file draws in an opaque-origin frame
// with no scripts, forms, popups or plugins, and its own policy blocks every
// fetch (images only from data: URLs), so a preview never reaches the
// network. Running it for real is the artifact tab's job.

export function HtmlView({ text, name, onOpenArtifact }: { text: string; name: string; onOpenArtifact?: () => void }): ReactElement {
  const doc = useMemo(() => sandboxedDocument(text), [text])
  return (
    <>
      <div className="fv-notice" role="note">
        <ShieldCheck aria-hidden />
        <span>{t('files.viewer.htmlNote')}</span>
        {onOpenArtifact && (
          <Button className="fv-notice__action" size="sm" variant="secondary" onClick={onOpenArtifact}>
            {t('files.action.openArtifact')}
          </Button>
        )}
      </div>
      {/* sandbox="" : no scripts, no same-origin, no forms, no popups, no top navigation. */}
      <iframe className="fv-frame" title={name} sandbox="" srcDoc={doc} referrerPolicy="no-referrer" loading="lazy" />
    </>
  )
}
