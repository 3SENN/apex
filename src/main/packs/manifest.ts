/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Checking a pack (docs/packs.md › The manifest). validatePack works on the
// pack's files in memory, so a folder, an .apexpack and a companion's draft
// are checked the same way. It returns the manifest with hosts normalised and
// defaults filled, or the problems, each naming where it is, in words a
// person or a companion can act on.
import { BRAND_NAME } from '@shared/branding'
import Ajv from 'ajv'
import { z } from 'zod'
import {
  ALL_SITES,
  APEX_EVENTS,
  KIT_MAJORS,
  APEX_SERVICE_NAMES,
  APEX_SERVICES_AVAILABLE,
  NO_PACK_PERMISSIONS,
  PACK_APP_BUILDS,
  PACK_APP_KINDS,
  PACK_APP_ORIENTATIONS,
  PACK_APPS_MAX,
  PACK_FORMAT,
  PACK_ID_PATTERN,
  PACK_ITEM_ID_PATTERN,
  PACK_CARD_LIMITS,
  PACK_ENV_NAME_PATTERN,
  PACK_EVENT_NAME_PATTERN,
  PACK_HEADER_NAME_PATTERN,
  PACK_LIMITS,
  PACK_REQUIRE_PATTERN,
  PACK_SECRET_HEADER_FORBIDDEN,
  PACK_SECRET_LIMITS,
  PACK_SERVICE_LIMITS,
  PACK_SERVICE_METHOD_PATTERN,
  PACK_SERVICE_NAME_PATTERN,
  PACK_AUTH_ID_PATTERN,
  PACK_AUTH_LIMITS,
  PACK_CONNECTOR_LIMITS,
  PACK_CONNECTOR_REF_PATTERN,
  PACK_MANIFEST_FILE,
  PACK_MANIFEST_VERSION,
  PACK_MENU_CONTEXTS,
  PACK_TOOL_NAME_PATTERN,
  PACK_VERSION_PATTERN,
  isAssetCode,
  isPackFilePath,
  isPackPath,
  manifestAppRoots,
  manifestAssetRoots,
  manifestHasApps,
  manifestIsBig,
  normalizePackHost,
  packAppAt,
  packAppEntryPath,
  packCoversHost,
  packFileLimits,
  packHasCode,
  packHostMatches,
  parsePackRun,
  type PackApp,
  type PackAuth,
  type PackFileLimits,
  type PackManifest,
  type PackSecret,
} from '@shared/packs'
import { SKILL_MAIN_FILE } from '@shared/skills'
import { WORLD_LIMITS } from '@shared/worlds'
import { parseCompanionFile } from '../companions'
import { anyScheduleSchema } from '../routines/scheduleSchema'
import { validateSchedule } from '../routines/schedule'
import { parseSkillDocument, type SkillDocument } from '../skills/format'
import { isEnvFile, keyIn } from './secrets'
import { checkWorldFile, worldApps } from './worlds'

/** A pack's files by relative path ('/'-separated), without Apex's own __apex/ files. */
export type PackFiles = Map<string, Buffer>

export interface PackSkillFile {
  /** The skill folder's path inside the pack. */
  dir: string
  doc: SkillDocument
  /** Supporting files next to SKILL.md, relative to the skill folder. */
  files: Array<{ path: string; data: Buffer }>
}

export interface ValidatedPack {
  manifest: PackManifest
  skills: PackSkillFile[]
}

export type PackCheck = { ok: true; pack: ValidatedPack } | { ok: false; problems: string[]; manifest: PackManifest | null }

const text = (max: number) => z.string().trim().min(1).max(max)
const itemId = z.string().regex(PACK_ITEM_ID_PATTERN, { error: 'use lowercase letters, digits and dashes (up to 32)' })
const path = z.string().refine(isPackPath, { error: 'is not a file path inside the pack' })
const https = z.string().max(2048).refine((u) => /^https:\/\/[^\s/]+/i.test(u), { error: 'must be an https address' })
const hostEntry = z.string().max(260)
const listOf = <T extends z.ZodType>(item: T) => z.array(item).max(PACK_LIMITS.perContribution)

const schema = z
  .object({
    format: z.literal(PACK_FORMAT),
    manifestVersion: z.number().int().min(1).max(PACK_MANIFEST_VERSION),
    id: z.string().regex(PACK_ID_PATTERN, { error: 'use 2 to 32 lowercase letters, digits and dashes, starting with a letter or digit' }),
    name: text(80),
    version: z.string().regex(PACK_VERSION_PATTERN, { error: 'use major.minor.patch, such as 1.0.0' }),
    description: text(500),
    author: z.object({ name: text(80) }).strict().optional(),
    builtBy: text(80).optional(),
    homepage: https.optional(),
    updateUrl: https.optional(),
    forkedFrom: z.object({ id: z.string().regex(PACK_ID_PATTERN), version: z.string().regex(PACK_VERSION_PATTERN), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
    contributes: z
      .object({
        skills: listOf(path),
        routines: listOf(z.object({ id: itemId, name: text(80), prompt: text(10_000), schedule: anyScheduleSchema }).strict()),
        tweaks: listOf(z.object({ id: itemId, match: z.array(hostEntry).min(1).max(20), subdomains: z.boolean().optional(), css: path.optional(), js: path.optional() }).strict()),
        themes: listOf(z.object({ id: itemId, name: text(40), accent: z.string().regex(/^#[0-9a-f]{6}$/i, { error: 'use a #rrggbb colour' }) }).strict()),
        companions: listOf(path),
        connectors: listOf(z.object({ id: itemId, name: text(48), url: z.string().max(2048).optional(), command: text(500).optional(), args: z.array(z.string().max(1000)).max(50).optional() }).strict()),
        panels: listOf(z.object({ id: itemId, title: text(60), html: path, sidebar: z.boolean().optional(), icon: path.optional() }).strict()),
        apps: z
          .array(
            z
              .object({
                id: itemId,
                name: text(80),
                root: path.default('app'),
                entry: path.default('index.html'),
                build: z.enum(PACK_APP_BUILDS as ['kit', 'bundled']),
                kind: z.enum(PACK_APP_KINDS as ['game', 'tool']).default('tool'),
                icon: path.optional(),
                sidebar: z.boolean().optional(),
                orientation: z.enum(PACK_APP_ORIENTATIONS as ['any', 'landscape', 'portrait']).optional(),
                isolated: z.boolean().optional(),
                eval: z.boolean().optional(),
                assets: z.array(z.object({ id: itemId, name: text(60), description: text(500), layout: path.optional() }).strict()).max(10).optional(),
                kit: z.number().int().optional(),
                cast: z.object({ min: z.number().int().min(0).max(8), max: z.number().int().min(1).max(8) }).strict().optional(),
              })
              .strict(),
          )
          .max(PACK_APPS_MAX),
        assets: listOf(z.object({ id: itemId, name: text(80), for: z.object({ pack: z.string().regex(PACK_ID_PATTERN, { error: 'is not a pack id' }), app: itemId, slot: itemId }).strict(), root: path }).strict()),
        cards: listOf(z.object({ id: itemId, title: text(60), module: path, open: z.string().max(80).optional() }).strict()),
        worlds: z.array(path).max(WORLD_LIMITS.perPack),
        commands: listOf(z.object({ id: itemId, title: text(80), run: z.string().max(80) }).strict()),
        menus: listOf(z.object({ id: itemId, title: text(80), context: z.enum(PACK_MENU_CONTEXTS as ['page', 'selection', 'link']), run: z.string().max(80) }).strict()),
        tools: listOf(
          z
            .object({
              name: z.string().regex(PACK_TOOL_NAME_PATTERN, { error: 'use 1 to 24 lowercase letters, digits and underscores, starting with a letter' }),
              description: text(2_000),
              inputSchema: z.record(z.string(), z.unknown()),
              module: path,
            })
            .strict(),
        ),
      })
      .partial()
      .strict()
      .default({}),
    optionalPermissions: z
      .object({ sites: z.array(hostEntry).max(100), network: z.array(hostEntry).max(50), notifications: z.boolean(), model: z.boolean(), clipboard: z.boolean() })
      .partial()
      .strict()
      .optional(),
    provides: z
      .array(
        z
          .object({
            service: z.string().regex(PACK_SERVICE_NAME_PATTERN, { error: 'use 2 to 48 lowercase letters, digits and dashes, starting with a letter' }),
            description: text(500),
            methods: z.record(
              z.string().regex(PACK_SERVICE_METHOD_PATTERN, { error: 'method names start with a letter: letters, digits and underscores, up to 32' }),
              z.object({ description: text(500).optional(), input: z.record(z.string(), z.unknown()) }).strict(),
            ),
            module: path.optional(),
            agent: z.boolean().optional(),
          })
          .strict(),
      )
      .max(PACK_SERVICE_LIMITS.services)
      .optional(),
    uses: z.array(z.string().regex(PACK_SERVICE_NAME_PATTERN, { error: 'is not a service name' })).max(PACK_SERVICE_LIMITS.uses).optional(),
    events: z
      .object({
        emits: z.array(z.string().regex(PACK_EVENT_NAME_PATTERN, { error: 'use up to 32 lowercase letters, digits and dashes, starting with a letter' })).max(PACK_SERVICE_LIMITS.emits).optional(),
        on: z.array(z.string().max(80)).max(PACK_SERVICE_LIMITS.listens).optional(),
      })
      .strict()
      .optional(),
    secrets: z
      .array(
        z
          .object({
            id: z.string().regex(PACK_ENV_NAME_PATTERN, { error: 'use capitals, digits and underscores, starting with a letter, such as API_KEY' }),
            name: text(60),
            description: text(300).optional(),
            hosts: z.array(hostEntry).min(1).max(10),
            header: z.string().regex(PACK_HEADER_NAME_PATTERN, { error: 'is not a header name' }),
            prefix: z.string().max(PACK_SECRET_LIMITS.prefixChars).optional(),
          })
          .strict(),
      )
      .max(PACK_SECRET_LIMITS.secrets)
      .optional(),
    env: z.record(z.string().regex(PACK_ENV_NAME_PATTERN, { error: 'use capitals, digits and underscores, starting with a letter, such as SERVER_URL' }), z.string().max(PACK_SECRET_LIMITS.envValueChars)).optional(),
    auth: z
      .array(
        z
          .object({
            id: z.string().regex(PACK_AUTH_ID_PATTERN, { error: 'use lowercase letters, digits and dashes, starting with a letter, such as corp' }),
            name: text(60),
            issuer: z.string().max(2048),
            clientId: z.string().min(1).max(PACK_AUTH_LIMITS.clientIdChars),
            scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/, { error: 'is not a scope (no spaces or quotes)' })).max(PACK_AUTH_LIMITS.scopes).optional(),
            hosts: z.array(hostEntry).min(1).max(10),
          })
          .strict(),
      )
      .max(PACK_AUTH_LIMITS.auth)
      .optional(),
    requires: z
      .object({ packs: z.record(z.string().regex(PACK_ID_PATTERN, { error: 'is not a pack id' }), z.string().regex(PACK_REQUIRE_PATTERN, { error: 'use a version such as 1.2.0 or >=1.2.0' })).optional() })
      .strict()
      .optional(),
    permissions: z
      .object({
        sites: z.array(hostEntry).max(100),
        network: z.array(hostEntry).max(50),
        pageScripts: z.boolean(),
        notifications: z.boolean(),
        model: z.boolean(),
        clipboard: z.boolean(),
        files: z.boolean(),
        speak: z.boolean(),
        worlds: z.boolean(),
        connectors: z.array(z.string().regex(PACK_CONNECTOR_REF_PATTERN, { error: 'use a connector’s directory id or server name, such as atlassian' })).max(PACK_CONNECTOR_LIMITS.connectors),
        server: z.object({ lan: z.boolean().optional() }).strict(),
      })
      .partial()
      .strict()
      .default({}),
  })
  .strict()

function issues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.length > 0 ? i.path.join('.') : 'apex-pack.json'}: ${i.message}`)
}

const isCode = (p: string): boolean => /\.(m?js)$/i.test(p)
/** Files the review shows in full: what runs (scripts, pages, SVG documents). */
export const isReviewedCode = (p: string): boolean => /\.(m?js|html?|svg)$/i.test(p)
/** All of a pack's reviewed code together, so the review never has to cut it. */
export const REVIEWED_CODE_MAX = 1024 * 1024

const ajv = new Ajv({ strict: false, allErrors: false })

/** A .js file that reads as minified or bundled, which a person can't review. */
export function looksMinified(source: string): boolean {
  return source.split('\n').some((line) => line.length > PACK_LIMITS.minifiedLine)
}

/** The limits a pack's files are held to, from its manifest (or the smaller ones when it can't be read). */
export function limitsForFiles(files: PackFiles): PackFileLimits {
  const data = files.get(PACK_MANIFEST_FILE)
  if (!data || data.length > PACK_LIMITS.manifestBytes) return packFileLimits(false)
  try {
    return packFileLimits(manifestHasApps(JSON.parse(data.toString('utf8').replace(/^﻿/, ''))))
  } catch {
    return packFileLimits(false)
  }
}

/**
 * Size, count and path limits on the files themselves. `appRoots` are the
 * apps' folders, whose files may have asset names; `built` names the files of
 * bundled apps: they may be minified, and they don't count toward what the
 * review shows, since no one can read a build tool's output.
 */
export function checkFiles(files: PackFiles, limits: PackFileLimits = packFileLimits(false), built: (path: string) => boolean = () => false, appRoots: readonly string[] = []): string[] {
  const problems: string[] = []
  if (files.size > limits.files) problems.push(`A pack holds at most ${limits.files} files; this one has ${files.size}.`)
  let total = 0
  for (const [p, data] of files) {
    total += data.length
    if (!isPackFilePath(p, appRoots)) problems.push(`${p}: is not an allowed file path (letters, digits, dot, dash and underscore; inside an app's folder also spaces and & ' ( ) + , ! @ [ ] ~ =; not under __apex/).`)
    if (data.length > limits.fileBytes) problems.push(`${p}: is larger than ${limits.fileBytes / 1024 / 1024} MB.`)
    if (isEnvFile(p)) problems.push(`${p}: a .env file holds keys, and a pack's files are public. Leave it out: list the keys people enter in secrets, and public values in env (docs/apps.md › Your own servers).`)
    if (isCode(p) && !built(p) && looksMinified(data.toString('utf8'))) problems.push(`${p}: looks minified. Packs ship readable code, so people can see what runs; a build tool's output goes in an app with "build": "bundled".`)
  }
  if (total > limits.packBytes) problems.push(`A pack is at most ${limits.packBytes / 1024 / 1024} MB; this one is ${(total / 1024 / 1024).toFixed(1)} MB.`)
  const code = [...files].filter(([p]) => isReviewedCode(p) && !built(p)).reduce((n, [, d]) => n + d.length, 0)
  if (code > REVIEWED_CODE_MAX) problems.push(`Scripts, pages and SVG files come to ${(code / 1024).toFixed(0)} KB; keep them under ${REVIEWED_CODE_MAX / 1024} KB so the review can show all of it.`)
  // APFS and NTFS fold case: two paths that differ only by case would become one file.
  const folded = new Map<string, string>()
  for (const p of files.keys()) {
    const other = folded.get(p.toLowerCase())
    if (other) problems.push(`${p}: differs from ${other} only by case.`)
    folded.set(p.toLowerCase(), p)
  }
  return problems
}

function readManifest(files: PackFiles): { raw: unknown; problems: string[] } {
  const data = files.get(PACK_MANIFEST_FILE)
  if (!data) return { raw: null, problems: [`${PACK_MANIFEST_FILE} is missing.`] }
  if (data.length > PACK_LIMITS.manifestBytes) return { raw: null, problems: [`${PACK_MANIFEST_FILE} is larger than 64 KB.`] }
  try {
    return { raw: JSON.parse(data.toString('utf8').replace(/^﻿/, '')), problems: [] }
  } catch (err) {
    return { raw: null, problems: [`${PACK_MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

/** An identity provider's address: https, or http on this computer while you develop; no query or fragment. */
export function issuerAllowed(issuer: string): boolean {
  try {
    const u = new URL(issuer)
    if (u.search || u.hash || u.username || u.password) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

function hosts(entries: readonly string[], where: string, problems: string[]): string[] {
  const out: string[] = []
  for (const [i, entry] of entries.entries()) {
    const host = normalizePackHost(entry)
    if (!host) problems.push(`${where}.${i}: "${entry}" is not a host name (use example.com or *.example.com).`)
    else if (!out.includes(host)) out.push(host)
  }
  return out
}

/** The plugin model's rules (docs/apps.md › Services and Events): services, what a pack uses, its events and the packs it needs. */
function checkPlugin(m: { id: string; provides?: Array<{ service: string; methods: Record<string, { input: Record<string, unknown> }>; module?: string }>; uses?: string[]; events?: { emits?: string[]; on?: string[] }; requires?: { packs?: Record<string, string> }; contributes: { apps?: PackApp[] } }, files: PackFiles, problems: string[]): void {
  const own = new Set<string>()
  for (const [i, svc] of (m.provides ?? []).entries()) {
    const where = `provides.${i}`
    if (APEX_SERVICE_NAMES.includes(svc.service)) problems.push(`${where}.service: "${svc.service}" is one of ${BRAND_NAME}'s own services; pick another name.`)
    if (own.has(svc.service)) problems.push(`${where}.service: "${svc.service}" is used twice.`)
    own.add(svc.service)
    const methods = Object.entries(svc.methods)
    if (methods.length === 0) problems.push(`${where}.methods: list at least one method.`)
    if (methods.length > PACK_SERVICE_LIMITS.methods) problems.push(`${where}.methods: at most ${PACK_SERVICE_LIMITS.methods}.`)
    for (const [name, method] of methods) {
      const type = method.input.type
      if (type !== undefined && type !== 'object') problems.push(`${where}.methods.${name}.input: type must be "object".`)
      if (JSON.stringify(method.input).length > 8_000) problems.push(`${where}.methods.${name}.input: is longer than 8,000 characters.`)
      else {
        try {
          ajv.compile({ ...method.input, type: 'object' })
        } catch (err) {
          problems.push(`${where}.methods.${name}.input: is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    if (svc.module) {
      if (!files.has(svc.module)) problems.push(`${where}.module: ${svc.module} is not in the pack.`)
      if (!isCode(svc.module)) problems.push(`${where}.module: must be a .js or .mjs file.`)
      const app = packAppAt(m.contributes.apps, svc.module)
      if (app) problems.push(`${where}.module: ${svc.module} is inside the app ${app.id}'s folder (${app.root}/). Keep service modules outside it.`)
    }
  }
  const seen = new Set<string>()
  for (const [i, name] of (m.uses ?? []).entries()) {
    if (seen.has(name)) problems.push(`uses.${i}: "${name}" is listed twice.`)
    seen.add(name)
    if (own.has(name)) problems.push(`uses.${i}: "${name}" is this pack's own service; it doesn't need to use it.`)
    if (APEX_SERVICE_NAMES.includes(name) && !APEX_SERVICES_AVAILABLE.includes(name)) problems.push(`uses.${i}: ${BRAND_NAME} doesn't offer the ${name} service yet.`)
  }
  for (const [i, name] of (m.events?.on ?? []).entries()) {
    const ok = APEX_EVENTS.includes(name) || /^([a-z0-9][a-z0-9-]{1,31})\/([a-z][a-z0-9-]{0,31})$/.test(name)
    if (!ok) problems.push(`events.on.${i}: "${name}" is neither <pack-id>/<event> nor one of ${BRAND_NAME}'s events (${APEX_EVENTS.join(', ')}).`)
    else if (name.startsWith(`${m.id}/`)) problems.push(`events.on.${i}: a pack doesn't listen to its own events; handle them where it sends them.`)
  }
  if (new Set(m.events?.emits ?? []).size !== (m.events?.emits ?? []).length) problems.push('events.emits: a name is listed twice.')
  const required = Object.keys(m.requires?.packs ?? {})
  if (required.length > PACK_SERVICE_LIMITS.requires) problems.push(`requires.packs: at most ${PACK_SERVICE_LIMITS.requires}.`)
  if (required.includes(m.id)) problems.push('requires.packs: a pack doesn\'t require itself.')
}

/** One app's rules (docs/apps.md › The manifest): its folder, its entry page and its icon. */
function checkApp(app: PackApp, i: number, apps: readonly PackApp[], files: PackFiles, problems: string[]): void {
  const where = `contributes.apps.${i}`
  if (files.has(app.root)) problems.push(`${where}.root: ${app.root} is a file; it must be the app's folder.`)
  const entry = packAppEntryPath(app)
  if (!files.has(entry)) problems.push(`${where}.entry: ${entry} is not in the pack.`)
  if (!/\.html?$/i.test(app.entry)) problems.push(`${where}.entry: must be an .html file.`)
  for (const [j, other] of apps.entries()) {
    if (j <= i) continue
    if (other.root === app.root || other.root.startsWith(`${app.root}/`) || app.root.startsWith(`${other.root}/`)) problems.push(`${where}.root: ${app.root} overlaps the folder of contributes.apps.${j} (${other.root}).`)
  }
  if (app.cast && app.cast.min > app.cast.max) problems.push(`${where}.cast: min is more than max.`)
  if (app.kit !== undefined && !KIT_MAJORS.includes(app.kit)) problems.push(`${where}.kit: this ${BRAND_NAME} has kit ${KIT_MAJORS.join(', ')}; kit ${app.kit} isn't here.`)
  if (app.icon) {
    const icon = files.get(app.icon)
    if (!icon) problems.push(`${where}.icon: ${app.icon} is not in the pack.`)
    if (!/\.(png|svg)$/i.test(app.icon)) problems.push(`${where}.icon: must be a .png or .svg file.`)
    if (icon && icon.length > PACK_CARD_LIMITS.iconBytes) problems.push(`${where}.icon: is larger than 64 KB.`)
  }
}

/** Compatibility: contribution kinds renamed since packs were first made, old name → new; a manifest may still use the old one. */
const RENAMED_CONTRIBUTIONS: Record<string, string> = {
  boosts: 'tweaks', // compatibility: site tweaks were contributes.boosts before the rename
}

/** The manifest with renamed contribution kinds under their new names (compatibility); both names at once is a problem. */
function renamedContributions(raw: unknown, problems: string[]): unknown {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { contributes?: unknown }).contributes : undefined
  if (!c || typeof c !== 'object' || Array.isArray(c)) return raw
  let out: Record<string, unknown> | null = null
  for (const [from, to] of Object.entries(RENAMED_CONTRIBUTIONS)) {
    if (!Object.hasOwn(c, from)) continue
    const source: Record<string, unknown> = out ?? (c as Record<string, unknown>)
    const { [from]: list, ...rest } = source
    if (Object.hasOwn(rest, to)) problems.push(`contributes.${from}: is the old name of contributes.${to}. Keep one of them.`)
    out = Object.hasOwn(rest, to) ? rest : { ...rest, [to]: list }
  }
  return out ? { ...(raw as Record<string, unknown>), contributes: out } : raw
}

/** Checks a pack's files and manifest; see docs/packs.md for every rule. */
export function validatePack(files: PackFiles): PackCheck {
  const { raw: read, problems: readProblems } = readManifest(files)
  const raw = renamedContributions(read, readProblems)
  // The manifest picks the limits, the app folders and which files are a build's
  // output; if it doesn't pass the schema below, the pack is refused anyway.
  const builtRoots = manifestAppRoots(raw, 'bundled')
  const assetRoots = manifestAssetRoots(raw)
  // An asset set's files are art, not code: they don't count toward the review either.
  const problems = checkFiles(files, packFileLimits(manifestIsBig(raw)), (p) => [...builtRoots, ...assetRoots].some((r) => p.startsWith(`${r}/`)), [...manifestAppRoots(raw), ...assetRoots])
  problems.push(...readProblems)
  if (raw === null) return { ok: false, problems, manifest: null }
  if (typeof raw === 'object' && raw && (raw as { manifestVersion?: unknown }).manifestVersion !== undefined && Number((raw as { manifestVersion: unknown }).manifestVersion) > PACK_MANIFEST_VERSION) {
    return { ok: false, problems: [`This pack was made for a newer version of ${BRAND_NAME}. Update ${BRAND_NAME}, then try again.`], manifest: null }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, problems: [...problems, ...issues(parsed.error)], manifest: null }
  const m = parsed.data
  const c = m.contributes
  if ((c.apps?.length ?? 0) > 0 && m.manifestVersion < 2) problems.push('contributes.apps: apps need "manifestVersion": 2.')
  if ((m.provides || m.uses || m.events || m.requires || m.optionalPermissions) && m.manifestVersion < 2) problems.push('provides, uses, events, requires and optionalPermissions need "manifestVersion": 2.')
  if ((m.secrets || m.env || m.auth) && m.manifestVersion < 2) problems.push('secrets, env and auth need "manifestVersion": 2.')
  const permissions = { ...NO_PACK_PERMISSIONS, ...m.permissions }
  const sites = hosts(permissions.sites, 'permissions.sites', problems)
  const network = hosts(permissions.network, 'permissions.network', problems)
  if (network.includes(ALL_SITES)) problems.push('permissions.network: "*" is not allowed. List the hosts the pack talks to.')
  if (sites.includes(ALL_SITES) && sites.length > 1) problems.push('permissions.sites: "*" already covers every site; leave the others out.')
  for (const [i, h] of network.entries()) {
    if (h.startsWith('*.') && h.slice(2).split('.').length < 2) problems.push(`permissions.network.${i}: "${h}" is too broad.`)
  }

  const need = (p: string, where: string): Buffer | null => {
    const data = files.get(p)
    if (!data) problems.push(`${where}: ${p} is not in the pack.`)
    return data ?? null
  }
  const unique = (items: readonly { id?: string; name?: string }[], key: 'id' | 'name', where: string): void => {
    const seen = new Set<string>()
    for (const [i, item] of items.entries()) {
      const v = item[key] ?? ''
      if (seen.has(v)) problems.push(`${where}.${i}: "${v}" is used twice.`)
      seen.add(v)
    }
  }

  // Skills: each a folder with SKILL.md.
  const skills: PackSkillFile[] = []
  for (const [i, dir] of (c.skills ?? []).entries()) {
    const main = need(`${dir}/${SKILL_MAIN_FILE}`, `contributes.skills.${i}`)
    if (!main) continue
    try {
      const doc = parseSkillDocument(main.toString('utf8'))
      if (skills.some((s) => s.doc.name === doc.name)) problems.push(`contributes.skills.${i}: the skill name /${doc.name} is used twice.`)
      const prefix = `${dir}/`
      const extra = [...files].filter(([p]) => p.startsWith(prefix) && p !== `${prefix}${SKILL_MAIN_FILE}`).map(([p, data]) => ({ path: p.slice(prefix.length), data }))
      skills.push({ dir, doc, files: extra })
    } catch (err) {
      problems.push(`contributes.skills.${i}: ${dir}/${SKILL_MAIN_FILE} can't be read: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const skillNames = new Set(skills.map((s) => s.doc.name))

  // Routine templates.
  unique(c.routines ?? [], 'id', 'contributes.routines')
  for (const [i, r] of (c.routines ?? []).entries()) {
    try {
      validateSchedule(r.schedule, { requireFuture: false })
    } catch (err) {
      problems.push(`contributes.routines.${i}.schedule: ${err instanceof Error ? err.message : String(err)}`)
    }
    const skill = /^\/([a-z0-9][a-z0-9-]*)/.exec(r.prompt)?.[1]
    if (skill && !skillNames.has(skill)) problems.push(`contributes.routines.${i}.prompt: starts with /${skill}, which is not one of this pack's skills.`)
  }

  // Tweaks.
  unique(c.tweaks ?? [], 'id', 'contributes.tweaks')
  const tweaks = (c.tweaks ?? []).map((b, i) => {
    const match = hosts(b.match, `contributes.tweaks.${i}.match`, problems).map((h) => h.replace(/^\*\./, ''))
    if (match.includes(ALL_SITES)) problems.push(`contributes.tweaks.${i}.match: a tweak names its sites; "*" is not allowed.`)
    if (!b.css && !b.js) problems.push(`contributes.tweaks.${i}: add css, js or both.`)
    if (b.css) need(b.css, `contributes.tweaks.${i}.css`)
    if (b.js) {
      need(b.js, `contributes.tweaks.${i}.js`)
      if (!permissions.pageScripts) problems.push(`contributes.tweaks.${i}.js: needs permissions.pageScripts.`)
    }
    for (const h of match) {
      const covered = packCoversHost(sites, h) && (!b.subdomains || sites.includes(`*.${h}`) || sites.includes(ALL_SITES))
      if (!covered) problems.push(`contributes.tweaks.${i}.match: ${b.subdomains ? `*.${h}` : h} must be in permissions.sites.`)
    }
    return { ...b, match }
  })
  if (permissions.pageScripts && !tweaks.some((b) => b.js)) problems.push('permissions.pageScripts: no tweak has a script. Leave it off.')

  // Themes, companions, connectors.
  unique(c.themes ?? [], 'id', 'contributes.themes')
  for (const [i, p] of (c.companions ?? []).entries()) {
    const data = need(p, `contributes.companions.${i}`)
    if (!data) continue
    try {
      const file = parseCompanionFile(data.toString('utf8'))
      if (file.memory && file.memory.length > 0) problems.push(`contributes.companions.${i}: ${p} holds memory. Packs never carry a companion's memory.`)
    } catch (err) {
      problems.push(`contributes.companions.${i}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  unique(c.connectors ?? [], 'id', 'contributes.connectors')
  for (const [i, conn] of (c.connectors ?? []).entries()) {
    if (Boolean(conn.url) === Boolean(conn.command)) problems.push(`contributes.connectors.${i}: give either url or command.`)
    if (conn.url && !/^https:\/\/[^\s/]+/i.test(conn.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(conn.url)) problems.push(`contributes.connectors.${i}.url: use https (or http on localhost).`)
    if (conn.args && !conn.command) problems.push(`contributes.connectors.${i}.args: only a command takes args.`)
  }

  // Panels, tools, commands and menus.
  unique(c.panels ?? [], 'id', 'contributes.panels')
  for (const [i, panel] of (c.panels ?? []).entries()) {
    need(panel.html, `contributes.panels.${i}.html`)
    if (!/\.html?$/i.test(panel.html)) problems.push(`contributes.panels.${i}.html: must be an .html file.`)
    if (panel.icon) {
      const icon = need(panel.icon, `contributes.panels.${i}.icon`)
      if (!/\.(png|svg)$/i.test(panel.icon)) problems.push(`contributes.panels.${i}.icon: must be a .png or .svg file.`)
      if (icon && icon.length > PACK_CARD_LIMITS.iconBytes) problems.push(`contributes.panels.${i}.icon: is larger than 64 KB.`)
    }
  }
  unique(c.apps ?? [], 'id', 'contributes.apps')
  for (const [i, app] of (c.apps ?? []).entries()) checkApp(app, i, c.apps ?? [], files, problems)
  // Asset slots: unique within the pack (an app reads them at __apex/assets/<slot>/), each layout a folder of its app.
  const slots = new Set<string>()
  for (const [i, app] of (c.apps ?? []).entries()) {
    for (const [j, slot] of (app.assets ?? []).entries()) {
      if (slots.has(slot.id)) problems.push(`contributes.apps.${i}.assets.${j}.id: "${slot.id}" is used by another slot in this pack.`)
      slots.add(slot.id)
      if (slot.layout && !(slot.layout === app.root || slot.layout.startsWith(`${app.root}/`))) problems.push(`contributes.apps.${i}.assets.${j}.layout: ${slot.layout} is not inside the app's folder (${app.root}/).`)
    }
  }
  // Asset sets: files only, in a folder of their own.
  unique(c.assets ?? [], 'id', 'contributes.assets')
  for (const [i, set] of (c.assets ?? []).entries()) {
    const where = `contributes.assets.${i}`
    const inside = [...files.keys()].filter((p) => p.startsWith(`${set.root}/`))
    if (inside.length === 0) problems.push(`${where}.root: ${set.root}/ has no files.`)
    const code = inside.find(isAssetCode)
    if (code) problems.push(`${where}: ${code} is code. Asset packs carry files only (images, sound, video, fonts, models, JSON, text).`)
    const app = packAppAt(c.apps, set.root)
    if (app || (c.apps ?? []).some((a) => a.root.startsWith(`${set.root}/`))) problems.push(`${where}.root: ${set.root} overlaps an app's folder.`)
    if (set.for.pack === m.id) problems.push(`${where}.for.pack: an asset set is for another pack's app.`)
  }
  // Panels, tools and cards are the pack's reviewed code; they stay out of an app's folder.
  const outside = (p: string, where: string): void => {
    const app = packAppAt(c.apps, p)
    if (app) problems.push(`${where}: ${p} is inside the app ${app.id}'s folder (${app.root}/). Keep panels, tools and cards outside it.`)
  }
  for (const [i, panel] of (c.panels ?? []).entries()) outside(panel.html, `contributes.panels.${i}.html`)
  for (const [i, tool] of (c.tools ?? []).entries()) outside(tool.module, `contributes.tools.${i}.module`)
  for (const [i, card] of (c.cards ?? []).entries()) outside(card.module, `contributes.cards.${i}.module`)
  unique(c.cards ?? [], 'id', 'contributes.cards')
  for (const [i, card] of (c.cards ?? []).entries()) {
    need(card.module, `contributes.cards.${i}.module`)
    if (!isCode(card.module)) problems.push(`contributes.cards.${i}.module: must be a .js or .mjs file.`)
  }
  unique(c.tools ?? [], 'name', 'contributes.tools')
  for (const [i, tool] of (c.tools ?? []).entries()) {
    need(tool.module, `contributes.tools.${i}.module`)
    if (!isCode(tool.module)) problems.push(`contributes.tools.${i}.module: must be a .js or .mjs file.`)
    const type = tool.inputSchema.type
    if (type !== undefined && type !== 'object') problems.push(`contributes.tools.${i}.inputSchema: type must be "object".`)
    if (JSON.stringify(tool.inputSchema).length > 8_000) problems.push(`contributes.tools.${i}.inputSchema: is longer than 8,000 characters.`)
    else {
      // A schema the API can't read would fail every new chat's request while the pack is on.
      try {
        ajv.compile({ ...tool.inputSchema, type: 'object' })
      } catch (err) {
        problems.push(`contributes.tools.${i}.inputSchema: is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  const checkRun = (run: string, where: string): void => {
    const target = parsePackRun(run)
    if (!target) return void problems.push(`${where}: use skill:<name>, panel:<id>, app:<id> or tool:<name>.`)
    const exists =
      target.kind === 'skill'
        ? skillNames.has(target.target)
        : target.kind === 'panel'
          ? (c.panels ?? []).some((p) => p.id === target.target)
          : target.kind === 'app'
            ? (c.apps ?? []).some((a) => a.id === target.target)
            : (c.tools ?? []).some((t) => t.name === target.target)
    if (!exists) problems.push(`${where}: ${run} is not in this pack.`)
  }
  unique(c.commands ?? [], 'id', 'contributes.commands')
  for (const [i, cmd] of (c.commands ?? []).entries()) checkRun(cmd.run, `contributes.commands.${i}.run`)
  unique(c.menus ?? [], 'id', 'contributes.menus')
  for (const [i, item] of (c.menus ?? []).entries()) checkRun(item.run, `contributes.menus.${i}.run`)
  for (const [i, card] of (c.cards ?? []).entries()) if (card.open) checkRun(card.open, `contributes.cards.${i}.open`)

  checkPlugin(m, files, problems)

  // Worlds (docs/apps.md › Worlds): each file a world; a place opens one of this pack's apps or any other pack's
  // (a world never waits for an app: the viewer offers to get one the person doesn't have).
  if ((c.worlds?.length ?? 0) > 0 && m.manifestVersion < 2) problems.push('contributes.worlds: worlds need "manifestVersion": 2.')
  const worldIds = new Set<string>()
  for (const [i, file] of (c.worlds ?? []).entries()) {
    const where = `contributes.worlds.${i}`
    if (!/\.json$/i.test(file)) {
      problems.push(`${where}: a world is a .json file.`)
      continue
    }
    const data = need(file, where)
    if (!data) continue
    const check = checkWorldFile(data)
    if (!check.ok) {
      problems.push(...check.problems.map((p) => `${file}: ${p}`))
      continue
    }
    if (worldIds.has(check.world.id)) problems.push(`${where}: two worlds have the id ${check.world.id}.`)
    worldIds.add(check.world.id)
    for (const target of worldApps(check.world)) {
      if (target.pack === m.id && !(c.apps ?? []).some((a) => a.id === target.app)) problems.push(`${file}: a place opens ${target.app}, which is not one of this pack's apps.`)
    }
  }

  // Least privilege: what only code can use needs code.
  const code = packHasCode({ contributes: c })
  if (!code) {
    if (network.length > 0) problems.push('permissions.network: only panels, apps, tools and cards can send requests. Leave it empty.')
    if (permissions.model) problems.push('permissions.model: only panels, apps, tools and cards can ask the model. Leave it off.')
    if (permissions.notifications) problems.push('permissions.notifications: only panels, apps, tools and cards can notify. Leave it off.')
    if (permissions.clipboard) problems.push('permissions.clipboard: only panels, apps, tools and cards can copy. Leave it off.')
    if (permissions.files) problems.push('permissions.files: only panels, apps, tools and cards can use files. Leave it off.')
    if (permissions.worlds) problems.push('permissions.worlds: only panels, apps, tools and cards can use worlds. Leave it off.')
  }
  if (permissions.speak && !permissions.model) problems.push('permissions.speak: companions speak through the model; add permissions.model too.')
  if (permissions.speak && !(c.apps ?? []).some((a) => a.cast)) problems.push('permissions.speak: only an app with a cast has companions to speak.')
  // apex.server (docs/packs.md › A web server of its own): only an app's own pages start one.
  if (permissions.server && (c.apps?.length ?? 0) === 0) problems.push('permissions.server: only an app’s pages can run a web server. Add an app, or leave it out.')

  if (!code && !(m.provides ?? []).some((s) => s.module)) {
    if ((m.uses?.length ?? 0) > 0 || (m.events?.emits?.length ?? 0) > 0 || (m.events?.on?.length ?? 0) > 0) problems.push('uses and events: only panels, apps, tools, cards and service modules can use services or events. Add one, or leave them out.')
    if ((m.provides?.length ?? 0) > 0) problems.push('provides: a service needs code to answer it: a module, or an app or panel that calls apex.services.provide.')
  }

  // Optional permissions: hosts in their stored shape, nothing already required, and code to ask for them.
  let optionalPermissions: PackManifest['optionalPermissions']
  if (m.optionalPermissions) {
    const o = m.optionalPermissions
    const optSites = hosts(o.sites ?? [], 'optionalPermissions.sites', problems).filter((h) => !sites.includes(h))
    const optNetwork = hosts(o.network ?? [], 'optionalPermissions.network', problems).filter((h) => !network.includes(h))
    if (optNetwork.includes(ALL_SITES)) problems.push('optionalPermissions.network: "*" is not allowed. List the hosts the pack may ask to talk to.')
    if (!code) problems.push('optionalPermissions: only panels, apps, tools and cards can ask for more. Leave it out.')
    optionalPermissions = {
      ...(optSites.length ? { sites: optSites } : {}),
      ...(optNetwork.length ? { network: optNetwork } : {}),
      ...(o.notifications && !permissions.notifications ? { notifications: true } : {}),
      ...(o.model && !permissions.model ? { model: true } : {}),
      ...(o.clipboard && !permissions.clipboard ? { clipboard: true } : {}),
    }
  }

  // Your own servers (docs/apps.md › Your own servers): a key goes only to hosts the pack may reach, in a header the browser leaves alone.
  let secrets: PackSecret[] | undefined
  const reachable = [...network, ...(optionalPermissions?.network ?? [])]
  // A wildcard secret or sign-in host needs a wildcard at least as wide; a plain one, any pattern that matches it.
  const covered = (h: string): boolean => reachable.some((r) => (h.startsWith('*.') ? r.startsWith('*.') && packHostMatches(r, h.slice(2)) : packHostMatches(r, h)))
  if (m.secrets) {
    if (!code) problems.push('secrets: only panels, apps, tools and cards send requests. Leave them out.')
    const seen = new Set<string>()
    secrets = m.secrets.map((sec, i) => {
      if (seen.has(sec.id)) problems.push(`secrets.${i}.id: ${sec.id} is used twice.`)
      seen.add(sec.id)
      const at = hosts(sec.hosts, `secrets.${i}.hosts`, problems)
      for (const h of at) {
        if (h === ALL_SITES) problems.push(`secrets.${i}.hosts: "*" is not allowed. Name the hosts the key is for.`)
        else if (!covered(h)) problems.push(`secrets.${i}.hosts: ${h} is not in permissions.network or optionalPermissions.network. A key goes only where the pack may send requests.`)
      }
      if (PACK_SECRET_HEADER_FORBIDDEN.test(sec.header)) problems.push(`secrets.${i}.header: a key can't go in ${sec.header}. Use Authorization or a header of the service's own, such as X-Api-Key.`)
      if (sec.prefix !== undefined && /[\u0000-\u001f\u007f]/.test(sec.prefix)) problems.push(`secrets.${i}.prefix: has a control character.`)
      return { ...sec, hosts: at }
    })
  }
  // The person's connectors (docs/apps.md › Apps for organisations): only code calls them.
  if ((m.permissions?.connectors?.length ?? 0) > 0) {
    if (!code) problems.push('permissions.connectors: only panels, apps, tools and cards call connectors. Leave it out.')
    if (m.manifestVersion < 2) problems.push('permissions.connectors needs "manifestVersion": 2.')
    if (new Set(m.permissions?.connectors).size !== m.permissions?.connectors?.length) problems.push('permissions.connectors: a connector is listed twice.')
  }
  // Sign-ins (docs/apps.md › Apps for organisations): the token goes only to hosts the pack may reach, and never where a key already goes in Authorization.
  let auth: PackAuth[] | undefined
  if (m.auth) {
    if (!code) problems.push('auth: only panels, apps, tools and cards send requests. Leave it out.')
    const seen = new Set<string>()
    auth = m.auth.map((a, i) => {
      if (seen.has(a.id)) problems.push(`auth.${i}.id: ${a.id} is used twice.`)
      seen.add(a.id)
      if (!issuerAllowed(a.issuer)) problems.push(`auth.${i}.issuer: use the identity provider's https address (http only on localhost while you develop), without a query or #.`)
      if (/[\u0000-\u001f\u007f]/.test(a.clientId)) problems.push(`auth.${i}.clientId: has a control character.`)
      const at = hosts(a.hosts, `auth.${i}.hosts`, problems)
      for (const h of at) {
        if (h === ALL_SITES) problems.push(`auth.${i}.hosts: "*" is not allowed. Name the hosts the sign-in is for.`)
        else if (!covered(h)) problems.push(`auth.${i}.hosts: ${h} is not in permissions.network or optionalPermissions.network. A sign-in goes only where the pack may send requests.`)
        const clash = secrets?.find((s) => s.header.toLowerCase() === 'authorization' && s.hosts.some((sh) => packHostMatches(sh, h.replace(/^\*\./, '')) || packHostMatches(h, sh.replace(/^\*\./, ''))))
        if (clash) problems.push(`auth.${i}.hosts: ${h} also gets the secret ${clash.id} in Authorization. Only one can go there: send the key in a header of its own, such as X-Api-Key.`)
      }
      return { ...a, hosts: at }
    })
  }
  if (m.env) {
    const names = Object.keys(m.env)
    if (names.length > PACK_SECRET_LIMITS.env) problems.push(`env: at most ${PACK_SECRET_LIMITS.env} values.`)
    for (const name of names) {
      if (m.secrets?.some((sec) => sec.id === name)) problems.push(`env.${name}: is also a secret. A value is public (env) or a key the person enters (secrets), not both.`)
      const what = keyIn(m.env[name] as string, true)
      if (what) problems.push(`env.${name}: looks like ${what}. env is public: everyone who installs the pack can read it. Keep your keys on your server, or ask people for theirs in secrets.`)
    }
  }

  const manifest: PackManifest = {
    ...m,
    ...(optionalPermissions ? { optionalPermissions } : {}),
    ...(secrets ? { secrets } : {}),
    ...(auth ? { auth } : {}),
    contributes: { ...c, ...(c.tweaks ? { tweaks } : {}) },
    permissions: { ...permissions, sites, network },
  } as PackManifest
  if (problems.length > 0) return { ok: false, problems, manifest }
  return { ok: true, pack: { manifest, skills } }
}
