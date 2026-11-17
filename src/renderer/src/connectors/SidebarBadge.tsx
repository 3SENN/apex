/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { useT } from '../i18n/useT'
import { StatusDot } from '../ui'
import { useNeedsReconnect } from './status'

/** A dot on the sidebar's Connectors row while a connector needs reconnecting (never a count). */
export function ConnectorsBadge(): ReactElement | null {
  const t = useT()
  const needs = useNeedsReconnect()
  return needs ? <StatusDot status="needs-input" size={6} label={t('connectors.sidebar.attention')} pulse={false} /> : null
}
