/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { highlight, type CodeToken } from '@shared/codeHighlight'
import { codeLanguageOf } from '@shared/fileKinds'
import { t } from '@shared/i18n/core'
import { Button } from '../../ui'

// Code with highlighting and line numbers (OV-32). The tokens come from the
// shared highlighter and render as spans; nothing is ever built as HTML.

/** Lines drawn at first; long files draw more on request so the page stays quick. */
const LINES_STEP = 4000

function toLines(tokens: readonly CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) (lines[lines.length - 1] as CodeToken[]).push({ kind: token.kind, text: part })
    })
  }
  return lines
}

export function CodeView({ text, name, label }: { text: string; name: string; label: string }): ReactElement {
  const lines = useMemo(() => toLines(highlight(text, codeLanguageOf(name))), [text, name])
  const [shown, setShown] = useState(LINES_STEP)
  return (
    <>
      <pre className="fv-code" tabIndex={0} aria-label={label}>
        <code className="fv-code__lines">
          {lines.slice(0, shown).map((line, i) => (
            <span key={i} className="fv-code__line">
              <span className="fv-code__text">{line.length === 0 ? '​' : line.map((tok, j): ReactNode => (tok.kind === 'plain' ? tok.text : <span key={j} className={`fv-tok--${tok.kind}`}>{tok.text}</span>))}</span>
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
      {lines.length > shown && (
        <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + LINES_STEP)}>
          {t('files.viewer.code.more')}
        </Button>
      )}
    </>
  )
}
