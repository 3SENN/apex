/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The page preload's entry. Runs in every frame of a tab, in Electron's
// isolated world: it shares the page's DOM but not its JavaScript, and it
// exposes nothing to the page (the dialog overrides, the capture tracker and
// the GPC flag are the exceptions, installed with executeInMainWorld). Agent
// control stays in main and this isolated world; no page script can reach it.
// On account sign-in pages (signInHosts.ts) none of the main-world parts go
// in, so the page's own world is exactly Chromium's. The one exception is the
// window geometry stand-in, which only fills in Chromium's own window frame
// while it is missing (a 0 x 0 window is itself a tell) and then removes itself.
// (The chrome surface, stock Chrome's window.chrome, is a preload of its own
// that every page gets, sign-in pages too: preload/chromeSurface.ts.)
import { BRAND_NAME } from '@shared/branding'
import { isSignInUrl } from '@shared/signInHosts'
import { installBridge } from './page/bridge'
// Each area of the page bridge has its own file
import { installDialogs } from './page/dialogs'
import { installLinks } from './page/links'
import { installPrivacy } from './page/privacy'
import { installScroll } from './page/scroll'
import { installSelection } from './page/selection'
// Live capture tracks for the tab's icons and the sharing bar
import { installCapture } from './page/capture'
// OV-25 to OV-29: autofill runs in every frame, nested and cross-origin ones too
import { installAutofill } from './autofill'
// ── sign-in compatibility page part ── (WebAuthn calls only a passkey sheet could answer fail fast; every frame)
import { installWebAuthn } from './page/webauthn'
// ── translate page part ── (TR-07: language hints, and translation in place while asked; top frame)
import { installTranslate } from './page/translate'
// ── reader page part ── (RD-01: whether the page reads as an article, and its extraction on request; top frame)
import { installReader } from './page/reader'
// ── media page part ── (MD-01 to MD-03: the frame's media and Media Session for the now-playing control; every frame)
import { installMedia } from './page/media'
// ── tweaks page part ── (TWK-01, TWK-02: a site's tweak rules at document start, and the element picker; top frame)
import { installTweaks } from './page/tweaks'
// ── permissions pass page part ── (permissions.query and Notification.permission read 'prompt' for never asked; every frame)
import { installPermissionStatus } from './page/permissionStatus'

// With nodeIntegrationInSubFrames this preload also runs in subframes. The
// parts below stay top-frame only, as they were; autofill is the one that runs everywhere.
const isTop = window === window.top
// The whole URL: some providers' sign-in pages are paths on their main site (github.com/login).
const signIn = isSignInUrl(window.location?.href ?? '')
// Each part installs on its own: one that throws on a page must not leave the
// parts after it (autofill above all) missing there.
function safely(part: string, install: () => void): void {
  try {
    install()
  } catch (err) {
    console.error(`${BRAND_NAME} page part ${part} failed to install`, err)
  }
}

// The host window's frame while Chromium has none for the page yet comes from the session's frame
// preload (chromeSurface.ts), which popups get too.
if (isTop) safely('bridge', installBridge)
// The agent at work is drawn in the overlay host (agent-notice and agent-shield, OV-21 and OV-22), never inside the page.
if (isTop) {
  safely('links', installLinks)
  safely('selection', installSelection)
  safely('dialogs', () => installDialogs({ mainWorld: !signIn }))
  if (!signIn) safely('privacy', installPrivacy)
  // Only the top frame reports scroll; anchored surfaces follow the page itself.
  safely('scroll', installScroll)
}
// ── privacy pack page part ── (Global Privacy Control in iframes too, matching the Sec-GPC header their requests carry; privacy.ts sendsGpc)
if (!isTop && !signIn) safely('privacy', installPrivacy)
// Every frame: a same-tab iframe's camera counts too; main/capture.ts adds them up
if (!signIn) safely('capture', installCapture)
safely('autofill', installAutofill)
// ── sign-in compatibility page part ──
if (!signIn) safely('webauthn', installWebAuthn)
// ── translate page part ──
if (isTop) safely('translate', installTranslate)
// ── reader page part ──
if (isTop && !signIn) safely('reader', installReader)
// ── media page part ── (embedded players report too; none of it on sign-in pages)
if (!signIn) safely('media', () => installMedia({ mainWorld: true }))
// ── tweaks page part ── (never on sign-in pages; main answers none there either)
if (isTop && !signIn) safely('tweaks', installTweaks)
// ── permissions pass page part ── (before any page script: a site's first check already reads the right state)
if (!signIn) safely('permission status', installPermissionStatus)
