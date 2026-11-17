/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The New app flow's brief: what you typed becomes the first
// message, and Apex's own build rules ride along as a context block, so the
// companion builds with build_app inside the sandbox's limits.

import { BRAND_NAME } from '@shared/branding'
export function buildBrief(description: string): { text: string; context: string } {
  return {
    text: `Build me an app: ${description.trim()}`,
    context: [
      'You are building a small app for the person with the build_app tool.',
      'Rules for the app:',
      '- One complete HTML document, at most 2 MB, with every style and script inline.',
      '- It runs sandboxed with no network: no fetch or XHR, no external scripts, stylesheets, fonts or images, no iframes, no pop-ups and no links that navigate away. Draw icons with inline SVG; use data: URLs for any image.',
      '- localStorage is available for anything it should remember between runs.',
      '- It must work with the keyboard alone, label its controls for screen readers, and follow prefers-color-scheme for light and dark. Respect prefers-reduced-motion.',
      `- Build it with ${BRAND_NAME} UI, the interface kit ${BRAND_NAME} puts in every app (the build_app notes list its tokens and ax-* components), so it looks like the rest of ${BRAND_NAME}.`,
      '- Give it a short name and a one-sentence description.',
      'If the request is unclear, ask one short question first. Otherwise build it, look at the light and dark screenshots build_app returns and fix what’s off, then say in two or three sentences what it does and how to use it. The person previews the draft in the card under your message and presses Save to keep it; to change it later, call build_app again with its appId.',
    ].join('\n'),
  }
}
