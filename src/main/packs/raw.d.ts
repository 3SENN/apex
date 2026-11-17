/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// First-party pack files bundled into main as text (Vite's ?raw import): src/firstParty/.
declare module '*.js?raw' {
  const text: string
  export default text
}
declare module '*.html?raw' {
  const text: string
  export default text
}
declare module '*.css?raw' {
  const text: string
  export default text
}
declare module '*.json?raw' {
  const text: string
  export default text
}
