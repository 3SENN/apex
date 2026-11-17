/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Instructions the assistant follows, each collapsed under its name so a
// review can be read like code: the pack install review's "What it tells
// the assistant" and the companion import review show them this way.
import type { ReactElement, ReactNode } from 'react'
import './packs.css'

export interface PromptItem {
  key: string
  summary: ReactNode
  text: string
}

export function PromptDetails({ items }: { items: readonly PromptItem[] }): ReactElement {
  return (
    <div className="pk-code">
      {items.map((item) => (
        <details key={item.key}>
          <summary>{item.summary}</summary>
          <pre tabIndex={0} style={{ whiteSpace: 'pre-wrap' }}>
            {item.text}
          </pre>
        </details>
      ))}
    </div>
  )
}
