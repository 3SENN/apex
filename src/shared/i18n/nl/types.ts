/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The shape every Dutch fragment satisfies: a subset of its English
// fragment's keys, with no key English lacks. Once every key is filled,
// tests/i18nParity.test.ts requires the full set (SWEEP_COMPLETE).
export type Dutch<F> = { readonly [K in keyof F]?: string }
