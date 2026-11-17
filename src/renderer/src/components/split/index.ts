/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Split view (SH-39 to SH-42): the seam, the empty pane's chooser and the
// toolbar's split menu. App places them; main holds the split and its ratio.
export { SplitSeam } from './SplitSeam'
export { SplitChooser } from './SplitChooser'
export { useSplitMenu, splitMenuProps, runSplitChoice } from './splitMenu'
export { splitVars, sideOf, chooserTabs, isEven } from './logic'

import type { CSSProperties } from 'react'
import { splitVars as vars } from './logic'

/** The content element's style while split: the panes' shares of the width. */
export function splitStyle(ratio: number | undefined): CSSProperties {
  return vars(ratio) as CSSProperties
}
