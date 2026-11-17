/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { InputValidation } from './runtime'

// Checks an edited approval form against the tool's own input schema (CH-40)
// before the call goes out. Unknown formats and keywords are ignored rather
// than rejected: servers write loose schemas, and a stricter check than the
// server's own would block calls it accepts.

const draft7 = new Ajv({ allErrors: true, strict: false, validateFormats: false })
const draft2020 = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const cache = new WeakMap<object, ValidateFunction>()

function compile(schema: object): ValidateFunction | null {
  const hit = cache.get(schema)
  if (hit) return hit
  const id = (schema as { $schema?: unknown }).$schema
  const ajv = typeof id === 'string' && /2019|2020/.test(id) ? draft2020 : draft7
  try {
    // A schema's own $id would clash across tools that share one; compile a copy without it.
    const { $id: _id, ...rest } = schema as Record<string, unknown>
    const fn = ajv.compile(rest)
    cache.set(schema, fn)
    return fn
  } catch {
    return null
  }
}

/** ok when the input fits the schema; otherwise each error with its JSON pointer path. */
export function validateAgainst(schema: unknown, input: unknown): InputValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (typeof schema !== 'object' || schema === null) return { ok: true }
  const fn = compile(schema)
  // A schema Apex can't compile is the server's to enforce.
  if (!fn) return { ok: true }
  if (fn(input)) return { ok: true }
  return {
    ok: false,
    errors: (fn.errors ?? []).slice(0, 20).map((e) => {
      const missing = e.keyword === 'required' ? `/${String((e.params as { missingProperty?: string }).missingProperty ?? '')}` : ''
      return { path: `${e.instancePath}${missing}`, message: e.message ?? 'is not valid' }
    }),
  }
}
