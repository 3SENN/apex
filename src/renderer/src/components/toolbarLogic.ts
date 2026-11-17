/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TabInfo } from '@shared/ipc'

/**
 * Whether back or forward can act. On chat pages back, forward and reload
 * are inert, whatever history the tab has (DS-20): no hover fill, no click,
 * no history list.
 */
export function navEnabled(tab: Pick<TabInfo, 'canGoBack' | 'canGoForward'> | null, direction: 'back' | 'forward', quiet: boolean): boolean {
  if (tab === null || quiet) return false
  return direction === 'back' ? tab.canGoBack : tab.canGoForward
}
