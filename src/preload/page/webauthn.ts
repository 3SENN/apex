/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge } from 'electron'
import { SYSTEM_PASSKEYS_ARG, cappedTimeout, honestCapabilities, webAuthnDecision, type WebAuthnCall, type WebAuthnDecision } from '@shared/webauthnPolicy'

// WebAuthn that settles (sign-in compatibility, shared/webauthnPolicy.ts).
// Electron has no passkey sheet, so a call only that sheet could answer
// would wait out the site's timeout. In the page's own world this wraps
// navigator.credentials.create/get and two PublicKeyCredential statics:
// calls the table refuses reject at once with NotAllowedError, conditional
// (autofill) calls wait for the page to abort them, and the rest go to
// Chromium unchanged except for a capped timeout. Every frame gets it, except
// on the account sign-in pages (signInHosts.ts), whose world stays Chromium's.

interface Bridge {
  /** The system passkey sheet serves this frame (main passes SYSTEM_PASSKEYS_ARG; never a cross-origin frame). */
  sheet: boolean
  decide(call: WebAuthnCall): WebAuthnDecision
  capabilities(caps: Record<string, boolean>, platform: boolean): Record<string, boolean>
  timeout(timeout: unknown): number
}

/** Runs in the page's world; `bridge` is the only thing it reaches back to. */
function override(bridge: Bridge): void {
  const Container = (globalThis as { CredentialsContainer?: { new (): CredentialsContainer; prototype: CredentialsContainer } }).CredentialsContainer
  const PKC = (globalThis as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential
  if (typeof Container !== 'function' || typeof PKC !== 'function') return
  const proto = Container.prototype
  const nativeCreate = proto.create
  const nativeGet = proto.get
  const nativeAvailable = PKC.isUserVerifyingPlatformAuthenticatorAvailable
  const nativeCaps = (PKC as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities
  // Asked once, up front, so the first call doesn't wait on it.
  const platform: Promise<boolean> = Promise.resolve()
    .then(() => nativeAvailable.call(PKC))
    .then(Boolean, () => false)
  const notAllowed = (): DOMException =>
    new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', 'NotAllowedError')
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x)) : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

  type Options = (CredentialCreationOptions | CredentialRequestOptions) & { mediation?: unknown; signal?: AbortSignal }
  const wrap = (kind: 'create' | 'get', native: (this: CredentialsContainer, options?: Options) => Promise<Credential | null>) =>
    ({
      [kind](this: CredentialsContainer, options?: Options): Promise<Credential | null> {
        const pk = (options as { publicKey?: Record<string, unknown> } | undefined)?.publicKey
        if (!options || !pk || typeof pk !== 'object') return native.call(this, options)
        const self = this
        return platform.then((hasPlatform) => {
          const signal = options.signal
          if (signal?.aborted) throw signal.reason ?? new DOMException('signal is aborted without reason', 'AbortError')
          const selection = (pk.authenticatorSelection ?? {}) as Record<string, unknown>
          const allowed = Array.isArray(pk.allowCredentials) ? (pk.allowCredentials as { transports?: unknown }[]) : []
          const call: WebAuthnCall = {
            kind,
            platform: hasPlatform,
            sheet: bridge.sheet,
            mediation: str(options.mediation),
            attachment: str(selection.authenticatorAttachment),
            residentKey: str(selection.residentKey),
            requireResidentKey: selection.requireResidentKey === true,
            userVerification: str(kind === 'create' ? selection.userVerification : pk.userVerification),
            hints: strings(pk.hints),
            allow: kind === 'get' ? (allowed.length > 0 ? allowed.map((c) => strings(c?.transports) ?? []) : null) : undefined,
          }
          const decision = bridge.decide(call)
          if (decision === 'reject') throw notAllowed()
          if (decision === 'hold')
            return new Promise<Credential | null>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('signal is aborted without reason', 'AbortError')), { once: true })
            })
          const timeout = bridge.timeout(pk.timeout)
          return native.call(self, timeout === pk.timeout ? options : ({ ...options, publicKey: { ...pk, timeout } } as Options))
        })
      },
    })[kind]!

  const define = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true })
  }
  define(proto, 'create', wrap('create', nativeCreate as never))
  define(proto, 'get', wrap('get', nativeGet as never))
  define(PKC, 'isConditionalMediationAvailable', {
    isConditionalMediationAvailable(): Promise<boolean> {
      return Promise.resolve(false)
    },
  }.isConditionalMediationAvailable)
  if (typeof nativeCaps === 'function')
    define(PKC, 'getClientCapabilities', {
      getClientCapabilities(): Promise<Record<string, boolean>> {
        return Promise.all([nativeCaps.call(PKC), platform]).then(([caps, hasPlatform]) => bridge.capabilities({ ...caps }, hasPlatform))
      },
    }.getClientCapabilities)
}

/** Apple's sheet can't serve cross-origin iframes (Electron leaves those to Touch ID), so only the top frame and same-origin frames get it. */
function servedBySheet(): boolean {
  if (!process.argv.includes(SYSTEM_PASSKEYS_ARG)) return false
  try {
    return window === window.top || window.top?.location.origin === window.location.origin
  } catch {
    return false
  }
}

export function installWebAuthn(): void {
  const bridge: Bridge = { sheet: servedBySheet(), decide: webAuthnDecision, capabilities: honestCapabilities, timeout: cappedTimeout }
  try {
    contextBridge.executeInMainWorld({ func: override, args: [bridge] })
  } catch {
    // A world that can't be reached keeps Chromium's WebAuthn as it is.
  }
}
