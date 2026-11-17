/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for asc.mjs, for the tests.

import type { KeyObject } from 'node:crypto'
import type { ProfileFacts } from './entitlements.mjs'

type Env = Record<string, string | undefined>
export interface FakeResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FakeResponse>

export const API: string
export class AscError extends Error {}
export function keyFrom(env: Env, exists?: (path: string) => boolean): { keyPath: string; keyId: string; issuer: string }
export function makeToken(options: { privateKey: KeyObject; keyId: string; issuer: string; now?: number }): string
export function createClient(options: { token: string; fetch?: FetchLike; base?: string }): {
  get(path: string): Promise<any>
  post(path: string, body: unknown): Promise<any>
  delete(path: string): Promise<any>
}
export function parseArgs(argv: string[]): {
  apply: boolean
  recreate: boolean
  capabilities: string[]
  bundleId: string | null
  name: string
  certificate: string | null
  profileName: string | null
  out: string | null
}
export function certificateHash(base64Der: string): string
export function pickCertificate(certs: Array<{ id: string; attributes?: Record<string, any> }>, options: { id: string | null; hash: string }): { id: string; attributes?: Record<string, any> }
export function runAsc(options?: {
  argv?: string[]
  env?: Env
  fetch?: FetchLike
  readFile?: (path: string) => Buffer | string
  exists?: (path: string) => boolean
  write?: (path: string, data: Buffer) => void
  log?: (message: string) => void
  now?: number
  decode?: ((path: string) => ProfileFacts) | null
  repo?: string
}): Promise<{ plan: string[]; applied: boolean; out: string | null; problems: string[] | null }>
