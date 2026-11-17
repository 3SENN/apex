/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { CircleHelp, Plug, Repeat, WandSparkles } from 'lucide-react'
import type { Connector } from '@shared/services'
import { call, useLiveList } from '../../api'
import { useT } from '../../i18n/useT'

// The start tray (DS-108): a light grey band tucked under the start composer,
// with 32 px chips for skills, routines and connectors (with the overlapping
// logos of the connected ones) and a help chip at the right. In dark mode it
// sits below the page level, darker than the composer.

const LOGOS_SHOWN = 3

function open(url: string): void {
  void call('pages', 'open', url)
}

export function ChipTray({ compact = false }: { compact?: boolean }): ReactElement {
  const t = useT()
  const [connectors] = useLiveList<Connector, 'connectors'>(() => call('connectors', 'list').catch(() => []), 'connectors', (e) => e.items)
  const connected = connectors.filter((c) => c.enabled)
  const logos = connected.filter((c) => c.logo).slice(0, LOGOS_SHOWN)
  return (
    <div className={['nt-tray', compact && 'nt-tray--compact'].filter(Boolean).join(' ')} role="toolbar" aria-label={t('tabs.newTabChipTray.startWith')}>
      <button type="button" className="nt-chip" onClick={() => open('apex://skills')}>
        <WandSparkles aria-hidden />
        <span className="nt-chip__label">{t('tabs.newTabChipTray.skills')}</span>
      </button>
      <button type="button" className="nt-chip" onClick={() => open('apex://routines')}>
        <Repeat aria-hidden />
        <span className="nt-chip__label">{t('tabs.newTabChipTray.routines')}</span>
      </button>
      <button type="button" className="nt-chip" onClick={() => open('apex://connectors')} aria-label={connected.length > 0 ? `Connectors, ${connected.length} connected` : t('tabs.newTabChipTray.connectors')}>
        {logos.length > 0 ? (
          <span className="nt-chip__logos" aria-hidden="true">
            {logos.map((c) => (
              <img key={c.id} src={c.logo as string} alt="" draggable={false} />
            ))}
          </span>
        ) : (
          <Plug aria-hidden />
        )}
        <span className="nt-chip__label">{t('tabs.newTabChipTray.connectors')}</span>
      </button>
      {/* DS-108: in the side panel's compact tray the help chip keeps to its glyph (its label stays for screen readers), so it never runs past the tray's edge. */}
      <button type="button" className="nt-chip nt-chip--help" onClick={() => open('apex://guides')}>
        <CircleHelp aria-hidden />
        <span className="nt-chip__label">{t('tabs.newTabChipTray.help')}</span>
      </button>
    </div>
  )
}
