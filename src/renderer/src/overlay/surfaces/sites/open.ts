/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { anchorFromElement, openSurface } from '../../useSurface'

// The address pill's entry point into site info: opens it under the
// pill's site button. A failed open (the window closing) is ignored.
export function openSiteInfo(anchorEl: HTMLElement, tabId: string): void {
  void openSurface('site-info', anchorFromElement(anchorEl), { tabId }).catch(() => undefined)
}
