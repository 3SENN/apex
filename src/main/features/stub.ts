/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A service contract's method that this build doesn't provide throws this;
// the menus read it as "not available" rather than as a failure.
export const NOT_AVAILABLE_YET = 'Not available yet'

export function notAvailable(): never {
  throw new Error(NOT_AVAILABLE_YET)
}

/** Builds an object whose every listed method throws 'Not available yet'. */
export function stubs<T>(names: readonly (keyof T & string)[]): T {
  return Object.fromEntries(names.map((name) => [name, notAvailable])) as T
}
