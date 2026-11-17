/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ARTIFACT_SCHEME, artifactIdOf } from '@shared/files'
import { markdownDocument } from './markdownHtml'

// The artifact sandbox's rules, kept pure so they are tested without
// Electron: which requests an artifact tab may make, where it may navigate,
// its Content-Security-Policy, and the document each file kind becomes.

/** Inline scripts and styles run; nothing reaches the network, frames, forms or plugins. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${ARTIFACT_SCHEME}:`,
  `style-src 'unsafe-inline' ${ARTIFACT_SCHEME}:`,
  `img-src ${ARTIFACT_SCHEME}: data: blob:`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** webRequest.lockdown's allow function for the apex-artifacts partition: every other request is cancelled. */
export function artifactRequestAllowed(d: { url: string; resourceType: string }): boolean {
  return d.url.startsWith(`${ARTIFACT_SCHEME}://`) || d.url.startsWith('data:') || d.url.startsWith('blob:')
}

/** An artifact tab may only reload itself or move within its own page (a #fragment). */
export function artifactNavigationAllowed(current: string, target: string): boolean {
  const from = artifactIdOf(current)
  return from !== null && artifactIdOf(target) === from
}

const HEAD = /<head(\s[^>]*)?>/i

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Gives an HTML artifact a <title> (the file's name) when it has none, so its tab reads well. */
export function withTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) return html
  const tag = `<title>${escapeHtml(title)}</title>`
  if (HEAD.test(html)) return html.replace(HEAD, (m) => `${m}${tag}`)
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${tag}</head>`)
  return `<!doctype html><meta charset="utf-8">${tag}${html}`
}

export interface ArtifactDocument {
  body: string
  contentType: string
}

/** What an apex-artifact:// request returns for a Library file, or null when that kind can't be an artifact. */
export function artifactDocument(file: { name: string; mediaType: string }, content: string): ArtifactDocument | null {
  const title = file.name.replace(/\.[^.]+$/, '') || file.name
  if (file.mediaType === 'text/html') return { body: withTitle(content, title), contentType: 'text/html; charset=utf-8' }
  if (file.mediaType === 'image/svg+xml') return { body: content, contentType: 'image/svg+xml; charset=utf-8' }
  if (file.mediaType === 'text/markdown') return { body: markdownDocument(content, title), contentType: 'text/html; charset=utf-8' }
  return null
}

/** Response headers for every artifact document. */
export function artifactHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  }
}
