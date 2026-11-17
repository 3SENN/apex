/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { unzipSync } from 'fflate'

// CRX3 packages from the Web Store. electron-chrome-web-store unpacks
// without checking signatures and with adm-zip (advisories), so Apex does
// both itself: every key proof must verify, one must be the extension's own
// key (its id is derived from it), and, for store installs, one must be the
// Web Store's publisher key. Then fflate unzips into the profile's folder,
// refusing paths that escape it.

/** SHA-256 of the Chrome Web Store's publisher key. */
export const WEB_STORE_PUBLISHER_KEY_SHA256 = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf'
export const CRX_MAX_BYTES = 200 * 1024 * 1024
const UNPACKED_MAX_BYTES = 512 * 1024 * 1024
const MAX_FILES = 20_000

type Field = [number, Buffer | number]

function varint(buf: Buffer, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let o = offset
  for (;;) {
    if (o >= buf.length || shift > 49) throw new Error('The package header is damaged.')
    const byte = buf[o++] ?? 0
    result += (byte & 0x7f) * 2 ** shift
    shift += 7
    if ((byte & 0x80) === 0) return [result, o]
  }
}

/** Decodes one protobuf message's top-level fields (varints and length-delimited only, which is all CRX3 uses). */
export function protoFields(buf: Buffer): Field[] {
  const out: Field[] = []
  let o = 0
  while (o < buf.length) {
    const [key, next] = varint(buf, o)
    o = next
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) {
      const [value, after] = varint(buf, o)
      out.push([field, value])
      o = after
    } else if (wire === 2) {
      const [length, after] = varint(buf, o)
      if (after + length > buf.length) throw new Error('The package header is damaged.')
      out.push([field, buf.subarray(after, after + length)])
      o = after + length
    } else {
      throw new Error('The package header is damaged.')
    }
  }
  return out
}

const bytesOf = (fields: Field[], n: number): Buffer[] => fields.filter(([f, v]) => f === n && Buffer.isBuffer(v)).map(([, v]) => v as Buffer)

/** Chrome's id for a public key: the first 16 bytes of its SHA-256, each nibble as a–p. */
export function idFromPublicKey(spki: Buffer): string {
  return [...createHash('sha256').update(spki).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('')
}

export interface CrxCheck {
  id: string
  archive: Buffer
  publisherSigned: boolean
  /** The extension's own public key (base64 SPKI), written into manifest.json so Electron derives the same id. */
  publicKey: string
}

/**
 * Parses and verifies a CRX3 file. Throws with a plain reason when the
 * format is wrong, a signature fails, the id doesn't match its key, or a
 * store package lacks the publisher's signature.
 */
export function verifyCrx(buf: Buffer, opts: { expectedId?: string; requirePublisher: boolean }): CrxCheck {
  if (buf.length > CRX_MAX_BYTES) throw new Error('The extension package is too large.')
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('This is not an extension package.')
  if (buf.readUInt32LE(4) !== 3) throw new Error(`This extension package uses an old format ${BRAND_NAME} doesn’t accept.`)
  const headerSize = buf.readUInt32LE(8)
  if (12 + headerSize > buf.length) throw new Error('The package header is damaged.')
  const header = protoFields(buf.subarray(12, 12 + headerSize))
  const archive = buf.subarray(12 + headerSize)
  const signed = bytesOf(header, 10000)[0]
  if (!signed) throw new Error('The package isn’t signed.')
  const crxId = bytesOf(protoFields(signed), 1)[0]
  if (!crxId || crxId.length !== 16) throw new Error('The package isn’t signed.')
  const id = [...crxId].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('')
  if (opts.expectedId && id !== opts.expectedId) throw new Error('The package is for a different extension.')

  const length = Buffer.alloc(4)
  length.writeUInt32LE(signed.length)
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signed, archive])
  // Field 2 holds RSA-SHA256 proofs, field 3 ECDSA-SHA256 ones.
  const proofs = [...bytesOf(header, 2), ...bytesOf(header, 3)]
  if (proofs.length === 0) throw new Error('The package isn’t signed.')
  let developer: Buffer | null = null
  let publisher = false
  for (const proof of proofs) {
    const fields = protoFields(proof)
    const key = bytesOf(fields, 1)[0]
    const signature = bytesOf(fields, 2)[0]
    if (!key || !signature) throw new Error('A package signature is damaged.')
    let ok = false
    try {
      ok = verify('sha256', message, createPublicKey({ key, format: 'der', type: 'spki' }), signature)
    } catch {
      ok = false
    }
    if (!ok) throw new Error('A package signature doesn’t match its contents.')
    if (idFromPublicKey(key) === id) developer = key
    if (createHash('sha256').update(key).digest('hex') === WEB_STORE_PUBLISHER_KEY_SHA256) publisher = true
  }
  if (!developer) throw new Error('The package isn’t signed by its own key.')
  if (opts.requirePublisher && !publisher) throw new Error('The package isn’t signed by the Chrome Web Store.')
  return { id, archive, publisherSigned: publisher, publicKey: developer.toString('base64') }
}

/** Unzips an extension archive into `dir`, refusing absolute paths, `..` and oversized contents. */
export function unpackArchive(archive: Buffer, dir: string): void {
  const files = unzipSync(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength))
  const names = Object.keys(files)
  if (names.length > MAX_FILES) throw new Error('The extension has too many files.')
  let total = 0
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep)
  const writes: Array<[string, Uint8Array]> = []
  for (const name of names) {
    const data = files[name]
    if (!data) continue
    if (name.endsWith('/')) continue
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /^[a-z]:/i.test(name)) throw new Error('The extension package has unsafe file names.')
    const target = normalize(join(dir, name))
    if (!target.startsWith(root)) throw new Error('The extension package has unsafe file names.')
    total += data.length
    if (total > UNPACKED_MAX_BYTES) throw new Error('The extension is too large once unpacked.')
    writes.push([target, data])
  }
  if (!writes.some(([path]) => path === join(dir, 'manifest.json'))) throw new Error('The extension package has no manifest.')
  for (const [target, data] of writes) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}

/**
 * Store packages carry no `key` in their manifest; without it Electron
 * derives an unpacked extension's id from its folder path. Writing the
 * package's key back keeps the id the Web Store and the extension expect.
 */
export function writeManifestKey(dir: string, publicKey: string): void {
  const file = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  if (manifest.key === publicKey) return
  manifest.key = publicKey
  writeFileSync(file, JSON.stringify(manifest, null, 2))
}
