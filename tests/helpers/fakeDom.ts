/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TElement, TNode, TText } from '../../src/preload/page/translateDom'

// A tiny stand-in for the DOM, enough for the page translator's walker:
// elements with attributes and children, text nodes with data, and an
// HTML-ish serializer so tests can compare a whole page before and after.

export class FText implements TText {
  readonly nodeType = 3
  readonly nodeName = '#text'
  parentNode: TNode | null = null
  readonly childNodes: TNode[] = []
  constructor(public data: string) {}
}

export class FElement implements TElement {
  readonly nodeType = 1
  parentNode: TNode | null = null
  readonly childNodes: TNode[] = []
  readonly attrs = new Map<string, string>()
  shadowRoot: TNode | null = null
  constructor(readonly nodeName: string) {}
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  append(...children: (TNode | string)[]): this {
    for (const c of children) {
      const node = typeof c === 'string' ? new FText(c) : c
      node.parentNode = this
      this.childNodes.push(node)
    }
    return this
  }
}

/** h('p', { title: 'x' }, 'text', h('b', {}, 'bold')) */
export function h(tag: string, attrs: Record<string, string> = {}, ...children: (TNode | string)[]): FElement {
  const el = new FElement(tag.toUpperCase())
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el.append(...children)
}

export function serialize(node: TNode): string {
  if (node.nodeType === 3) return (node as FText).data
  const el = node as FElement
  const attrs = [...el.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')
  return `<${el.nodeName.toLowerCase()}${attrs}>${Array.from(el.childNodes).map(serialize).join('')}</${el.nodeName.toLowerCase()}>`
}

/** Every text node under `node`, in order. */
export function texts(node: TNode): FText[] {
  if (node.nodeType === 3) return [node as FText]
  return Array.from(node.childNodes).flatMap(texts)
}
