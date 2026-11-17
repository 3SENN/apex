/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// How an app a companion builds should look (APP-UI): the notes build_app
// carries, and the design check its result reports. Apex serves every app
// with Apex UI (src/kit/ui.css: the browser's tokens and ax-* components),
// so an app built with it looks like the rest of Apex. Its ideas draw on
// public interface guidelines (credited
// in docs/apps.md › Apex UI).

import { BRAND_NAME } from './branding'
/** The rules both kinds of app share: the tokens, the components, how it should feel and what to leave out. */
const APP_DESIGN_RULES = `- Tokens (CSS variables): page var(--bg-page), a raised group var(--bg-raised), quiet fills var(--bg-subtle) and var(--bg-muted); text var(--text-primary), var(--text-secondary), var(--text-tertiary); lines var(--border-subtle), var(--border-default), var(--border-strong); state var(--status-success), var(--status-needs-input), var(--status-error) (each with -soft); var(--accent) is the person's companion colour, only for what is selected and for the companion's own actions. Space var(--space-1) to var(--space-12) on a 4 px scale, radius var(--radius-control), var(--radius-md), var(--radius-card), type var(--text-sm), var(--text-md), var(--text-ui), var(--text-lg), var(--text-xl), var(--text-2xl). Never write colours out: the tokens switch between light and dark on their own. The font is already Inter, ${BRAND_NAME}'s own; set no font-family (var(--font-mono) for code).
- Components: .ax-app (the page column; .ax-app--wide, .ax-app--full for canvases and games), .ax-header with .ax-title and .ax-subtitle, .ax-section with .ax-section__title, .ax-card for one group that belongs together, .ax-btn (--primary for the one main action, --accent for the companion's own action, --ghost, --danger, --sm, --icon), .ax-field with .ax-label, .ax-input, .ax-select, .ax-textarea, .ax-hint and .ax-error, .ax-segmented (role="radiogroup", buttons with role="radio" and aria-checked), input.ax-switch (role="switch"), .ax-list with .ax-row (.ax-row__main, __title, __meta, __end), .ax-pairs for labelled results, .ax-table, .ax-empty, .ax-badge, .ax-notice, .ax-progress, dialog.ax-dialog, .ax-stack, .ax-cluster and .ax-grid for layout, .ax-num for figures, svg.ax-icon for 16 px line icons.
- Calm and clear: left-aligned, one column at a readable width, more space between groups than inside them. One primary button per screen, named for what it does ("Split the bill", not "Submit"). Design the empty state (what to do first), errors next to the field they're about (what's wrong and how to fix it), and what shows while it works.
- Numbers: Intl.NumberFormat and Intl.DateTimeFormat in the person's locale, tabular figures, inputmode="decimal" for amounts.
- Leave out: gradients, glows and frosted glass; emoji as icons or in headings (draw a small inline SVG instead); a card around every item, or cards in cards; coloured stripes along a box's edge; all-caps labels; a huge number over a tiny label; centring everything; animation that's only decoration.`

/** What build_app tells the model about design: Apex puts Apex UI in the app, the rules, and the look at the draft. */
export const APP_DESIGN_NOTES = `Design: ${BRAND_NAME} puts its own interface kit, ${BRAND_NAME} UI, in every app, so build with it and the app looks like the rest of ${BRAND_NAME} (read_skill "app-design" has examples of every part).
${APP_DESIGN_RULES}
The result shows the draft in light and dark and lists design problems it found: look, fix what's off, then tell the person.`

/** The build guide's design part for pack apps, which link Apex UI themselves. */
export const PACK_DESIGN_NOTES = `DESIGN (every app looks like ${BRAND_NAME}: ${BRAND_NAME} UI)
- Link ${BRAND_NAME} UI first in each page's <head>, before your own CSS: <link rel="stylesheet" href="/__apex/kit/1/apex-kit/ui.css"> (the app needs kit: 1; the starters do). In a canvas or three.js scene take colours from it: getComputedStyle(document.body).backgroundColor for the page, a hidden probe element with color: var(--accent) for a token; read them again when prefers-color-scheme changes.
${APP_DESIGN_RULES}
- Look at test_pack's frames before propose_pack: fix anything cut off, cramped or low in contrast.`

// ---- the design check ----

/** The app's own CSS: every <style> block and style attribute. */
function cssOf(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '')
  const inline = [...html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)].map((m) => m[2] ?? '')
  return [...blocks, ...inline].join('\n')
}

/** Colours written out in declarations, leaving out custom property definitions (a token of the app's own is fine). */
function colourLiterals(css: string): number {
  const withoutTokens = css.replace(/--[\w-]+\s*:[^;}]*[;}]/g, '')
  return (withoutTokens.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/gi) ?? []).length
}

const NOT_LABELLED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

/** Form controls with no label: no aria-label(ledby), no title, no <label for>, and not inside a <label>. */
function unlabelledControls(html: string): number {
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))
  const insideLabel: Array<[number, number]> = []
  for (const m of html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)) insideLabel.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  let count = 0
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = m[2] ?? ''
    const type = /\btype\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? 'text'
    if (m[1]?.toLowerCase() === 'input' && NOT_LABELLED_TYPES.has(type)) continue
    if (/\baria-label(?:ledby)?\s*=|\btitle\s*=/i.test(attrs)) continue
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (id && labelled.has(id)) continue
    const at = m.index ?? 0
    if (insideLabel.some(([from, to]) => at > from && at < to)) continue
    count++
  }
  return count
}

/** Emoji standing in for icons: in headings, buttons, labels or the title (not ©, ® or ™). */
function emojiIcons(html: string): boolean {
  const spots = [...html.matchAll(/<(h[1-6]|button|label|title)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => (m[2] ?? '').replace(/<[^>]+>/g, ''))
  return spots.some((text) => /\p{Extended_Pictographic}/u.test(text.replace(/[©®™]/g, '')))
}

/**
 * The design problems an app's HTML shows, as short instructions for the
 * model (at most eight). Heuristic and never blocking: build_app reports
 * them next to the screenshots so the model can fix them in its next draft.
 */
export function lintAppDesign(html: string): string[] {
  const css = cssOf(html)
  const out: string[] = []
  if (!/\bax-[a-z]/.test(html) && !/var\(--(?:bg|text|border|space|radius|accent|status)-/.test(css)) {
    out.push(`It doesn’t use ${BRAND_NAME} UI: build with the ax-* components and the var(--…) tokens so it matches ${BRAND_NAME} in light and dark.`)
  }
  const colours = colourLiterals(css)
  if (colours >= 4) out.push(`${colours} colours are written out in its CSS: use the tokens (var(--text-primary), var(--bg-raised), var(--border-default), var(--accent)…) so it works in light and dark.`)
  if (/(?:linear|radial|conic)-gradient\(/i.test(css)) out.push(`It uses gradients: ${BRAND_NAME} surfaces are flat. Use a token fill; keep a gradient only where it carries meaning (a heat map, a colour picker).`)
  if (/backdrop-filter\s*:/i.test(css)) out.push('It uses frosted glass (backdrop-filter): use var(--bg-raised) with the hairline shadow instead.')
  if (/box-shadow\s*:[^;}]*\b0\s+0\s+(?:[1-9]\d|[2-9])\d*px[^;}]*(?:#|rgba?\(|hsla?\(|var\(--accent)/i.test(css)) out.push(`It has glowing shadows: drop them; depth in ${BRAND_NAME} is a hairline and a soft low shadow (var(--shadow-xs), var(--shadow-sm)).`)
  if (emojiIcons(html)) out.push('It uses emoji as icons or in headings: draw a small inline SVG icon (svg.ax-icon) or use words.')
  if (/font-family\s*:\s*(?![^;}]*(?:var\(--font|inherit|mono))/i.test(css)) out.push(`It sets its own font: leave font-family out (the page has Inter, ${BRAND_NAME}’s font), or use var(--font-mono) for code.`)
  if (/border-left\s*:\s*(?:[3-9]|\d{2,})px\s+solid/i.test(css)) out.push('It puts a coloured stripe along a box’s edge: use a badge, an .ax-notice tone or plain text for state instead.')
  if (/text-transform\s*:\s*uppercase/i.test(css)) out.push('It sets labels in all caps: use sentence case (an .ax-section__title is the label style).')
  if (/outline\s*:\s*(?:none|0)\b/i.test(css) && !/:focus-visible/i.test(css)) out.push(`It removes the focus outline without a :focus-visible style: keyboard users lose their place. Leave the outline to ${BRAND_NAME} UI.`)
  if (/transition\s*:\s*all\b/i.test(css)) out.push('It uses transition: all: name the properties that change (background, opacity, transform).')
  const unlabelled = unlabelledControls(html)
  if (unlabelled > 0) out.push(`${unlabelled === 1 ? 'A form control has' : `${unlabelled} form controls have`} no label: give each a visible <label for> (or aria-label for an icon-only control).`)
  return out.slice(0, 8)
}
