/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Certificate, Session } from 'electron'
import type { CertificateDetails } from '@shared/sites'

// Certificates: the details of verified
// connections per host for site info, the certificate an erroring page
// offered for the interstitial, and the "Proceed anyway" decisions, which
// last for the session and are keyed by host and fingerprint, so a site that
// later shows another bad certificate asks again.

const byHost = new Map<string, CertificateDetails>()

/** Electron's "sha256/<base64>" fingerprint as colon-separated hex, the way certificate viewers show it. */
export function formatFingerprint(fingerprint: string): string {
  const match = /^sha256\/(.+)$/i.exec(fingerprint.trim())
  if (!match) return fingerprint
  const bytes = Buffer.from(match[1] ?? '', 'base64')
  if (bytes.length === 0) return fingerprint
  return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/** What site info shows of an Electron certificate. Validity is in ms; Electron gives seconds. */
export function certificateDetails(cert: Pick<Certificate, 'subjectName' | 'issuerName' | 'validStart' | 'validExpiry' | 'fingerprint'> & { subject?: { commonName?: string }; issuer?: { commonName?: string } }, protocol = 'TLS'): CertificateDetails {
  return {
    subject: cert.subjectName || cert.subject?.commonName || '',
    issuer: cert.issuerName || cert.issuer?.commonName || '',
    validFrom: Math.round(cert.validStart * 1000),
    validTo: Math.round(cert.validExpiry * 1000),
    protocol,
    sha256: formatFingerprint(cert.fingerprint),
  }
}

export const certificates = {
  details(host: string): CertificateDetails | null {
    return byHost.get(host.toLowerCase()) ?? null
  },
  record(host: string, details: CertificateDetails): void {
    byHost.set(host.toLowerCase(), details)
  },
}

/** One session's "Proceed anyway" answers: host → the fingerprints allowed. */
export class CertificateDecisions {
  readonly #allowed = new Map<string, Set<string>>()

  allow(host: string, fingerprint: string): void {
    const key = host.toLowerCase()
    const set = this.#allowed.get(key) ?? new Set<string>()
    set.add(fingerprint)
    this.#allowed.set(key, set)
  }

  isAllowed(host: string, fingerprint: string): boolean {
    return this.#allowed.get(host.toLowerCase())?.has(fingerprint) ?? false
  }

  /** Whether any certificate was let through for this host (the tab's cert-bypassed state). */
  hasHost(host: string): boolean {
    return (this.#allowed.get(host.toLowerCase())?.size ?? 0) > 0
  }

  clear(): void {
    this.#allowed.clear()
  }
}

const decisions = new WeakMap<object, CertificateDecisions>()

/** The decisions of one session (private windows and profiles keep their own). */
export function certificateDecisions(session: object): CertificateDecisions {
  let d = decisions.get(session)
  if (!d) {
    d = new CertificateDecisions()
    decisions.set(session, d)
  }
  return d
}

/** The bad certificate a tab's page was refused for, until it navigates away. */
export interface PendingCertificate {
  host: string
  fingerprint: string
  /** Electron's error string, e.g. "net::ERR_CERT_AUTHORITY_INVALID". */
  error: string
  details: CertificateDetails
}

const pending = new Map<number, PendingCertificate>()

export const pendingCertificates = {
  set(webContentsId: number, p: PendingCertificate): void {
    pending.set(webContentsId, p)
  },
  get(webContentsId: number): PendingCertificate | null {
    return pending.get(webContentsId) ?? null
  },
  clear(webContentsId: number): void {
    pending.delete(webContentsId)
  },
}

/**
 * Records the certificate of every verified connection for site info. It
 * never changes the verdict: -3 keeps Chromium's own result, so bad
 * certificates still reach the certificate-error handler and its interstitial.
 */
export function installCertificateRecorder(session: Session): void {
  session.setCertificateVerifyProc((request, callback) => {
    try {
      if (request.errorCode === 0) certificates.record(request.hostname, certificateDetails(request.certificate))
    } finally {
      callback(-3)
    }
  })
}
