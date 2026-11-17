/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Built-in skills ship as Markdown, bundled as text by Vite's ?raw import.
declare module '*.md?raw' {
  const text: string
  export default text
}
