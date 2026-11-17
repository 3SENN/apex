/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, type ReactElement } from 'react'
import { FileInput, X } from 'lucide-react'
import type { ImportHintProps } from '@shared/autofill'
import { useT } from '../../../i18n/useT'
import { Button, IconButton } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The one-time password import hint (OV-31): on a sign-in page with nothing
// saved, before you've ever imported, a card points to the CSV import in
// Settings. Main opens Settings on 'import' and remembers any answer, so the
// hint never comes back.

export function ImportHint({ props, resolve, anchorRect }: SurfaceComponentProps<ImportHintProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const bodyId = useId()
  const importRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    importRef.current?.focus()
  }, [])
  const rect = anchorRect ?? props.anchorRect
  return (
    <div className="afs afs--hint" style={{ width: rect.width, minHeight: rect.height }} role="dialog" aria-labelledby={titleId} aria-describedby={bodyId}>
      <header className="afs__head">
        <span className="afs__icon" aria-hidden="true">
          <FileInput size={16} />
        </span>
        <div className="afs__heading">
          <h2 id={titleId} className="afs__title">
            {t('autofill.hint.title')}
          </h2>
        </div>
        <IconButton size="sm" variant="ghost" icon={<X size={14} />} label={t('autofill.save.close')} onClick={() => resolve('dismiss')} />
      </header>
      <p id={bodyId} className="afs__body">
        {t('autofill.hint.body')}
      </p>
      <footer className="afs__actions">
        <Button size="sm" variant="ghost" onClick={() => resolve('dismiss')}>
          {t('autofill.hint.dismiss')}
        </Button>
        <Button ref={importRef} size="sm" variant="primary" onClick={() => resolve('import')}>
          {t('autofill.hint.import')}
        </Button>
      </footer>
    </div>
  )
}
