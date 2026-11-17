/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Author keys and trust (docs/packs.md › Sharing). Your key is an Ed25519
// pair made on first export; its private half is encrypted with the system
// keychain (safeStorage) and never leaves this computer. The first install of
// a pack pins its id to the key that signed it (or to "unsigned"); a later
// install or update signed by another key is refused.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import { sha256, signatureSchema, type PackSignature } from './files'

export interface KeyVault {
  encrypt(plain: Buffer): Buffer
  decrypt(sealed: Buffer): Buffer
}

const keyFileSchema = z.object({ version: z.literal(1), keyId: z.string(), publicKey: z.string(), privateKey: z.string() }).strict()

/** The short fingerprint people compare: 16 hex characters of the public key's hash. */
export function keyIdOf(publicKeyDer: Buffer): string {
  return sha256(publicKeyDer).slice(0, 16)
}

/** The full fingerprint trust is pinned to: the public key's whole SHA-256 (the short id is for people to read). */
export function fingerprintOf(signature: Pick<PackSignature, 'publicKey'>): string {
  return sha256(Buffer.from(signature.publicKey, 'base64'))
}

/** Whether a signature is a valid Ed25519 signature of this hash by the key it names. */
export function verifyPackSignature(hash: string, signature: PackSignature): boolean {
  if (!signatureSchema.safeParse(signature).success || signature.hash !== hash) return false
  try {
    const der = Buffer.from(signature.publicKey, 'base64')
    if (keyIdOf(der) !== signature.keyId) return false
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    return verify(null, Buffer.from(hash, 'utf8'), key, Buffer.from(signature.signature, 'base64'))
  } catch {
    return false
  }
}

export class AuthorKey {
  readonly #path: string
  readonly #vault: KeyVault

  constructor(dir: string, vault: KeyVault) {
    this.#path = join(dir, 'author-key.json')
    this.#vault = vault
  }

  /** The fingerprint, or null before the first export. */
  keyId(): string | null {
    const parsed = keyFileSchema.safeParse(readJson(this.#path))
    return parsed.success ? parsed.data.keyId : null
  }

  /** The full fingerprint, making the key the first time. */
  fingerprint(): string {
    return fingerprintOf(this.#load())
  }

  #load(): z.infer<typeof keyFileSchema> {
    const parsed = keyFileSchema.safeParse(readJson(this.#path))
    if (parsed.success) return parsed.data
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = publicKey.export({ format: 'der', type: 'spki' })
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' })
    const file = { version: 1 as const, keyId: keyIdOf(pub), publicKey: pub.toString('base64'), privateKey: this.#vault.encrypt(priv).toString('base64') }
    writeAtomic(this.#path, JSON.stringify(file, null, 2))
    return file
  }

  /** Signs a pack hash, making the key the first time. */
  sign(hash: string): PackSignature {
    const file = this.#load()
    const key = createPrivateKey({ key: this.#vault.decrypt(Buffer.from(file.privateKey, 'base64')), format: 'der', type: 'pkcs8' })
    return {
      format: 'atelier-pack-signature',
      version: 1,
      hash,
      keyId: file.keyId,
      publicKey: file.publicKey,
      signature: sign(null, Buffer.from(hash, 'utf8'), key).toString('base64'),
    }
  }
}

export const UNSIGNED = 'unsigned'

/** Pack id to the full fingerprint of the key it was first installed with ('unsigned' for an unsigned pack). */
export class TrustedKeys {
  readonly #path: string

  constructor(dir: string) {
    this.#path = join(dir, 'trusted-keys.json')
  }

  #read(): Record<string, string> {
    const raw = readJson(this.#path)
    const parsed = z.record(z.string(), z.string()).safeParse(raw)
    return parsed.success ? parsed.data : {}
  }

  pinned(packId: string): string | null {
    return this.#read()[packId] ?? null
  }

  /**
   * Why this key may not install this pack, or null when it may. A pack pinned
   * to a key needs that key; one pinned as unsigned may move to a signature
   * (and is then pinned to it), never the other way.
   */
  refusal(packId: string, keyId: string | null): string | null {
    const pin = this.pinned(packId)
    if (!pin) return null
    if (pin === UNSIGNED) return null
    if (keyId === pin) return null
    return keyId
      ? 'This pack is signed by a different author than the one you installed it from. Remove the installed pack first if you trust this one.'
      : 'This pack is unsigned, but the one you installed was signed by its author. Remove the installed pack first if you trust this one.'
  }

  pin(packId: string, keyId: string | null): void {
    const all = this.#read()
    all[packId] = keyId ?? (all[packId] && all[packId] !== UNSIGNED ? all[packId] : UNSIGNED)
    writeAtomic(this.#path, JSON.stringify(all, null, 2))
  }

  forget(packId: string): void {
    const all = this.#read()
    delete all[packId]
    writeAtomic(this.#path, JSON.stringify(all, null, 2))
  }
}
