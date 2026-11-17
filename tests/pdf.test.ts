/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdf, pageMarker } from '../src/main/pdf/extract'
import { workerPdfReader } from '../src/main/pdf/client'
import { pdfPageLimit, preparePdfText } from '../src/main/intake/prepare'
import { ATTACHMENT_LIMITS } from '../src/shared/attachments'
import { brokenPdf, buildPdf } from '../src/main/smokeFilesConnectors/intakeFixtures'

// Page counts, text with page markers, page caps, and refusing
// encrypted and broken files; the worker client's timeout.

describe('extractPdf', () => {
  it('reads the page count and text with a marker per page', async () => {
    const result = await extractPdf(buildPdf(3), 600)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(3)
    expect(result.text).toContain(pageMarker(1))
    expect(result.text).toContain(pageMarker(3))
    expect(result.text).toContain('Page 2 of the fixture')
  })

  it('refuses more pages than the cap, saying how many there are', async () => {
    const result = await extractPdf(buildPdf(5), 4)
    expect(result).toEqual({ ok: false, error: 'too-many-pages', pages: 5 })
  })

  it('refuses encrypted and broken files', async () => {
    expect(await extractPdf(buildPdf(1, { encrypted: true }), 600)).toEqual({ ok: false, error: 'encrypted' })
    expect(await extractPdf(brokenPdf(), 600)).toMatchObject({ ok: false, error: 'broken' })
  })

  it("leaves the caller's bytes usable", async () => {
    const bytes = buildPdf(1)
    await extractPdf(bytes, 600)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect((await extractPdf(bytes, 600)).ok).toBe(true)
  })
})

describe('page caps and reasons', () => {
  it('uses the smaller cap for 200k-context models', () => {
    expect(pdfPageLimit('claude-haiku-4-5')).toBe(ATTACHMENT_LIMITS.pdfPagesSmallContext)
    expect(pdfPageLimit('claude-opus-5-5')).toBe(ATTACHMENT_LIMITS.pdfPages)
  })

  it('words each failure in plain language', async () => {
    const reader = (result: Awaited<ReturnType<ReturnType<typeof workerPdfReader>['read']>>) => ({ read: async () => result })
    await expect(preparePdfText(new Uint8Array(1), 100, reader({ ok: false, error: 'too-many-pages', pages: 140 }))).rejects.toThrow(/140/)
    await expect(preparePdfText(new Uint8Array(1), 100, reader({ ok: false, error: 'encrypted' }))).rejects.toThrow(/password/i)
    await expect(preparePdfText(new Uint8Array(1), 100, reader({ ok: false, error: 'timeout' }))).rejects.toThrow()
    await expect(preparePdfText(new Uint8Array(1), 100, reader({ ok: true, pages: 2, text: 'hi' }))).resolves.toEqual({ pages: 2, text: 'hi' })
  })
})

describe('workerPdfReader', () => {
  it('ends a worker that hangs after the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-pdf-'))
    const script = join(dir, 'hang.cjs')
    writeFileSync(script, "require('node:worker_threads').parentPort.on('message', () => {})\n")
    const result = await workerPdfReader(() => script, 200).read(buildPdf(1), 600)
    expect(result).toEqual({ ok: false, error: 'timeout' })
  })

  it('reports a worker that cannot start as broken', async () => {
    const result = await workerPdfReader(() => '/no/such/worker.js', 1000).read(buildPdf(1), 600)
    expect(result).toEqual({ ok: false, error: 'broken' })
  })
})
