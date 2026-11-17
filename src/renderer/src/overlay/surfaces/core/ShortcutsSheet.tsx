/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { CoreSurfaceProps } from '@shared/overlay/core'
import { SHORTCUTS } from '@shared/shortcuts'
import { useT, type MessageKey } from '../../../i18n/useT'
import { KeyCaps } from '../../../ui/KeyCaps'
import type { SurfaceComponentProps } from '../../types'
import { sheetGroups } from './logic/sheet'

// The keyboard shortcuts sheet (SH-67): opened with ⌘/ and from Help. Every
// row of the shared table, grouped by surface, with platform key caps and a
// filter. Esc or the close button dismisses it.
export function ShortcutsSheet({ props, close }: SurfaceComponentProps<CoreSurfaceProps['shortcuts-sheet']>): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => sheetGroups(SHORTCUTS, props.runtime ?? [], props.platform, (key) => t(key as MessageKey), query), [props.runtime, props.platform, query, t])

  return (
    <div className="ov-sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="ov-sheet" role="dialog" aria-modal="true" aria-labelledby="ov-sheet-title">
        <header className="ov-sheet__head">
          <h2 id="ov-sheet-title">{t('core.shortcutsSheet.title')}</h2>
          <input
            className="ov-sheet__search"
            type="search"
            data-autofocus
            value={query}
            placeholder={t('core.shortcutsSheet.search')}
            aria-label={t('core.shortcutsSheet.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="ov-sheet__close" aria-label={t('core.shortcutsSheet.close')} onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="ov-sheet__body">
          {groups.length === 0 && <p className="ov-sheet__empty">{t('core.shortcutsSheet.empty', { query })}</p>}
          {groups.map((group) => (
            <section key={group.id} className="ov-sheet__group" aria-labelledby={`ov-sheet-${group.id}`}>
              <h3 id={`ov-sheet-${group.id}`}>{group.label}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div key={row.id} className="ov-sheet__row">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.keys.map((caps, i) => (
                        <KeyCaps key={i} keys={caps} />
                      ))}
                      <span className="ui-sr-only">{row.keys.map((caps) => caps.join(' ')).join(', ')}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  )
}
