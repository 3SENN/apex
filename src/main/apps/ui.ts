/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex UI in every build_app app (APP-UI): the kit's ui.css (the browser's
// tokens and ax-* components, Inter inline) goes first in the app's <head>
// as it's served, with the colours of the companion that built it, so the
// app looks like the rest of Apex without carrying any of it. The app's own
// CSS sits outside the stylesheet's layers and always wins.
import { BRAND_NAME } from '@shared/branding'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accentVariables } from '@shared/accent'
import { log } from '../log'
import { appRoot } from '../resources'

let cached: string | null | undefined

/** The kit's ui.css, read once; null when the kit isn't built (apps are then served as they are). */
export function kitUiCss(): string | null {
  if (cached !== undefined) return cached
  try {
    cached = readFileSync(join(appRoot(), 'out', 'kit', '1', 'apex-kit', 'ui.css'), 'utf8')
  } catch {
    log.warn('apps', `${BRAND_NAME} UI for apps is missing (out/kit/1/apex-kit/ui.css); apps are served without it`)
    cached = null
  }
  return cached
}

/** The <style> an app gets: Apex UI, then the companion's accent in its token layer. Empty without the kit. */
export function appUiStyle(css: string | null, accent: string | null): string {
  if (!css) return ''
  const vars = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? Object.entries(accentVariables(accent)).map(([name, value]) => `${name}: ${value};`).join(' ') : ''
  return `<style data-apex-ui>\n${css}${vars ? `\n@layer apex.tokens { :root { ${vars} } }` : ''}\n</style>`
}

/** Puts `style` first in the document's <head>, making one when the app has none. */
export function withAppUi(html: string, style: string): string {
  if (!style) return html
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + style + html.slice(at)
  }
  const root = /<html(?:\s[^>]*)?>/i.exec(html)
  if (root) {
    const at = root.index + root[0].length
    return `${html.slice(0, at)}<head>${style}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return `${html.slice(0, at)}${style}${html.slice(at)}`
}
