/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CsvMapping } from '@shared/passwords'
import { mainT } from '../i18n/mainT'
import { CSV_MAX_BYTES } from './csvImport'
import type { VaultCipher } from './vault'

// The private temp copies a password import works on (ST-41). A picked CSV
// is copied, encrypted, into the profile's data folder and read back from
// there, so the preview, remap and confirm never touch the user's file
// again. Copies are deleted after confirm, cancel or quit, and the whole
// folder is cleared at start-up in case Apex crashed mid-import.

export const IMPORT_DIR = join('passwords', 'import-tmp')

interface ImportSession {
  temp: string | null
  /** The user's own file, kept so it can be moved to the Trash afterwards (ON-04). */
  source: string
  fileName: string
  mapping: CsvMapping | null
}

export class ImportFiles {
  readonly #dir: string
  readonly #cipher: VaultCipher
  readonly #sessions = new Map<string, ImportSession>()

  constructor(dataDir: string, cipher: VaultCipher) {
    this.#dir = join(dataDir, IMPORT_DIR)
    this.#cipher = cipher
  }

  /** Removes copies a crash left behind. */
  cleanup(): void {
    rmSync(this.#dir, { recursive: true, force: true })
  }

  /** Copies the file and returns its token. Throws a readable error for a missing, huge or binary file. */
  open(source: string): { token: string; fileName: string; text: string } {
    let size: number
    try {
      size = statSync(source).size
    } catch {
      throw new Error(mainT('passwords.err.fileOpen'))
    }
    if (size > CSV_MAX_BYTES) throw new Error(mainT('passwords.err.fileLarge'))
    if (!this.#cipher.available()) throw new Error(mainT('passwords.err.importNoKeychain'))
    const text = readFileSync(source, 'utf8')
    if (text.includes('\u0000')) throw new Error(mainT('passwords.err.fileBinary'))
    const token = randomUUID()
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    const temp = join(this.#dir, `${token}.bin`)
    writeFileSync(temp, this.#cipher.encrypt(text), { mode: 0o600 })
    this.#sessions.set(token, { temp, source, fileName: basename(source), mapping: null })
    return { token, fileName: basename(source), text }
  }

  /** The copy's text; throws once the import is finished or cancelled. */
  read(token: string): { text: string; fileName: string; mapping: CsvMapping | null } {
    const session = this.#sessions.get(token)
    if (!session?.temp) throw new Error(mainT('passwords.import.error.ended'))
    return { text: this.#cipher.decrypt(readFileSync(session.temp)), fileName: session.fileName, mapping: session.mapping }
  }

  setMapping(token: string, mapping: CsvMapping): void {
    const session = this.#sessions.get(token)
    if (session) session.mapping = mapping
  }

  /** Deletes the copy; the source path stays known so trash() still works. */
  finish(token: string): void {
    const session = this.#sessions.get(token)
    if (!session?.temp) return
    rmSync(session.temp, { force: true })
    session.temp = null
  }

  /** Deletes the copy and forgets the import. */
  cancel(token: string): void {
    this.finish(token)
    this.#sessions.delete(token)
  }

  /** The user's original file, for "Move to Trash". */
  source(token: string): string | null {
    return this.#sessions.get(token)?.source ?? null
  }

  forget(token: string): void {
    this.#sessions.delete(token)
  }

  /** Whether any copy is still on disk (tests and smoke). */
  pending(): number {
    return [...this.#sessions.values()].filter((s) => s.temp !== null).length
  }

  /** On quit: every copy goes. */
  dispose(): void {
    for (const token of [...this.#sessions.keys()]) this.cancel(token)
    this.cleanup()
  }
}
