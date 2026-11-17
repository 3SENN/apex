/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createElement, memo, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ReaderElement, ReaderNode } from '@shared/reader'

// The article itself (RD-02): the page's allowed elements as React elements,
// never as HTML. Ids get a prefix so they can't clash with the chrome's own;
// links open through the browser, and jumps stay inside the reader.

export const READER_ID_PREFIX = 'reader-'

interface BodyProps {
  nodes: readonly ReaderNode[]
  onLink(href: string, event: MouseEvent<HTMLAnchorElement>): void
  onAnchor(id: string): void
}

function render(nodes: readonly ReaderNode[] | undefined, props: BodyProps, key: string): ReactNode[] | undefined {
  if (!nodes || nodes.length === 0) return undefined
  return nodes.map((node, i) => (typeof node === 'string' ? node : element(node, props, `${key}.${i}`)))
}

function element(el: ReaderElement, props: BodyProps, key: string): ReactElement {
  const id = el.id ? READER_ID_PREFIX + el.id : undefined
  const children = render(el.children, props, key)
  switch (el.tag) {
    case 'img':
      return <img key={key} id={id} src={el.src} alt={el.alt ?? ''} width={el.width} height={el.height} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} />
    case 'br':
      return <br key={key} />
    case 'hr':
      return <hr key={key} />
    case 'a': {
      const href = el.href
      if (href) {
        return (
          <a
            key={key}
            id={id}
            href={href}
            rel="noreferrer"
            onClick={(e) => props.onLink(href, e)}
            onAuxClick={(e) => {
              if (e.button === 1) props.onLink(href, e)
            }}
          >
            {children}
          </a>
        )
      }
      const anchor = el.anchor
      if (anchor) {
        return (
          <a
            key={key}
            id={id}
            href={`#${READER_ID_PREFIX}${anchor}`}
            onClick={(e) => {
              e.preventDefault()
              props.onAnchor(anchor)
            }}
          >
            {children}
          </a>
        )
      }
      return (
        <a key={key} id={id}>
          {children}
        </a>
      )
    }
    case 'ol':
      return (
        <ol key={key} id={id} start={el.start}>
          {children}
        </ol>
      )
    case 'td':
    case 'th':
      return createElement(el.tag, { key, id, colSpan: el.colSpan, rowSpan: el.rowSpan }, children)
    case 'abbr':
      return (
        <abbr key={key} id={id} title={el.title}>
          {children}
        </abbr>
      )
    case 'table':
      // Wide tables scroll on their own instead of widening the column.
      return (
        <div key={key} className="reader__table">
          <table id={id}>{children}</table>
        </div>
      )
    default:
      return createElement(el.tag, { key, id }, children)
  }
}

export const ReaderBody = memo(function ReaderBody(props: BodyProps): ReactElement {
  return <>{render(props.nodes, props, 'n')}</>
})
