/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CertificateDecisions, certificateDecisions, certificateDetails, certificates, formatFingerprint, pendingCertificates } from '../src/main/certificates'

// Certificate details for site info and the interstitial, and the
// session's "Proceed anyway" cache keyed by host and fingerprint.

const pem = readFileSync(join(__dirname, 'fixtures', 'tls', 'cert.pem'), 'utf8')
const x509 = new X509Certificate(pem)
/** Electron's fingerprint: "sha256/" and the base64 SHA-256 of the DER. */
const electronFingerprint = `sha256/${createHash('sha256').update(x509.raw).digest('base64')}`

describe('certificate details', () => {
  it('formats Electron fingerprints the way certificate viewers show them', () => {
    expect(formatFingerprint(electronFingerprint)).toBe(x509.fingerprint256)
    expect(formatFingerprint('not a fingerprint')).toBe('not a fingerprint')
    expect(formatFingerprint('sha256/')).toBe('sha256/')
  })

  it('describes the fixture certificate with validity in milliseconds', () => {
    const validStart = Date.parse(x509.validFrom) / 1000
    const validExpiry = Date.parse(x509.validTo) / 1000
    const d = certificateDetails({ subjectName: 'Atelier smoke fixture', issuerName: 'Atelier smoke fixture', validStart, validExpiry, fingerprint: electronFingerprint }, 'TLS 1.3')
    expect(d).toEqual({
      subject: 'Atelier smoke fixture',
      issuer: 'Atelier smoke fixture',
      validFrom: validStart * 1000,
      validTo: validExpiry * 1000,
      protocol: 'TLS 1.3',
      sha256: x509.fingerprint256,
    })
    expect(x509.subject).toContain('Atelier smoke fixture')
  })

  it('falls back to the common names', () => {
    const d = certificateDetails({ subjectName: '', issuerName: '', subject: { commonName: 'site.example' }, issuer: { commonName: 'Example CA' }, validStart: 1, validExpiry: 2, fingerprint: 'sha256/AAAA' })
    expect(d.subject).toBe('site.example')
    expect(d.issuer).toBe('Example CA')
    expect(d.protocol).toBe('TLS')
  })

  it('keeps the verified certificate per host, case-insensitively', () => {
    const d = certificateDetails({ subjectName: 'a', issuerName: 'b', validStart: 1, validExpiry: 2, fingerprint: electronFingerprint })
    certificates.record('Secure.Example', d)
    expect(certificates.details('secure.example')).toEqual(d)
    expect(certificates.details('other.example')).toBeNull()
  })
})

describe('the Proceed anyway cache', () => {
  it('lets through only the host and certificate the person accepted', () => {
    const c = new CertificateDecisions()
    expect(c.isAllowed('self-signed.example', 'sha256/A')).toBe(false)
    c.allow('Self-Signed.example', 'sha256/A')
    expect(c.isAllowed('self-signed.example', 'sha256/A')).toBe(true)
    // Another bad certificate on the same host asks again.
    expect(c.isAllowed('self-signed.example', 'sha256/B')).toBe(false)
    // The same certificate on another host does too.
    expect(c.isAllowed('other.example', 'sha256/A')).toBe(false)
    expect(c.hasHost('self-signed.example')).toBe(true)
    expect(c.hasHost('other.example')).toBe(false)
    c.clear()
    expect(c.isAllowed('self-signed.example', 'sha256/A')).toBe(false)
  })

  it('keeps each session’s answers apart, so a private window asks again', () => {
    const normal = {}
    const priv = {}
    certificateDecisions(normal).allow('a.example', 'sha256/A')
    expect(certificateDecisions(normal).isAllowed('a.example', 'sha256/A')).toBe(true)
    expect(certificateDecisions(priv).isAllowed('a.example', 'sha256/A')).toBe(false)
    expect(certificateDecisions(normal)).toBe(certificateDecisions(normal))
  })

  it('remembers the refused certificate per tab until it is cleared', () => {
    const details = certificateDetails({ subjectName: 'x', issuerName: 'y', validStart: 1, validExpiry: 2, fingerprint: electronFingerprint })
    pendingCertificates.set(41, { host: 'a.example', fingerprint: electronFingerprint, error: 'net::ERR_CERT_AUTHORITY_INVALID', details })
    expect(pendingCertificates.get(41)?.host).toBe('a.example')
    expect(pendingCertificates.get(42)).toBeNull()
    pendingCertificates.clear(41)
    expect(pendingCertificates.get(41)).toBeNull()
  })
})
