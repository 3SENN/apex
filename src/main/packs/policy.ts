/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Organisation policies for packs and apps (docs/apps.md › Apps for
// organisations), read the way Chrome reads its enterprise policies: Group
// Policy on Windows (HKLM, then HKCU, under SOFTWARE\Policies\Atelier), a
// configuration profile on macOS (com.atelier.browser), /etc/atelier/policies.json
// on Linux. Nothing is read in the way of start-up: the read runs in the
// background and a policy applies the moment it is found. Without a policy,
// Atelier behaves exactly as it does for everyone: every rule here is a no-op.
//
// What a policy can say:
//   PackIndexes              the indexes Browse shows; no others can be added (an entry may carry a sign-in: a private index)
//   PackForceInstall         packs installed and on, which can't be removed or turned off
//   PackAllowlist            only these (pack ids, or key:<key id> for an author key); "*" allows all
//   PackBlocklist            never these (pack ids, key:<key id>, or "*" for everything not allowed)
//   PackTrustedKeys          author keys the organisation signs with: their packs are allowed
//   PackPermissionCeiling    what no pack may ask for (hosts it may reach, the model, files, keys…)
//   PackSideloading          false: no installs from files, links or folders, only from indexes
//   AppConfig                per pack: env values, secrets and sign-ins (issuer, client, scopes) the organisation sets
//   PackAuditLog             each pack's log records what it used and where it connected, and can't be cleared
//   AiProvider               the organisation's own model gateway (Anthropic-compatible) that atelier.ai uses instead of the person's account
import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { PACK_AUTH_ID_PATTERN, PACK_AUTH_LIMITS, PACK_ENV_NAME_PATTERN, PACK_ID_PATTERN, normalizePackHost, packCoversHost, type PackManifest, type PackSource } from '@shared/packs'
import { mainT } from '../i18n/mainT'
import { issuerAllowed } from './manifest'

const KEY_RULE = /^key:[0-9a-f]{16}$/
const rule = z.string().refine((r) => r === '*' || PACK_ID_PATTERN.test(r) || KEY_RULE.test(r), { error: 'is a pack id, key:<key id> or *' })
const https = z.string().max(2048).regex(/^https:\/\//i, { error: 'is an https address' })
const sha = z.string().regex(/^[0-9a-f]{64}$/i)

const indexAuth = z
  .object({
    issuer: z.string().max(2048).refine((i) => issuerAllowed(i), { error: 'is an https address without a query' }),
    clientId: z.string().min(1).max(PACK_AUTH_LIMITS.clientIdChars),
    scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/)).max(PACK_AUTH_LIMITS.scopes).optional(),
  })
  .strict()

const PARTS = {
  PackIndexes: z.array(z.union([https, z.object({ url: https, name: z.string().min(1).max(80).optional(), auth: indexAuth.optional() }).strict()])).max(20),
  PackForceInstall: z.array(z.union([https, z.object({ url: https, sha256: sha.optional() }).strict()])).max(50),
  PackAllowlist: z.array(rule).max(1_000),
  PackBlocklist: z.array(rule).max(1_000),
  PackTrustedKeys: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(50),
  PackPermissionCeiling: z
    .object({
      network: z.array(z.string().max(260)).max(200),
      sites: z.array(z.string().max(260)).max(200),
      model: z.boolean(),
      files: z.boolean(),
      notifications: z.boolean(),
      clipboard: z.boolean(),
      pageScripts: z.boolean(),
      secrets: z.boolean(),
      localConnectors: z.boolean(),
      // atelier.server: false for no web servers at all; serverLan false for none on the Wi-Fi (this computer only).
      server: z.boolean(),
      serverLan: z.boolean(),
      // The connectors packs may use, by directory id or server name ([] for none).
      connectors: z.array(z.string().max(64)).max(100),
    })
    .partial()
    .strict(),
  PackSideloading: z.boolean(),
  PackAuditLog: z.boolean(),
  AiProvider: z
    .object({
      url: https,
      key: z.string().min(1).max(8_192).optional(),
      token: z.string().min(1).max(8_192).optional(),
      models: z.object({ fast: z.string().min(1).max(200), smart: z.string().min(1).max(200) }).partial().strict().optional(),
    })
    .strict()
    .refine((p) => Boolean(p.key) !== Boolean(p.token), { error: 'needs a key or a token (one of them)' }),
  AppConfig: z.record(
    z.string().regex(PACK_ID_PATTERN),
    z
      .object({
        env: z.record(z.string().regex(PACK_ENV_NAME_PATTERN), z.string().max(2_000)).optional(),
        secrets: z.record(z.string().regex(PACK_ENV_NAME_PATTERN), z.string().max(8_192)).optional(),
        // The organisation's own identity provider for a sign-in the pack declares: its tenant, its client.
        auth: z
          .record(
            z.string().regex(PACK_AUTH_ID_PATTERN),
            z
              .object({
                issuer: z.string().max(2048).refine(issuerAllowed, { error: 'is an https address without a query' }).optional(),
                clientId: z.string().min(1).max(PACK_AUTH_LIMITS.clientIdChars).optional(),
                scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/)).max(PACK_AUTH_LIMITS.scopes).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
  ),
} as const

export interface PackPolicy {
  /** Whether any policy applies (the pages say "Managed by your organisation"). */
  managed: boolean
  /** Where it was read from. */
  source: string | null
  indexes: string[] | null
  /** Private indexes' sign-ins, by index address: Browse asks the person to sign in, and the token goes to the index's own origin only. */
  indexAuth: Record<string, PackIndexAuth>
  forceInstall: Array<{ url: string; sha256: string | null }>
  allow: string[] | null
  block: string[]
  trustedKeys: string[]
  ceiling: z.infer<(typeof PARTS)['PackPermissionCeiling']> | null
  sideloading: boolean
  /** Each pack's log records the permissions it used and the hosts it reached, and can't be cleared. */
  audit: boolean
  appConfig: Record<string, PackAppConfig>
  /** The organisation's model gateway: atelier.ai for packs goes there, with its key or token, instead of the person's account. */
  aiProvider: PackAiProvider | null
}

export interface PackIndexAuth {
  /** What Browse calls it before it can be read, such as "Contoso apps". */
  name: string | null
  issuer: string
  clientId: string
  scopes: string[]
}

export interface PackAiProvider {
  /** An Anthropic-compatible endpoint: Atelier posts to <url>/v1/messages. */
  url: string
  key: string | null
  token: string | null
  /** The gateway's names for the fast and smart tiers, when they differ from Claude's. */
  models: { fast?: string; smart?: string }
}

/** What an organisation sets for one pack: values of the env and secrets it declares, and its sign-ins' issuer, client and scopes. */
export interface PackAppConfig {
  env?: Record<string, string>
  secrets?: Record<string, string>
  auth?: Record<string, { issuer?: string; clientId?: string; scopes?: string[] }>
}

export const NO_POLICY: PackPolicy = { managed: false, source: null, indexes: null, indexAuth: {}, forceInstall: [], allow: null, block: [], trustedKeys: [], ceiling: null, sideloading: true, audit: false, appConfig: {}, aiProvider: null }

/** A value as the registry or a profile gives it: JSON text for lists and objects, 0 and 1 for booleans. */
function decode(value: unknown): unknown {
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

/** A policy from raw named values; each one is checked on its own, so one bad value never voids the rest. */
export function parsePolicy(raw: Record<string, unknown>, source: string): { policy: PackPolicy; problems: string[] } {
  const problems: string[] = []
  const got: Partial<{ [K in keyof typeof PARTS]: z.infer<(typeof PARTS)[K]> }> = {}
  for (const [name, schema] of Object.entries(PARTS) as Array<[keyof typeof PARTS, z.ZodType]>) {
    if (!(name in raw)) continue
    let value = decode(raw[name])
    if ((name === 'PackSideloading' || name === 'PackAuditLog') && typeof value === 'number') value = value !== 0
    const parsed = schema.safeParse(value)
    if (parsed.success) (got as Record<string, unknown>)[name] = parsed.data
    else problems.push(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`)
  }
  const managed = Object.keys(got).length > 0
  return {
    policy: {
      managed,
      source: managed ? source : null,
      indexes: got.PackIndexes ? got.PackIndexes.map((i) => (typeof i === 'string' ? i : i.url)) : null,
      indexAuth: Object.fromEntries(
        (got.PackIndexes ?? []).flatMap((i) => (typeof i !== 'string' && i.auth ? [[i.url, { name: i.name ?? null, issuer: i.auth.issuer, clientId: i.auth.clientId, scopes: i.auth.scopes ?? [] }]] : [])),
      ),
      forceInstall: (got.PackForceInstall ?? []).map((f) => (typeof f === 'string' ? { url: f, sha256: null } : { url: f.url, sha256: f.sha256?.toLowerCase() ?? null })),
      allow: got.PackAllowlist ?? null,
      block: got.PackBlocklist ?? [],
      trustedKeys: got.PackTrustedKeys ?? [],
      ceiling: got.PackPermissionCeiling ?? null,
      sideloading: got.PackSideloading ?? true,
      audit: got.PackAuditLog ?? false,
      appConfig: got.AppConfig ?? {},
      aiProvider: got.AiProvider ? { url: got.AiProvider.url.replace(/\/+$/, ''), key: got.AiProvider.key ?? null, token: got.AiProvider.token ?? null, models: got.AiProvider.models ?? {} } : null,
    },
    problems,
  }
}

const matches = (rules: readonly string[], id: string, keyId: string | null): boolean => rules.some((r) => r === '*' || r === id || (keyId !== null && r === `key:${keyId}`))

/** What of a manifest goes beyond the ceiling, in words for the review; empty when it fits. */
export function ceilingProblems(ceiling: PackPolicy['ceiling'], m: Pick<PackManifest, 'permissions' | 'optionalPermissions' | 'secrets' | 'contributes'>): string[] {
  if (!ceiling) return []
  const out: string[] = []
  const within = (allowed: string[] | undefined, hosts: readonly string[], key: 'packs.policy.over.network' | 'packs.policy.over.sites'): void => {
    if (!allowed) return
    const patterns = allowed.map((h) => normalizePackHost(h) ?? h)
    for (const h of hosts) if (!packCoversHost(patterns, h.replace(/^\*\./, ''))) out.push(mainT(key, { host: h }))
  }
  within(ceiling.network, [...m.permissions.network, ...(m.optionalPermissions?.network ?? [])], 'packs.policy.over.network')
  within(ceiling.sites, [...m.permissions.sites, ...(m.optionalPermissions?.sites ?? [])], 'packs.policy.over.sites')
  if (ceiling.model === false && (m.permissions.model || m.optionalPermissions?.model)) out.push(mainT('packs.policy.over.model'))
  if (ceiling.files === false && m.permissions.files) out.push(mainT('packs.policy.over.files'))
  if (ceiling.notifications === false && (m.permissions.notifications || m.optionalPermissions?.notifications)) out.push(mainT('packs.policy.over.notifications'))
  if (ceiling.clipboard === false && (m.permissions.clipboard || m.optionalPermissions?.clipboard)) out.push(mainT('packs.policy.over.clipboard'))
  if (ceiling.pageScripts === false && m.permissions.pageScripts) out.push(mainT('packs.policy.over.pageScripts'))
  if (ceiling.secrets === false && (m.secrets?.length ?? 0) > 0) out.push(mainT('packs.policy.over.secrets'))
  if (ceiling.localConnectors === false && (m.contributes.connectors ?? []).some((c) => c.command)) out.push(mainT('packs.policy.over.localConnectors'))
  if (ceiling.server === false && m.permissions.server) out.push(mainT('packs.policy.over.server'))
  else if (ceiling.serverLan === false && m.permissions.server?.lan) out.push(mainT('packs.policy.over.serverLan'))
  if (ceiling.connectors) for (const ref of m.permissions.connectors ?? []) if (!ceiling.connectors.includes(ref)) out.push(mainT('packs.policy.over.connectors', { name: ref }))
  return out
}

/**
 * Why the organisation doesn't let this pack in (`install`) or keep running
 * (`run`), or null. Blocked, not allowed and beyond the permission ceiling
 * hold for both; where a pack may come from (sideloading, the indexes) only
 * for installing, as in Chrome, so a pack already here keeps working.
 * Force-installed packs and packs Atelier brings are always let in.
 */
export function policyRefusal(policy: PackPolicy, m: Pick<PackManifest, 'id' | 'permissions' | 'optionalPermissions' | 'secrets' | 'contributes'>, keyId: string | null, source: PackSource, forced = false, when: 'install' | 'run' = 'install'): string | null {
  if (!policy.managed || forced || source.kind === 'first-party') return null
  const trusted = keyId !== null && policy.trustedKeys.includes(keyId)
  const allowed = trusted || (policy.allow !== null && matches(policy.allow, m.id, keyId))
  if (matches(policy.block, m.id, keyId) && !allowed) return mainT('packs.policy.blocked')
  if (policy.allow !== null && !allowed) return mainT('packs.policy.notListed')
  if (when === 'install' && !policy.sideloading && (source.kind === 'file' || source.kind === 'link' || source.kind === 'dev' || source.kind === 'draft')) return mainT('packs.policy.sideloading')
  if (when === 'install' && policy.indexes && source.kind === 'index' && !policy.indexes.includes(source.url ?? '')) return mainT('packs.policy.index')
  const over = ceilingProblems(policy.ceiling, m)
  if (over.length > 0) return mainT('packs.policy.ceiling', { what: over.slice(0, 3).join(', ') })
  return null
}

/** Reads the policy where this system keeps it; NO_POLICY when there is none (or it can't be read). */
export async function readPolicy(deps: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; smoke?: boolean; readValues?: (key: string) => Promise<Record<string, string | number>>; plist?: (file: string) => Promise<unknown> } = {}): Promise<{ policy: PackPolicy; problems: string[] }> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  try {
    // Smoke runs (a throwaway profile) read a file instead, so the checks can be managed.
    if (deps.smoke && env.ATELIER_SMOKE_POLICY_FILE) return parsePolicy(JSON.parse(readFileSync(env.ATELIER_SMOKE_POLICY_FILE, 'utf8')) as Record<string, unknown>, env.ATELIER_SMOKE_POLICY_FILE)
    if (platform === 'win32') {
      const read = deps.readValues ?? (await import('../system/registry')).readValues
      // The machine's policy wins over the user's, as in Chrome.
      const user = await read(`HKEY_CURRENT_USER\\SOFTWARE\\Policies\\${BRAND_NAME}`)
      const machine = await read(`HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${BRAND_NAME}`)
      const raw = { ...user, ...machine }
      return Object.keys(raw).length === 0 ? { policy: NO_POLICY, problems: [] } : parsePolicy(raw, Object.keys(machine).length > 0 ? `HKLM\\SOFTWARE\\Policies\\${BRAND_NAME}` : `HKCU\\SOFTWARE\\Policies\\${BRAND_NAME}`)
    }
    if (platform === 'darwin') {
      const user = env.USER ?? ''
      const files = [`/Library/Managed Preferences/com.atelier.browser.plist`, ...(user ? [`/Library/Managed Preferences/${user}/com.atelier.browser.plist`] : [])].filter((f) => existsSync(f))
      if (files.length === 0) return { policy: NO_POLICY, problems: [] }
      const plist = deps.plist ?? readPlist
      const raw = Object.assign({}, ...(await Promise.all(files.reverse().map(plist))).filter((v) => v && typeof v === 'object')) as Record<string, unknown>
      return parsePolicy(raw, files[files.length - 1] as string)
    }
    const file = '/etc/atelier/policies.json'
    if (!existsSync(file)) return { policy: NO_POLICY, problems: [] }
    return parsePolicy(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, file)
  } catch (err) {
    return { policy: NO_POLICY, problems: [`The policy could not be read: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

/** A macOS property list as JSON, through plutil (it reads binary and XML plists alike). */
async function readPlist(file: string): Promise<unknown> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}
