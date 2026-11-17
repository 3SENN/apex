/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for identity.mjs, for the tests.

export interface SigningIdentity {
  hash: string
  name: string
}
export const DEVELOPER_ID_PREFIX: string
export function parseIdentities(output: string): SigningIdentity[]
export function keychainIdentities(run?: unknown): SigningIdentity[]
export function requestedIdentity(env?: Record<string, string | undefined>): string
export function preferredIdentity(env?: Record<string, string | undefined>): string
export function resolveIdentity(requested: string, identities: SigningIdentity[], options?: { preferred?: string }): SigningIdentity
export function signingIdentity(
  env?: Record<string, string | undefined>,
  options?: { identities?: SigningIdentity[] | (() => SigningIdentity[]); preferred?: string },
): string | null
