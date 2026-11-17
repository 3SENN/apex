/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

/**
 * Wraps a dialog opened from inside the card. The dialog portals to <body>,
 * but React still bubbles its key events up to the card's modal, whose Tab
 * trap would pull focus back into the card. Only Tab stops here: Esc must
 * still reach the document, where the top layer handles it.
 */
export function Nested({ children }: { children: ReactNode }) {
  return (
    <div
      className="co-nested"
      onKeyDown={(e) => {
        if (e.key === 'Tab') e.stopPropagation()
      }}
    >
      {children}
    </div>
  )
}
