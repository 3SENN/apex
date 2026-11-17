/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Text files bundled into main at build time (Vite's ?raw import), such as
// the dangerous-host list.
declare module '*.txt?raw' {
  const text: string
  export default text
}
