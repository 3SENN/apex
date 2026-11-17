/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier's certificate for apps' servers on the Wi-Fi (docs/packs.md › A web
// server of its own). Phones give motion sensors (and more) only to secure
// pages, so a server on the Wi-Fi is HTTPS with a self-signed certificate,
// made once per install and kept in Atelier's data folder: a phone accepts it
// once. It names this computer's LAN addresses; a new address is added (with
// the ones before it, so moving between home and work doesn't undo a phone's
// acceptance each time), and a certificate near its end is replaced. RSA 2048
// with SHA-256, the shape phones accept for a self-signed page.
import { BRAND_NAME } from '@shared/branding'
import { generateKeyPair, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'

export interface ServerCertificate {
  key: string
  cert: string
}

/** A year: within what browsers accept for a server certificate. */
const DAYS = 365
/** Replaced this long before it ends. */
const RENEW_MS = 30 * 24 * 60 * 60_000
/** Addresses it keeps naming at most. */
const MAX_ADDRESSES = 8

function rsaPair(): Promise<{ publicKey: string; privateKey: string }> {
  return new Promise((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })))
  })
}

/** This computer's name on the network (name.local), when it is a valid DNS name. */
export function localHostName(): string | null {
  const name = hostname().replace(/\.local$/i, '')
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name) ? `${name}.local` : null
}

/** Makes a certificate for these addresses (made off the main thread's way: Node makes the key). */
export async function makeServerCertificate(ips: readonly string[], now = new Date()): Promise<ServerCertificate> {
  const pair = await rsaPair()
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey)
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`
  cert.validity.notBefore = new Date(now.getTime() - 60_000)
  cert.validity.notAfter = new Date(now.getTime() + DAYS * 24 * 60 * 60_000)
  const attrs = [
    { name: 'commonName', value: `${BRAND_NAME} on this computer` },
    { name: 'organizationName', value: BRAND_NAME },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  const host = localHostName()
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, ...(host ? [{ type: 2, value: host }] : []), { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))],
    },
  ])
  cert.sign(forge.pki.privateKeyFromPem(pair.privateKey), forge.md.sha256.create())
  return { key: pair.privateKey, cert: forge.pki.certificateToPem(cert) }
}

/** Whether a certificate is still good for these addresses at `now`. */
export function certificateCovers(pem: string, ips: readonly string[], now = Date.now()): boolean {
  try {
    const x = new X509Certificate(pem)
    if (Date.parse(x.validTo) - now < RENEW_MS || Date.parse(x.validFrom) > now + 60_000) return false
    return ips.every((ip) => x.checkIP(ip) !== undefined)
  } catch {
    return false
  }
}

let making: Promise<ServerCertificate> | null = null

/** The install's certificate for these addresses: the one kept in `dir`, or a new one that is then kept. */
export async function serverCertificate(dir: string, ips: readonly string[]): Promise<ServerCertificate> {
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  const metaFile = join(dir, 'addresses.json')
  if (existsSync(keyFile) && existsSync(certFile)) {
    const kept = { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') }
    if (certificateCovers(kept.cert, ips)) return kept
  }
  // Two servers starting at once make one certificate.
  if (making) return making
  making = (async () => {
    let before: string[] = []
    try {
      const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as unknown
      if (Array.isArray(parsed)) before = parsed.filter((ip): ip is string => typeof ip === 'string')
    } catch {
      // None yet.
    }
    const all = [...new Set([...ips, ...before])].slice(0, MAX_ADDRESSES)
    const made = await makeServerCertificate(all)
    mkdirSync(dir, { recursive: true })
    writeFileSync(keyFile, made.key, { mode: 0o600 })
    writeFileSync(certFile, made.cert)
    writeFileSync(metaFile, JSON.stringify(all))
    return made
  })()
  try {
    return await making
  } finally {
    making = null
  }
}
