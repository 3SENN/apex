/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { ARTIFACTS_PARTITION, artifactIdOf, artifactUrl, isArtifactUrl } from '@shared/files'
import { PREVIEW_CSP, sandboxedDocument } from '@shared/filesLogic'
import { markdownDocument } from '../src/main/artifacts/markdownHtml'
import { ARTIFACT_CSP, artifactDocument, artifactHeaders, artifactNavigationAllowed, artifactRequestAllowed, withTitle } from '../src/main/artifacts/policy'

// Artifacts: atelier-artifact://<fileId>/ in the in-memory atelier-artifacts
// partition. Every request but the artifact's own is cancelled, navigation
// stays on the page, and the document's policy keeps it off the network.

const ID = '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e'

describe('artifact addresses', () => {
  it('round-trips a Library file id and refuses anything else', () => {
    expect(artifactUrl(ID.toUpperCase())).toBe(`atelier-artifact://${ID}/`)
    expect(artifactIdOf(artifactUrl(ID))).toBe(ID)
    expect(artifactIdOf(`atelier-artifact://${ID}/index.html#part`)).toBe(ID)
    expect(artifactIdOf(`atelier-artifact://${ID}/other.js`)).toBeNull()
    expect(artifactIdOf('atelier-artifact://not-an-id/')).toBeNull()
    expect(artifactIdOf(`https://${ID}/`)).toBeNull()
    expect(isArtifactUrl(artifactUrl(ID))).toBe(true)
    expect(isArtifactUrl('atelier://file?src=x')).toBe(false)
    expect(ARTIFACTS_PARTITION).toBe('atelier-artifacts')
  })
})

describe('the artifact request filter', () => {
  it('lets only the artifact itself, data: and blob: through', () => {
    const allowed = (url: string): boolean => artifactRequestAllowed({ url, resourceType: 'script' })
    expect(allowed(artifactUrl(ID))).toBe(true)
    expect(allowed('data:image/png;base64,AA==')).toBe(true)
    expect(allowed('blob:atelier-artifact://x/1')).toBe(true)
    for (const url of ['https://example.test/x.js', 'http://127.0.0.1:9/', 'ws://127.0.0.1/', 'file:///etc/hosts', 'atelier://settings', 'atelier-file://0123456789abcdef0123456789abcdef/a.png', 'chrome-extension://x/y']) {
      expect(allowed(url), url).toBe(false)
    }
  })

  it('keeps navigation on the artifact page', () => {
    const here = artifactUrl(ID)
    expect(artifactNavigationAllowed(here, `${here}#section`)).toBe(true)
    expect(artifactNavigationAllowed(here, artifactUrl('11111111-2222-4333-8444-555555555555'))).toBe(false)
    expect(artifactNavigationAllowed(here, 'https://example.test/')).toBe(false)
    expect(artifactNavigationAllowed('https://example.test/', here)).toBe(false)
  })
})

describe('artifact documents', () => {
  it('carries the sandbox policy on every response', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline' atelier-artifact:")
    expect(ARTIFACT_CSP).toContain("style-src 'unsafe-inline' atelier-artifact:")
    expect(ARTIFACT_CSP).toContain('img-src atelier-artifact: data: blob:')
    expect(ARTIFACT_CSP).not.toMatch(/connect-src|https?:/)
    const headers = artifactHeaders('text/html; charset=utf-8')
    expect(headers['content-security-policy']).toBe(ARTIFACT_CSP)
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cache-control']).toBe('no-store')
  })

  it('serves HTML with a title, SVG as itself and Markdown as a page; other kinds are not artifacts', () => {
    const html = artifactDocument({ name: 'Plan.html', mediaType: 'text/html' }, '<html><head></head><body>Hi</body></html>')
    expect(html?.body).toContain('<title>Plan</title>')
    expect(html?.contentType).toMatch(/^text\/html/)
    expect(withTitle('<title>Own</title><p>x', 'Other')).toBe('<title>Own</title><p>x')
    expect(withTitle('<p>bare', 'A & B')).toContain('<title>A &amp; B</title>')
    expect(artifactDocument({ name: 'logo.svg', mediaType: 'image/svg+xml' }, '<svg/>')).toEqual({ body: '<svg/>', contentType: 'image/svg+xml; charset=utf-8' })
    const md = artifactDocument({ name: 'Notes.md', mediaType: 'text/markdown' }, '# Hello\n\n<script>alert(1)</script>')
    expect(md?.contentType).toMatch(/^text\/html/)
    expect(md?.body).not.toContain('<script>alert(1)</script>')
    expect(artifactDocument({ name: 'data.csv', mediaType: 'text/csv' }, 'a,b')).toBeNull()
  })

  it('renders Markdown with every piece of text escaped and only safe links', () => {
    const page = markdownDocument('A [link](javascript:alert(1)) and **"bold"** <b>tag</b>', 'T <x>')
    expect(page).toContain('<title>T &lt;x&gt;</title>')
    expect(page).not.toContain('javascript:')
    expect(page).toContain('&lt;b&gt;tag&lt;/b&gt;')
  })
})

describe('HTML previews (OV-32)', () => {
  it('put their own no-network policy before any of the file’s markup', () => {
    const doc = sandboxedDocument('<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><img src="https://track.test/p.gif"></html>')
    const policy = doc.indexOf(PREVIEW_CSP)
    expect(policy).toBeGreaterThan(0)
    expect(policy).toBeLessThan(doc.indexOf('<html>'))
    expect(PREVIEW_CSP).toContain("default-src 'none'")
    expect(PREVIEW_CSP).toContain('img-src data:')
    expect(PREVIEW_CSP).not.toMatch(/script-src|https?:/)
  })
})
