/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Your own servers, keys and settings (docs/apps.md › Your own servers).
//
// A pack's code is public: everyone who installs it has every file. So a key
// never goes in a pack. Two things take its place:
//   - secrets: a key the person enters (their API key, their account's
//     token). Apex keeps it here, encrypted with the system keychain, and adds
//     it to requests to the hosts the manifest names; the pack's code never
//     reads it, and a request anywhere else never carries it.
//   - env: public values (a server's address, a feature switch) the pack's
//     pages read as apex.env.
// While you develop, a linked folder's .env and .env.local fill both, for the
// names the manifest declares and no others: the same folder may hold your
// server's own .env. Neither file is ever read into a pack (files.ts).
import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PACK_SECRET_LIMITS, packDirectAllowed, type PackSecret } from '@shared/packs'
import { writeAtomic } from '../workspace/fsutil'

export interface SecretCipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export class SecretsUnavailable extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The keys people entered for their packs: one file, encrypted whole, read only in main. */
export class PackSecrets {
  readonly #path: string
  readonly #cipher: SecretCipher
  #cache: Record<string, Record<string, string>> | null = null

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path
    this.#cipher = cipher
  }

  #all(): Record<string, Record<string, string>> {
    if (this.#cache) return this.#cache
    const out: Record<string, Record<string, string>> = {}
    try {
      if (existsSync(this.#path) && this.#cipher.available()) {
        const parsed: unknown = JSON.parse(this.#cipher.decrypt(readFileSync(this.#path)))
        if (isObject(parsed)) {
          for (const [pack, values] of Object.entries(parsed)) {
            if (!isObject(values)) continue
            out[pack] = Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => typeof e[1] === 'string'))
          }
        }
      }
    } catch {
      // A file the keychain can't open (another computer's, a damaged one) holds nothing usable.
    }
    this.#cache = out
    return out
  }

  #write(all: Record<string, Record<string, string>>): void {
    if (!this.#cipher.available()) throw new SecretsUnavailable(`This computer has no keychain ${BRAND_NAME} can keep keys in.`)
    const kept = Object.fromEntries(Object.entries(all).filter(([, v]) => Object.keys(v).length > 0))
    if (Object.keys(kept).length === 0) rmSync(this.#path, { force: true })
    else writeAtomic(this.#path, this.#cipher.encrypt(JSON.stringify(kept)))
    this.#cache = kept
  }

  get(packId: string, id: string): string | null {
    return this.#all()[packId]?.[id] ?? null
  }

  set(packId: string, id: string, value: string): void {
    if (!this.#cipher.available()) throw new SecretsUnavailable(`This computer has no keychain ${BRAND_NAME} can keep keys in.`)
    const all = { ...this.#all() }
    all[packId] = { ...(all[packId] ?? {}), [id]: value }
    this.#write(all)
  }

  clear(packId: string, id: string): void {
    const all = { ...this.#all() }
    if (!all[packId] || !(id in all[packId])) return
    const { [id]: _gone, ...rest } = all[packId]
    all[packId] = rest
    this.#write(all)
  }

  /** A removed pack's keys go with it. */
  forget(packId: string): void {
    const all = { ...this.#all() }
    if (!all[packId]) return
    delete all[packId]
    try {
      this.#write(all)
    } catch {
      // Without a keychain nothing was kept in the first place.
    }
  }

  /** Drops what was read, so the next read comes from disk (after a reset). */
  reload(): void {
    this.#cache = null
  }
}

/** A .env file's values, as dotenv reads them: KEY=value, # comments, `export`, quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2] ?? ''
    const quote = value[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = value.lastIndexOf(quote)
      value = end > 0 ? value.slice(1, end) : value.slice(1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"')
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[m[1] as string] = value
  }
  return out
}

/** The env files a linked folder may have, later ones winning. */
export const DEV_ENV_FILES = ['.env', '.env.local'] as const
const DEV_ENV_MAX_BYTES = 64 * 1024

/** Linked folders' .env values, read once and kept until the folder changes. */
export class DevEnv {
  readonly #cache = new Map<string, Record<string, string>>()

  values(folder: string): Record<string, string> {
    const cached = this.#cache.get(folder)
    if (cached) return cached
    const out: Record<string, string> = {}
    for (const name of DEV_ENV_FILES) {
      const file = join(folder, name)
      try {
        const st = statSync(file)
        if (st.isFile() && st.size <= DEV_ENV_MAX_BYTES) Object.assign(out, parseDotEnv(readFileSync(file, 'utf8')))
      } catch {
        // No such file.
      }
    }
    this.#cache.set(folder, out)
    return out
  }

  clear(): void {
    this.#cache.clear()
  }
}

/** A pack's public env: the manifest's values, and in developer mode its folder's .env for those names. */
export function packEnv(declared: Record<string, string> | undefined, dev: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = { ...(declared ?? {}) }
  if (dev) for (const name of Object.keys(out)) if (typeof dev[name] === 'string') out[name] = (dev[name] as string).slice(0, PACK_SECRET_LIMITS.envValueChars)
  return out
}

/**
 * A request's headers with the pack's keys in place: each secret that has a
 * value goes in its header on requests to its hosts, replacing whatever the
 * page put there, and comes out of requests anywhere else, so a redirect
 * never carries a key on. Null when nothing changes.
 */
export function withSecretHeaders(secrets: readonly PackSecret[] | undefined, valueOf: (id: string) => string | null, url: string, headers: Record<string, string>): Record<string, string> | null {
  if (!secrets || secrets.length === 0) return null
  let out: Record<string, string> | null = null
  const edit = (): Record<string, string> => (out ??= { ...headers })
  const named = (h: Record<string, string>, name: string): string[] => Object.keys(h).filter((k) => k.toLowerCase() === name.toLowerCase())
  for (const s of secrets) {
    const value = valueOf(s.id)
    if (!value) continue
    if (packDirectAllowed(s.hosts, url)) {
      const h = edit()
      for (const k of named(h, s.header)) delete h[k]
      h[s.header] = `${s.prefix ?? ''}${value}`
    } else {
      for (const k of named(out ?? headers, s.header)) if ((out ?? headers)[k]?.includes(value)) delete edit()[k]
    }
  }
  return out
}

// ---- keys that must not leave this computer in a pack ----

/** Formats that are only ever real keys; browser keys meant to be public (Firebase's apiKey, Maps, a Supabase anon key, Stripe's pk_) are left alone. */
const KEY_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/, what: 'an Anthropic API key' },
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, what: 'an OpenAI API key' },
  { re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\s|\\n|\\r)*[A-Za-z0-9+/=]{64,}/, what: 'a private key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, what: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/, what: 'a GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/, what: 'a Stripe secret key' },
  { re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, what: 'a SendGrid key' },
  { re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/, what: 'a Google OAuth client secret' },
]

/** `password: "…"` and the like in code a person wrote (not a build's output, where libraries are full of such names). */
const ASSIGNED = /["']?(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi
const PLACEHOLDER = /^(your|my|xxx|<|\{|\$\{|example|placeholder|changeme|replace|test|dummy|sample)/i

/** Keys made to be public: a Google browser key (Firebase's apiKey, Maps), Stripe's publishable key, a JWT such as Supabase's anon key (a service key is caught on its own). */
const PUBLIC_KEY = /^(AIza|pk_(live|test)_|eyJ)/

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g

/** A JWT that carries Supabase's service role: full access to the project's database. */
function serviceRoleJwt(text: string): boolean {
  for (const m of text.matchAll(JWT)) {
    try {
      const payload = JSON.parse(Buffer.from((m[1] as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { role?: unknown }
      if (payload.role === 'service_role') return true
    } catch {
      // Not a JWT after all.
    }
  }
  return false
}

/** What kind of key a text holds, or null. `written` adds the check for keys assigned in hand-written code. */
export function keyIn(text: string, written: boolean): string | null {
  const hit = KEY_PATTERNS.find((k) => k.re.test(text))
  if (hit) return hit.what
  if (text.includes('eyJ') && serviceRoleJwt(text)) return 'a Supabase service key'
  if (written) {
    for (const m of text.matchAll(ASSIGNED)) {
      const value = m[2] as string
      if (!PLACEHOLDER.test(value) && !PUBLIC_KEY.test(value) && !/^(.)\1+$/.test(value)) return 'what looks like a password or key'
    }
  }
  return null
}

/** A .env file of any flavour: .env, .env.local, .env.production. */
export const isEnvFile = (path: string): boolean => /(^|\/)\.env(\.[^/]*)?$/i.test(path)
