/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import type { PackAuth, PackAuthState } from '@shared/packs'
import { OAuthError, needsRefresh, refresh, signInToIssuer, type FetchFn } from '../connectors/oauth'
import type { OAuthSecret } from '../connectors/store'
import type { PackAppConfig } from './policy'
import type { PackSecrets } from './secrets'

// Sign-ins an app runs through Atelier (docs/apps.md › Apps for organisations):
// OAuth 2 or OpenID Connect with PKCE against the issuer the manifest (or the
// organisation's AppConfig) names, in a tab of the person's profile, with the
// loopback redirect the connectors use. The tokens stay in main, encrypted
// with the system keychain beside the packs' keys; the app's requests to the
// sign-in's hosts carry the access token, and its code never sees one.

/** What Atelier keeps for one sign-in: who it is for (issuer and client), the tokens, and who signed in. */
interface StoredSignIn {
  issuer: string
  clientId: string
  secret: OAuthSecret
  user: string | null
}

/** Where private indexes' sign-ins are kept, beside the packs' (no pack id has an @). */
export const INDEX_SIGNINS = '@indexes'

/** A private index's sign-in, from the organisation's policy: its token goes to the index's own host. */
export function indexAuth(url: string, a: { name: string | null; issuer: string; clientId: string; scopes: string[] }): EffectiveAuth {
  const host = new URL(url).hostname
  return { id: createHash('sha256').update(url).digest('hex').slice(0, 16), name: a.name ?? host, issuer: a.issuer, clientId: a.clientId, scopes: a.scopes, hosts: [host], managed: true }
}

/** A pack's sign-in as it applies here: the manifest's, with the organisation's issuer, client and scopes when AppConfig sets them. */
export type EffectiveAuth = PackAuth & { managed: boolean }

export function effectiveAuth(auth: readonly PackAuth[] | undefined, config: PackAppConfig['auth'] | undefined): EffectiveAuth[] {
  return (auth ?? []).map((a) => {
    const set = config?.[a.id]
    if (!set) return { ...a, managed: false }
    return { ...a, issuer: set.issuer ?? a.issuer, clientId: set.clientId ?? a.clientId, scopes: set.scopes ?? a.scopes, managed: true }
  })
}

/**
 * Who signed in, from an ID token's email, username or name. The token is
 * read without checking its signature: it came straight from the token
 * endpoint over TLS (OpenID Connect Core 3.1.3.7), and Atelier only shows it.
 */
export function userOf(idToken: string | null): string | null {
  const part = idToken?.split('.')[1]
  if (!part) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null) return null
    const c = claims as Record<string, unknown>
    const pick = [c.email, c.preferred_username, c.name].find((v): v is string => typeof v === 'string' && v.trim() !== '')
    return pick ? pick.trim().slice(0, 120) : null
  } catch {
    return null
  }
}

/** A refresh that failed only because the provider couldn't be reached keeps the sign-in for the next try. */
const unreachable = (err: unknown): boolean => err instanceof OAuthError && err.code === 'token' && err.detail === 'unreachable'

export class PackSignIns {
  readonly #file: PackSecrets
  readonly #fetch: FetchFn
  /** Sign-ins running now and refreshes in flight, by pack and sign-in, so a second ask joins the first. */
  readonly #signingIn = new Map<string, Promise<PackAuthState>>()
  readonly #refreshing = new Map<string, Promise<StoredSignIn | null>>()

  constructor(file: PackSecrets, fetchFn: FetchFn) {
    this.#file = file
    this.#fetch = fetchFn
  }

  /** The stored sign-in when it is for this issuer and client (a sign-in to another tenant counts for nothing). */
  #read(packId: string, auth: EffectiveAuth): StoredSignIn | null {
    const raw = this.#file.get(packId, auth.id)
    if (!raw) return null
    try {
      const s = JSON.parse(raw) as StoredSignIn
      return s.issuer === auth.issuer && s.clientId === auth.clientId && typeof s.secret?.accessToken === 'string' ? s : null
    } catch {
      return null
    }
  }

  #write(packId: string, id: string, s: StoredSignIn): void {
    this.#file.set(packId, id, JSON.stringify(s))
  }

  /** Signed in while there is a token that works now or can be refreshed. */
  state(packId: string, auth: EffectiveAuth): PackAuthState {
    const s = this.#read(packId, auth)
    const live = s !== null && (s.secret.refreshToken !== null || s.secret.expiresAt === null || s.secret.expiresAt > Date.now())
    return { signedIn: live, user: live ? s.user : null }
  }

  /** The access token to send now, or null; close to expiry, a refresh starts and the next request has the new one. */
  token(packId: string, auth: EffectiveAuth): string | null {
    const s = this.#read(packId, auth)
    if (!s) return null
    if (needsRefresh(s.secret) && s.secret.refreshToken) void this.#refresh(packId, auth, s)
    return s.secret.expiresAt === null || s.secret.expiresAt > Date.now() ? s.secret.accessToken : null
  }

  /** The state after refreshing a token that is due (atelier.auth.status, so an app that starts after a while sends a working token). */
  async fresh(packId: string, auth: EffectiveAuth): Promise<PackAuthState> {
    const s = this.#read(packId, auth)
    if (s && needsRefresh(s.secret) && s.secret.refreshToken) await this.#refresh(packId, auth, s)
    return this.state(packId, auth)
  }

  #refresh(packId: string, auth: EffectiveAuth, s: StoredSignIn): Promise<StoredSignIn | null> {
    const key = `${packId}\u0000${auth.id}`
    const running = this.#refreshing.get(key)
    if (running) return running
    const run = refresh(s.secret, this.#fetch)
      .then((secret) => {
        const next = { ...s, secret }
        this.#write(packId, auth.id, next)
        return next
      })
      .catch((err: unknown) => {
        // Refused (revoked, expired, signed out at the provider): the person signs in again.
        if (!unreachable(err)) this.#file.clear(packId, auth.id)
        return null
      })
      .finally(() => this.#refreshing.delete(key))
    this.#refreshing.set(key, run)
    return run
  }

  /** Runs the sign-in in a tab `open` shows; a second ask while one runs joins it. */
  signIn(packId: string, auth: EffectiveAuth, open: (url: string) => () => void, signal?: AbortSignal): Promise<PackAuthState> {
    const key = `${packId}\u0000${auth.id}`
    const running = this.#signingIn.get(key)
    if (running) return running
    const run = signInToIssuer({ issuer: auth.issuer, clientId: auth.clientId, scopes: auth.scopes ?? [], fetchFn: this.#fetch, open, signal })
      .then(({ secret, idToken }) => {
        const user = userOf(idToken)
        this.#write(packId, auth.id, { issuer: auth.issuer, clientId: auth.clientId, secret, user })
        return { signedIn: true, user }
      })
      .finally(() => this.#signingIn.delete(key))
    this.#signingIn.set(key, run)
    return run
  }

  signingIn(packId: string, authId: string): boolean {
    return this.#signingIn.has(`${packId}\u0000${authId}`)
  }

  signOut(packId: string, authId: string): void {
    this.#file.clear(packId, authId)
  }
}
