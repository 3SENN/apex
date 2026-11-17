/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { GroupHoverCardProps } from '@shared/overlay/tabs'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'
import { PageFavicon, useCardLifetime, useGlide } from './cardParts'

// A collapsed group's hover card (SH-23): its name and colour, and each tab
// with its favicon and host. Choosing one opens the group on it.

export function GroupHoverCard({ props, close, resolve }: SurfaceComponentProps<GroupHoverCardProps>): ReactElement {
  const t = useT()
  const glide = useGlide(props.glideFrom)
  const life = useCardLifetime(props.leaving, close)
  return (
    <div className="tab-card tab-card--group" style={glide} {...life} data-group-color={props.color} role="dialog" aria-label={t('tabs.group.cardLabel', { name: props.name || t('tabs.group.unnamed') })}>
      <div className="tab-card__group-head">
        <span className="group-swatch" data-group-color={props.color} aria-hidden />
        <span className="tab-card__title tab-card__title--small">{props.name || t('tabs.group.unnamed')}</span>
        <span className="tab-card__count">{t('tabs.group.count', { count: props.tabs.length })}</span>
      </div>
      <ul className="tab-card__list">
        {props.tabs.map((tab) => (
          <li key={tab.tabId}>
            <button type="button" className="tab-card__list-row" onClick={() => resolve(tab.tabId)}>
              <PageFavicon src={tab.favicon} />
              <span className="tab-card__list-title">{tab.title}</span>
              <span className="tab-card__list-host">{tab.host}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
