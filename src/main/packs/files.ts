/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pack's files on disk and in .apexpack archives (docs/packs.md › Sharing).
// The archive is a zip of the pack's files plus __apex/signature.json. The
// pack hash is SHA-256 over the sorted "path NUL sha256(file)" lines, so it
// names the content, not the zip. Reading enforces the limits before
// inflating anything, so an oversized or hostile archive costs nothing. A pack
// with an app may be larger (docs/apps.md): its manifest is read first, on its
// own and capped, to pick the limits the rest is held to.
import { BRAND_NAME } from '@shared/branding'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { Unzip, UnzipInflate, zipSync, type Zippable } from 'fflate'
import { z } from 'zod'
import {
  APP_PACK_LIMITS,
  PACK_LIMITS,
  PACK_MANIFEST_FILE,
  PACK_RESERVED_DIR,
  PACK_SHARE_FILE,
  PACK_SHARE_IMAGE_FILE,
  PACK_SHARE_IMAGE_MAX,
  PACK_SHARE_NOTE_MAX,
  PACK_SIGNATURE_FILE,
  isPackAssetPath,
  isPackFilePath,
  isPackPath,
  manifestAppRoots,
  manifestAssetRoots,
  manifestIsBig,
  packFileLimits,
  type PackFileLimits,
} from '@shared/packs'
import type { PackFiles } from './manifest'
import { isEnvFile, keyIn } from './secrets'

/** Finder and archivers leave these behind; they're never part of a pack. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX', '.git'])

export class PackFileError extends Error {}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The content hash: the same files give the same hash however they were zipped. */
export function packHash(files: PackFiles): string {
  const lines = [...files.keys()].sort().map((p) => `${p}\u0000${sha256(files.get(p) as Buffer)}\n`)
  return sha256(lines.join(''))
}

function parseManifestText(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** The limits a manifest's text picks: the larger ones when it lists an app. Unreadable text gets the smaller ones. */
export function limitsForManifestText(text: string | null): PackFileLimits {
  return packFileLimits(manifestIsBig(parseManifestText(text)))
}

/** An empty stand-in for a file read later (an installed app's own files at start-up). */
export const STUB = Buffer.alloc(0)

/**
 * Reads a pack folder into memory, refusing anything past the limits (by
 * default, the ones its manifest picks). With `stub`, the files it names get
 * an empty stand-in and their sizes go into `sizes`, so start-up never reads
 * a game's assets; verifyOnDisk checks them later.
 */
export function readPackFolder(root: string, limits: PackFileLimits = limitsForFolder(root), options: { stub?(path: string): boolean; sizes?: Map<string, number> } = {}): PackFiles {
  const files: PackFiles = new Map()
  let total = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      // A .env (a developer's keys) and .npmrc (a registry token) never become part of a pack.
      if (IGNORED.has(name) || isEnvFile(name) || name === '.npmrc') continue
      const full = join(dir, name)
      const rel = relative(root, full).split(sep).join('/')
      if (rel === PACK_RESERVED_DIR) continue
      // lstat, so a link (to a file outside the pack, say) is skipped, never followed.
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile()) continue
      if (files.size >= limits.files) throw new PackFileError(`A pack holds at most ${limits.files} files.`)
      if (st.size > limits.fileBytes) throw new PackFileError(`${rel} is larger than ${limits.fileBytes / 1024 / 1024} MB.`)
      total += st.size
      if (total > limits.packBytes) throw new PackFileError(`A pack is at most ${limits.packBytes / 1024 / 1024} MB.`)
      if (options.stub?.(rel)) {
        files.set(rel, STUB)
        options.sizes?.set(rel, st.size)
        continue
      }
      files.set(rel, readFileSync(full))
    }
  }
  if (!existsSync(root)) throw new PackFileError('The pack folder is missing.')
  walk(root)
  return files
}

/** A folder's manifest as parsed JSON, or null (missing, too big or not JSON). */
export function folderManifest(root: string): unknown {
  const manifest = join(root, PACK_MANIFEST_FILE)
  try {
    const st = lstatSync(manifest)
    if (!st.isFile() || st.size > PACK_LIMITS.manifestBytes) return null
    return parseManifestText(readFileSync(manifest, 'utf8'))
  } catch {
    return null
  }
}

/** The SHA-256 of a file on disk, streamed. */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/**
 * The pack hash of a folder as packHash would give it: `inMemory` files from
 * their bytes, `onDisk` files streamed from `root`. A file that can't be read
 * makes the hash differ, as a changed one would.
 */
export async function packHashOnDisk(root: string, inMemory: PackFiles, onDisk: Iterable<string>): Promise<string> {
  const hashes = new Map<string, string>()
  for (const [p, data] of inMemory) hashes.set(p, sha256(data))
  for (const p of onDisk) {
    try {
      hashes.set(p, await hashFile(join(root, ...p.split('/'))))
    } catch {
      hashes.set(p, 'unreadable')
    }
  }
  return sha256([...hashes.keys()].sort().map((p) => `${p}\u0000${hashes.get(p)}\n`).join(''))
}

function limitsForFolder(root: string): PackFileLimits {
  const manifest = join(root, PACK_MANIFEST_FILE)
  try {
    const st = lstatSync(manifest)
    if (!st.isFile() || st.size > PACK_LIMITS.manifestBytes) return packFileLimits(false)
    return limitsForManifestText(readFileSync(manifest, 'utf8'))
  } catch {
    return packFileLimits(false)
  }
}

/** Writes a pack's files into a fresh folder, swapped in whole so a reader never sees half a pack. */
export function writePackFolder(target: string, files: PackFiles): void {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  for (const [p, data] of files) {
    // validatePack has checked which folder may hold asset names; this only keeps every path inside the pack.
    if (!isPackPath(p) && !isPackAssetPath(p)) throw new PackFileError(`${p} is not an allowed file path.`)
    const full = join(temp, ...p.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, data)
  }
  const old = `${target}.${process.pid}.old`
  rmSync(old, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, old)
  renameSync(temp, target)
  rmSync(old, { recursive: true, force: true })
}

// ---- signatures ----

export const signatureSchema = z
  .object({
    format: z.literal('apex-pack-signature'),
    version: z.literal(1),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    /** The author's Ed25519 public key, SPKI DER in base64. */
    publicKey: z.string().min(40).max(200),
    signature: z.string().min(40).max(200),
  })
  .strict()

export type PackSignature = z.infer<typeof signatureSchema>

/** What Share… put beside an archive's files: a note and a PNG share image. Neither is part of the hash or the signature. */
export interface PackShared {
  note: string | null
  image: Buffer | null
}

const shareSchema = z.object({ format: z.literal('apex-pack-share'), version: z.literal(1), note: z.string().max(PACK_SHARE_NOTE_MAX).nullable() }).strict()
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Whether bytes start like a PNG: the only image Share… carries. */
export function isPng(data: Buffer): boolean {
  return data.length > PNG_MAGIC.length && data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
}

// ---- archives ----

/** Zips a pack, with its signature when there is one, and what Share… adds. */
export function encodeArchive(files: PackFiles, signature: PackSignature | null, shared: PackShared | null = null): Buffer {
  const entries: Zippable = {}
  for (const p of [...files.keys()].sort()) entries[p] = [new Uint8Array(files.get(p) as Buffer), { level: 6 }]
  if (signature) entries[PACK_SIGNATURE_FILE] = [new TextEncoder().encode(JSON.stringify(signature, null, 2)), { level: 6 }]
  const note = shared?.note?.trim().slice(0, PACK_SHARE_NOTE_MAX) || null
  if (note) entries[PACK_SHARE_FILE] = [new TextEncoder().encode(JSON.stringify({ format: 'apex-pack-share', version: 1, note }, null, 2)), { level: 6 }]
  if (shared?.image && isPng(shared.image) && shared.image.length <= PACK_SHARE_IMAGE_MAX) entries[PACK_SHARE_IMAGE_FILE] = [new Uint8Array(shared.image), { level: 0 }]
  return Buffer.from(zipSync(entries))
}

/** Feeds an archive to an unzipper a slice at a time, until it ends or `stop()` says so. */
function pushArchive(unzip: Unzip, archive: Buffer, stop: () => boolean): void {
  const bytes = new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)
  const SLICE = 64 * 1024
  for (let at = 0; at < bytes.length && !stop(); at += SLICE) unzip.push(bytes.subarray(at, at + SLICE), at + SLICE >= bytes.length)
}

/**
 * The manifest's text inside an archive, or null. Only that one entry is
 * inflated, and never past the manifest limit, whatever the archive claims.
 */
export function peekArchiveManifest(archive: Buffer): string | null {
  let text: string | null = null
  let done = false
  const unzip = new Unzip((file) => {
    if (done || file.name !== PACK_MANIFEST_FILE) return
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (err, chunk, final) => {
      if (done) return
      if (err) {
        done = true
        return
      }
      size += chunk.length
      if (size > PACK_LIMITS.manifestBytes) {
        done = true
        file.terminate()
        return
      }
      chunks.push(chunk)
      if (!final) return
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
      done = true
    }
    try {
      file.start()
    } catch {
      done = true
    }
  })
  unzip.register(UnzipInflate)
  try {
    pushArchive(unzip, archive, () => done)
  } catch {
    return null
  }
  return text
}

/** Unzips an .apexpack or .apexapp: its files, the signature it carries (null when unsigned or unreadable) and what Share… added. */
export function decodeArchive(archive: Buffer, limits?: PackFileLimits): { files: PackFiles; signature: PackSignature | null; shared: PackShared } {
  if (archive.length > APP_PACK_LIMITS.packBytes + 1024 * 1024) throw new PackFileError('This pack file is too large.')
  const peeked = parseManifestText(peekArchiveManifest(archive))
  limits ??= packFileLimits(manifestIsBig(peeked))
  const appRoots = [...manifestAppRoots(peeked), ...manifestAssetRoots(peeked)]
  if (archive.length > limits.packBytes + 1024 * 1024) throw new PackFileError('This pack file is too large.')
  const damaged = `This file isn't a pack for ${BRAND_NAME}, or it is damaged.`
  const files: PackFiles = new Map()
  let signature: PackSignature | null = null
  const shared: PackShared = { note: null, image: null }
  let count = 0
  let total = 0
  let refused: string | null = null
  // Streamed, and fed a slice at a time, so the bytes counted are the ones
  // inflated, not the sizes the archive claims: a zip bomb stops at the limit.
  const unzip = new Unzip((file) => {
    if (refused || file.name.endsWith('/')) return
    const isSignature = file.name === PACK_SIGNATURE_FILE
    const extra = file.name === PACK_SHARE_FILE ? 'note' : file.name === PACK_SHARE_IMAGE_FILE ? 'image' : null
    if (!isSignature && !extra && !isPackFilePath(file.name, appRoots)) {
      if (!file.name.split('/').some((seg) => IGNORED.has(seg))) refused = `${file.name} is not an allowed file path.`
      return
    }
    if (++count > limits.files + 1) {
      refused = `A pack holds at most ${limits.files} files.`
      return
    }
    const cap = isSignature ? 16 * 1024 : extra === 'note' ? 8 * 1024 : extra === 'image' ? PACK_SHARE_IMAGE_MAX : limits.fileBytes
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (err, chunk, final) => {
      if (refused) return
      if (err) {
        refused = damaged
        return
      }
      size += chunk.length
      total += chunk.length
      if (size > cap) refused = `${file.name} is larger than ${cap / 1024 / 1024} MB.`
      else if (total > limits.packBytes) refused = `A pack is at most ${limits.packBytes / 1024 / 1024} MB.`
      if (refused) {
        file.terminate()
        return
      }
      chunks.push(chunk)
      if (!final) return
      const data = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      if (extra === 'image') {
        // Shown on the review card as an image: a PNG or nothing.
        shared.image = isPng(data) ? data : null
        return
      }
      if (extra === 'note') {
        try {
          const parsed = shareSchema.safeParse(JSON.parse(data.toString('utf8')))
          shared.note = parsed.success ? parsed.data.note?.trim() || null : null
        } catch {
          shared.note = null
        }
        return
      }
      if (!isSignature) {
        files.set(file.name, data)
        return
      }
      try {
        const parsed = signatureSchema.safeParse(JSON.parse(data.toString('utf8')))
        signature = parsed.success ? parsed.data : null
      } catch {
        signature = null
      }
    }
    try {
      file.start()
    } catch {
      refused = damaged
    }
  })
  unzip.register(UnzipInflate)
  try {
    pushArchive(unzip, archive, () => refused !== null)
  } catch {
    refused ??= damaged
  }
  if (refused) throw new PackFileError(refused)
  if (files.size === 0) throw new PackFileError(damaged)
  return { files, signature, shared }
}

// ---- secrets ----

/** Files that are text, and so could hold a key; images, sound, fonts and WebAssembly can't be read that way. */
const TEXT_FILE = /\.(m?js|cjs|jsx|tsx?|json|map|html?|css|svg|txt|md|xml|ya?ml|toml|ini|cfg|conf|csv|properties)$/i
const hasExtension = (path: string): boolean => (path.split('/').pop() ?? '').includes('.')

/** Files that look like they hold a key, checked before a pack leaves this computer (docs/apps.md › Keys). */
export function findSecrets(files: PackFiles): Array<{ path: string; what: string }> {
  let raw: unknown = null
  try {
    raw = JSON.parse((files.get(PACK_MANIFEST_FILE) ?? Buffer.from('null')).toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    // An unreadable manifest has no bundled apps.
  }
  const built = manifestAppRoots(raw, 'bundled')
  const found: Array<{ path: string; what: string }> = []
  for (const [p, data] of files) {
    if (isEnvFile(p)) {
      found.push({ path: p, what: 'a .env file' })
      continue
    }
    if (data.length > APP_PACK_LIMITS.fileBytes || (hasExtension(p) && !TEXT_FILE.test(p))) continue
    const what = keyIn(data.toString('utf8'), !built.some((r) => p.startsWith(`${r}/`)))
    if (what) found.push({ path: p, what })
  }
  return found
}
