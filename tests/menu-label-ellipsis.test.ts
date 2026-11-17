/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// A long menu label ends in an ellipsis instead of being cut mid-word (the
// main menu's "Make Atelier your default browser" row). The label text sits in
// its own box: a bare text node inside the flex column of .kit-label can't
// show text-overflow.

const noop = (): void => {}

// MenuList is JSX, which the node test project does not compile, so it is loaded by path.
const menuListModule = '../src/renderer/src/overlay/kit/MenuList'
const { MenuList } = (await import(/* @vite-ignore */ menuListModule)) as { MenuList: FunctionComponent<Record<string, unknown>> }

describe('menu labels', () => {
  it('wraps each row label in its own truncating box', () => {
    const html = renderToStaticMarkup(
      createElement(MenuList, {
        items: [{ id: 'default', label: 'Make Atelier your default browser', description: 'Links from other apps open here' }],
        label: 'Menu',
        level: 0,
        openIndex: null,
        openBox: null,
        openSide: 'right',
        autoFocus: false,
        handlers: { onChoose: noop, onAction: noop, onDismiss: noop },
        onOpen: noop,
        onCloseChild: noop,
        onCloseLevel: noop,
      }),
    )
    expect(html).toContain('<span class="kit-label__text">Make Atelier your default browser</span>')
    expect(html).toContain('class="kit-desc"')
  })

  it('the label box truncates with an ellipsis on one line', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'overlay', 'kit', 'kit.css'), 'utf8')
    const rule = /\.kit-label__text\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
  })
})
