/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The packs service (docs/packs.md): reviews and installs, export, remix,
// drafts, the things a pack offers to add (routines, companions,
// connectors), Share as pack, community indexes and update checks. Every
// install goes through a review: validatePack, the signature and the pinned
// author key, the permission lines and, for an update, what it adds. Only
// confirmInstall, which the person presses, installs.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { generatedCss, sanitizeCss } from '@shared/tweaks'
import { skillReviewText } from '@shared/companion'
import {
  BUILTIN_SKILLS_PACK_ID,
  APP_PACK_LIMITS,
  PACK_APP_FILE_EXTENSION,
  PACK_FILE_EXTENSION,
  PACK_FORMAT,
  PACK_ID_PATTERN,
  PACK_LIMITS,
  PACK_MANIFEST_FILE,
  PACK_MANIFEST_NEW_VERSION,
  PACK_SECRET_LIMITS,
  PACK_WORLD_FILE_EXTENSION,
  NO_PACK_PERMISSIONS,
  bumpPackVersion,
  comparePackVersions,
  countContributions,
  describeOptional,
  describePackPermissions,
  mergePermissions,
  permissionsMissing,
  emptyCounts,
  packAppAt,
  permissionDiff,
  packsPageUrl,
  promptsChangedLine,
  type PackDetail,
  type PackDraftSummary,
  type PackIndexEntry,
  type PackManifest,
  type PackReview,
  type PackShareKind,
  type PackSignatureState,
  type PackSource,
  type PackSummary,
  type PacksServices,
  type PacksState,
} from '@shared/packs'
import type { Services } from '@shared/services'
import { chatUrl } from '@shared/url'
import { SKILL_MAIN_FILE } from '@shared/skills'
import { appStoreInstance } from '../apps/feature'
import { tweakStore } from '../tweaks/feature'
import { parseCompanionFile } from '../companions'
import type { AppContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { serializeSkillDocument } from '../skills/format'
import { decodeArchive, encodeArchive, findSecrets, isPng, packHash, PackFileError, readPackFolder, sha256, type PackShared, type PackSignature } from './files'
import type { WaitReason } from './services'
import { isReviewedCode, validatePack, type PackFiles, type PackSkillFile } from './manifest'
import type { PacksRuntime } from './runtime'
import { downloadImage, fetchIndex, downloadPack, PackDownloadError, type PackIndexFile } from './sharing'
import { fingerprintOf, verifyPackSignature, type AuthorKey, type TrustedKeys } from './signing'
import type { LoadedPack, PackStore } from './store'
import { SecretsUnavailable } from './secrets'
import { INDEX_SIGNINS, indexAuth, type EffectiveAuth } from './signIns'
import { checkWorldFile } from './worlds'
import { policyRefusal } from './policy'
import { WORLDS_PACK_ID, packWorldRef, parseWorldRef } from '@shared/worlds'

type Ns = PacksServices['packs']

const REVIEW_TTL_MS = 30 * 60_000
const CODE_PREVIEW_MAX = 200_000

interface PendingReview {
  files: PackFiles
  manifest: PackManifest
  source: PackSource
  signature: PackSignatureState
  keyId: string | null
  /** The signing key's full fingerprint, which trust is pinned to. */
  fingerprint: string | null
  signatureFile: PackSignature | null
  expires: number
  problems: string[]
}

export interface PacksServiceDeps {
  store: PackStore
  runtime: PacksRuntime
  author: AuthorKey
  trusted: TrustedKeys
  app: AppContext
  services(): Services | null
  /** A companion as .ateliercompanion text, its own skills included, never memory (index.ts binds the companion service). */
  companionText(id: string): string | null
  fetch?: typeof fetch
  now?: () => number
}

/** A pack id from a name: lowercase, dashes, 2 to 32 characters. */
export function slugifyPackId(name: string, taken: (id: string) => boolean): string {
  let base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '')
  if (base.length < 2) base = `pack-${base || 'new'}`.slice(0, 28)
  let id = base
  for (let n = 2; taken(id) && n < 1000; n++) id = `${base}-${n}`
  return id
}

export function manifestText(m: PackManifest): Buffer {
  return Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
}

function baseManifest(id: string, name: string, description: string): PackManifest {
  return {
    format: PACK_FORMAT,
    manifestVersion: PACK_MANIFEST_NEW_VERSION,
    id,
    name: name.slice(0, 80) || id,
    version: '1.0.0',
    description: description.slice(0, 500) || name.slice(0, 500) || id,
    contributes: {},
    permissions: { ...NO_PACK_PERMISSIONS },
  }
}

export function createPacksService(deps: PacksServiceDeps): Omit<Ns, 'openedReview'> & {
  stateNow(): PacksState
  summary(id: string): PackSummary
  reviewArchive(archive: Buffer, source: PackSource): PackReview
  /** Developer mode: the review of a folder, which installing links rather than copies. */
  reviewFolder(dir: string): PackReview
  exportArchive(id: string, from: 'installed' | 'draft', shared?: PackShared | null): { name: string; data: Buffer }
  /** One of your worlds as an .atelierworld: a signed pack holding just the world (docs/apps.md › Worlds). */
  exportWorld(ref: string): { name: string; data: Buffer }
  /** Installs what the organisation's policy force-installs; the problems, if any. */
  applyPolicy(): Promise<string[]>
  /** Before opening a pack's app or panel: turns it on if it is off, or says why it can't run. */
  prepareOpen(id: string): void
  /** Before opening a world: turns on its pack and Worlds, or says why it can't. */
  prepareWorld(ref: string): void
  checkUpdatesIfDue(): Promise<void>
} {
  const { store, runtime } = deps
  const now = deps.now ?? Date.now
  const rawFetch = deps.fetch ?? fetch
  /** A private index's sign-in, by the index's address (none without the organisation's policy). */
  const privateIndex = (url: string): EffectiveAuth | null => {
    const a = store.policy.indexAuth[url]
    return a ? indexAuth(url, a) : null
  }
  /**
   * Every download for packs: a request to a private index's own origin (the
   * index, its archives, its pictures) carries that index's sign-in; nothing
   * else does, and a redirect elsewhere leaves it behind (each hop asks again).
   */
  const doFetch: typeof fetch = (input, init) => {
    const urls = Object.keys(store.policy.indexAuth)
    if (urls.length === 0) return rawFetch(input, init)
    const at = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let origin = ''
    try {
      origin = new URL(at).origin
    } catch {
      return rawFetch(input, init)
    }
    for (const url of urls) {
      const auth = privateIndex(url)
      if (!auth || new URL(url).origin !== origin) continue
      const token = runtime.signIns.token(INDEX_SIGNINS, auth)
      if (!token) break
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return rawFetch(input, { ...init, headers })
    }
    return rawFetch(input, init)
  }
  const reviews = new Map<string, PendingReview>()

  const nameOf = (id: string): string => store.get(id)?.manifest.name ?? id
  const waitText = (r: WaitReason): string =>
    r.kind === 'service'
      ? mainT('packs.wait.service', { name: r.name })
      : r.kind === 'pack'
        ? mainT('packs.wait.pack', { id: r.id, version: r.version ?? '' })
        : mainT('packs.wait.version', { name: nameOf(r.id), want: r.want, have: r.have })

  const summary = (pack: LoadedPack): PackSummary => {
    const m = pack.manifest
    const c = m.contributes
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author?.name ?? null,
      builtBy: m.builtBy ?? null,
      homepage: m.homepage ?? null,
      enabled: pack.entry.enabled,
      source: pack.entry.source,
      installedAt: pack.entry.installedAt,
      updatedAt: pack.entry.updatedAt,
      hash: pack.entry.hash,
      signature: pack.entry.signature,
      keyId: pack.entry.keyId,
      counts: pack.problems.length > 0 && !pack.firstParty ? emptyCounts() : m.id === BUILTIN_SKILLS_PACK_ID ? { ...emptyCounts(), skills: deps.app.skillRoutines?.skills.builtinCount() ?? 0 } : countContributions(c),
      permissions: describePackPermissions(m),
      problems: [...pack.problems, ...(store.policyRefusal(m.id) ? [store.policyRefusal(m.id) as string] : []), ...runtime.problems(m.id)],
      update: pack.entry.update,
      forkedFrom: m.forkedFrom ?? null,
      panels: (c.panels ?? []).map((p) => ({ id: p.id, title: p.title, sidebar: p.sidebar === true })),
      apps: (c.apps ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, build: a.build, sidebar: a.sidebar === true })),
      assetSlots: (c.apps ?? []).flatMap((a) =>
        (a.assets ?? []).map((s) => ({ appId: a.id, appName: a.name, slot: s.id, name: s.name, description: s.description, chosen: pack.entry.assets?.[s.id] ?? null, options: runtime.assetOptions(m.id, a.id, s.id) })),
      ),
      waiting: runtime.waiting(m.id).map(waitText),
      folder: pack.entry.folder,
      ownBytes: pack.firstParty ? 0 : folderBytes(store.ownDir(m.id)),
      optional: describeOptional(m, m.optionalPermissions ? permissionsMissing(mergePermissions(m.permissions, pack.entry.granted), m.optionalPermissions) : null),
      granted: describeOptional(m, pack.entry.granted),
      provides: (m.provides ?? []).map((s) => ({ service: s.service, description: s.description, agent: s.agent === true, usedBy: runtime.providerOf(s.service) === m.id ? runtime.usersOf(s.service).map(nameOf) : [] })),
      uses: (m.uses ?? []).map((service) => {
        const from = runtime.providerOf(service)
        return { service, from: from ? nameOf(from) : null }
      }),
      withdrawn: pack.entry.withdrawn ?? null,
      managed: store.isForced(m.id),
      waitingFor: runtime.waitingPacks(m.id),
      secrets: (m.secrets ?? []).map((k) => ({ id: k.id, name: k.name, description: k.description ?? null, hosts: k.hosts, state: runtime.secretState(m.id, k.id) })),
      signIns: runtime.signInSummary(m.id),
      connectorsUsed: runtime.connectorSummary(m.id),
      worlds: (c.worlds ?? []).map((path) => {
        const data = pack.files.get(path)
        const check = data ? checkWorldFile(data) : null
        return { ref: packWorldRef(m.id, path), name: check?.ok ? check.world.name : path }
      }),
      cards: (c.cards ?? []).map((k) => ({ id: k.id, title: k.title })),
      routines: (c.routines ?? []).map((r) => ({ id: r.id, name: r.name })),
      companions: (c.companions ?? []).map((path) => ({ path, name: companionName(pack.files.get(path)) ?? path })),
      connectors: (c.connectors ?? []).map((k) => ({ id: k.id, name: k.name, local: Boolean(k.command) })),
      themes: (c.themes ?? []).map((t) => ({ id: t.id, name: t.name, accent: t.accent })),
    }
  }

  const draftSummary = (id: string): PackDraftSummary => {
    const d = store.draft(id)
    const m = d.manifest
    return {
      id,
      name: m?.name ?? id,
      version: m?.version ?? '0.0.0',
      description: m?.description ?? '',
      updatedAt: d.updatedAt,
      builtBy: m?.builtBy ?? null,
      problems: d.problems,
      permissions: m ? describePackPermissions(m) : [],
      installedVersion: store.get(id)?.manifest.version ?? null,
      installedSame: Boolean(d.files && store.get(id) && store.get(id)?.entry.hash === packHash(d.files)),
    }
  }

  const stateNow = (): PacksState => ({
    packs: store.all().map(summary),
    drafts: store.draftIds().map(draftSummary).sort((a, b) => b.updatedAt - a.updatedAt),
    indexes: store.indexes().map((source) => {
      const auth = privateIndex(source.url)
      return auth ? { ...source, name: source.name ?? auth.name, signIn: { issuer: new URL(auth.issuer).host, ...runtime.signIns.state(INDEX_SIGNINS, auth) } } : source
    }),
    authorKey: deps.author.keyId(),
    policy: { managed: store.policy.managed, sideloading: store.policy.sideloading, indexesLocked: store.policy.indexes !== null, audit: store.policy.audit, aiProvider: store.policy.aiProvider !== null },
  })

  // ---- reviews ----

  /** The code the review shows: every readable script and page, never a bundled app's build output (its line says so instead). */
  const codeOf = (files: PackFiles, manifest: PackManifest | null): PackReview['code'] => {
    const out: PackReview['code'] = []
    let total = 0
    const built = (manifest?.contributes.apps ?? []).filter((a) => a.build === 'bundled')
    for (const path of [...files.keys()].sort()) {
      if (!isReviewedCode(path) || packAppAt(built, path)) continue
      const text = (files.get(path) as Buffer).toString('utf8')
      if (total + text.length > CODE_PREVIEW_MAX) {
        out.push({ path, text: mainT('packs.review.codeTooLong') })
        continue
      }
      total += text.length
      out.push({ path, text })
    }
    return out
  }

  const makeReview = (files: PackFiles, source: PackSource, signatureFile: PackSignature | null, ownKey: boolean, shared: PackShared | null = null): PackReview => {
    for (const [token, r] of reviews) if (r.expires < now()) reviews.delete(token)
    const check = validatePack(files)
    const manifest = check.ok ? check.pack.manifest : check.manifest
    const problems = check.ok ? [] : [...check.problems]
    const hash = packHash(files)
    let signature: PackSignatureState = 'unsigned'
    let keyId: string | null = null
    let fingerprint: string | null = null
    if (signatureFile) {
      if (verifyPackSignature(hash, signatureFile)) {
        signature = 'signed'
        keyId = signatureFile.keyId
        fingerprint = fingerprintOf(signatureFile)
      } else problems.push(mainT('packs.problem.badSignature'))
    }
    if (ownKey && !signatureFile) {
      // A draft is yours: it installs signed with your key (or unsigned where there is no keychain to keep one).
      try {
        const own = deps.author.sign(hash)
        keyId = own.keyId
        fingerprint = fingerprintOf(own)
        signature = 'signed'
      } catch {
        // Unsigned, as made; the review says so.
      }
    }
    const id = manifest?.id ?? ''
    const installed = id ? store.get(id) : undefined
    if (installed?.firstParty) problems.push(mainT('packs.problem.firstPartyId'))
    // The organisation's policy, if any: who may come in, from where, and how far a pack may go.
    const managedRefusal = manifest ? policyRefusal(store.policy, manifest, keyId, source, forcing.has(source.url ?? '')) : null
    if (managedRefusal) problems.push(managedRefusal)
    if (id) {
      const refusal = deps.trusted.refusal(id, fingerprint)
      if (refusal) problems.push(fingerprint ? mainT('packs.problem.otherAuthor') : mainT('packs.problem.unsignedNow'))
    }
    if (installed && manifest && !installed.firstParty && comparePackVersions(manifest.version, installed.manifest.version) < 0) problems.push(mainT('packs.problem.older', { version: installed.manifest.version }))
    const prompts = check.ok ? promptsOf(check.pack.manifest, check.pack.skills, files) : []
    const changedPrompts = Boolean(installed && !installed.firstParty && check.ok && promptsKey(promptsOf(installed.manifest, installed.skills, installed.files)) !== promptsKey(prompts))
    const token = randomUUID()
    if (manifest) reviews.set(token, { files, manifest, source, signature, keyId, fingerprint, signatureFile, expires: now() + REVIEW_TTL_MS, problems })
    return {
      token,
      id,
      name: manifest?.name ?? mainT('packs.review.unknownName'),
      version: manifest?.version ?? '',
      description: manifest?.description ?? '',
      author: manifest?.author?.name ?? null,
      builtBy: manifest?.builtBy ?? null,
      source,
      signature,
      keyId,
      organisationKey: keyId !== null && store.policy.trustedKeys.includes(keyId),
      counts: manifest ? countContributions(manifest.contributes) : emptyCounts(),
      permissions: manifest ? describePackPermissions(manifest) : [],
      replaces: installed && manifest && !installed.firstParty ? { version: installed.manifest.version, added: [...permissionDiff(installed.manifest, manifest), ...(changedPrompts ? [promptsChangedLine()] : [])] } : null,
      problems,
      files: [...files].map(([path, data]) => ({ path, size: data.length })).sort((a, b) => a.path.localeCompare(b.path)),
      code: codeOf(files, manifest),
      prompts,
      shared: { note: shared?.note ?? null, image: shared?.image && isPng(shared.image) ? `data:image/png;base64,${shared.image.toString('base64')}` : null },
    }
  }

  const reviewFolder = (dir: string): PackReview => {
    if (!isAbsolute(dir)) throw new PackFileError('Choose a folder by its full path.')
    return makeReview(readPackFolder(dir), { kind: 'dev', url: dir }, null, false)
  }

  const reviewArchive = (archive: Buffer, source: PackSource): PackReview => {
    const { files, signature, shared } = decodeArchive(archive)
    return makeReview(files, source, signature, false, shared)
  }

  const confirmInstall = (token: string): PackSummary => {
    const r = reviews.get(token)
    if (!r || r.expires < now()) throw new PackFileError(mainT('packs.error.reviewExpired'))
    if (r.problems.length > 0) throw new PackFileError(r.problems.join('\n'))
    // Again now: the policy may have arrived after the review.
    const managedRefusal = policyRefusal(store.policy, r.manifest, r.keyId, r.source, forcing.has(r.source.url ?? ''))
    if (managedRefusal) throw new PackFileError(managedRefusal)
    reviews.delete(token)
    // Re-check the pin now: another install may have pinned this id since the review.
    const refusal = deps.trusted.refusal(r.manifest.id, r.fingerprint)
    if (refusal) throw new PackFileError(refusal)
    const signatureFile = r.signatureFile ?? (r.source.kind === 'draft' && r.signature === 'signed' ? deps.author.sign(packHash(r.files)) : null)
    const pack = store.install(r.files, { source: r.source, signature: r.signature, keyId: r.keyId, enable: true, signatureFile })
    // A folder in developer mode pins nothing: its signed release later starts its own trust.
    if (r.source.kind !== 'dev') deps.trusted.pin(r.manifest.id, r.fingerprint)
    runtime.tools.reset(r.manifest.id)
    store.log(r.manifest.id, { level: 'info', source: 'atelier', message: `Installed ${r.manifest.version} from ${r.source.kind}${r.source.url ? ` (${r.source.url})` : ''}.` })
    return summary(pack)
  }

  // ---- export ----

  const filesFor = (id: string, from: 'installed' | 'draft'): PackFiles => {
    if (from === 'installed') {
      const pack = store.require(id)
      if (pack.firstParty) throw new PackFileError(mainT('packs.error.firstPartyExport'))
      return store.allFiles(id)
    }
    const d = store.draft(id)
    if (!d.files || d.problems.length > 0) throw new PackFileError(mainT('packs.error.draftProblems', { problems: d.problems.slice(0, 5).join('\n') }))
    return d.files
  }

  const exportArchive = (id: string, from: 'installed' | 'draft', shared: PackShared | null = null): { name: string; data: Buffer } => {
    const files = filesFor(id, from)
    const secrets = findSecrets(files)
    if (secrets.length > 0) throw new PackFileError(mainT('packs.error.secrets', { files: secrets.map((s) => `${s.path} (${s.what})`).join(', ') }))
    const hash = packHash(files)
    const mine = deps.author.keyId()
    const installed = from === 'installed' ? store.require(id) : null
    // Someone else's pack keeps its author's signature, or goes unsigned without it; only yours is signed with your key.
    const theirs = Boolean(installed && installed.entry.keyId && installed.entry.keyId !== mine)
    const kept = theirs ? store.signature(id) : null
    const signature = theirs ? (kept && kept.hash === hash && verifyPackSignature(hash, kept) ? kept : null) : installed && installed.entry.signature === 'unsigned' ? null : deps.author.sign(hash)
    const manifest = validatePack(files)
    const version = manifest.ok ? manifest.pack.manifest.version : '0.0.0'
    // A pack with an app travels as .atelierapp, one with nothing but worlds as .atelierworld (docs/apps.md › Sharing); the archive is the same.
    const c = manifest.ok ? manifest.pack.manifest.contributes : {}
    const onlyWorlds = (c.worlds?.length ?? 0) > 0 && Object.entries(c).every(([k, v]) => k === 'worlds' || !Array.isArray(v) || v.length === 0)
    const ext = (c.apps?.length ?? 0) > 0 ? PACK_APP_FILE_EXTENSION : onlyWorlds ? PACK_WORLD_FILE_EXTENSION : PACK_FILE_EXTENSION
    return { name: `${id}-${version}.${ext}`, data: encodeArchive(files, signature, shared) }
  }

  /**
   * One of your worlds as a pack of its own, signed with your key. Your
   * worlds hold guests and open spots only, so nothing of your companions
   * goes with it; whoever adds it fills the open spots with theirs.
   */
  const exportWorld = (ref: string): { name: string; data: Buffer } => {
    const at = parseWorldRef(ref)
    const world = at?.kind === 'own' ? runtime.ownWorlds.get(at.id) : null
    if (!world) throw new PackFileError(mainT('packs.error.worldGone'))
    // Your key's first characters in the id, so two people's copies of a world never take each other's place.
    deps.author.fingerprint()
    const key = (deps.author.keyId() ?? '').slice(0, 6)
    const id = `world-${world.id.slice(0, 18).replace(/-+$/, '')}-${key}`
    const path = `worlds/${world.id}.json`
    // Each share is a newer version than the last: 1.<day>.<second of the day>.
    const stamp = new Date(now())
    const day = Math.floor((stamp.getTime() - Date.UTC(2026, 0, 1)) / 86_400_000)
    const second = stamp.getUTCHours() * 3600 + stamp.getUTCMinutes() * 60 + stamp.getUTCSeconds()
    const manifest = {
      format: PACK_FORMAT,
      manifestVersion: 2,
      id,
      name: world.name,
      version: `1.${Math.max(0, day)}.${second}`,
      description: world.description?.trim() || mainT('packs.world.description', { name: world.name }),
      contributes: { worlds: [path] },
      permissions: { ...NO_PACK_PERMISSIONS },
    }
    const files: PackFiles = new Map([
      [PACK_MANIFEST_FILE, manifestText(manifest as PackManifest)],
      [path, Buffer.from(`${JSON.stringify(world, null, 2)}\n`)],
    ])
    const check = validatePack(files)
    if (!check.ok) throw new PackFileError(check.problems.slice(0, 3).join(' '))
    const name = world.name.replace(/[\\/:*?"<>|]+/g, '').trim() || id
    return { name: `${name}.${PACK_WORLD_FILE_EXTENSION}`, data: encodeArchive(files, deps.author.sign(packHash(files))) }
  }

  // ---- drafts from what you have ----

  const draftTaken = (id: string): boolean => store.hasDraft(id) || Boolean(store.get(id))

  const shareAs = (kind: PackShareKind, itemId: string): string => {
    const files: PackFiles = new Map()
    let manifest: PackManifest
    if (kind === 'skill') {
      const skills = deps.app.skillRoutines?.skills
      const skill = skills?.get(itemId)
      if (!skills || !skill) throw new PackFileError(mainT('packs.error.missingItem'))
      const id = slugifyPackId(skill.name, draftTaken)
      manifest = baseManifest(id, skill.name, skill.description)
      files.set(`skills/${skill.name}/${SKILL_MAIN_FILE}`, Buffer.from(serializeSkillDocument({ name: skill.name, description: skill.description, instructions: skill.instructions, steps: skill.steps })))
      const dir = skills.folderOf(itemId)
      if (dir) for (const f of skills.files(itemId)) files.set(`skills/${skill.name}/${f.path}`, readFileSync(join(dir, f.path)))
      manifest.contributes.skills = [`skills/${skill.name}`]
    } else if (kind === 'tweak') {
      const tweak = tweakStore()?.get(itemId)
      if (!tweak) throw new PackFileError(mainT('packs.error.missingItem'))
      const id = slugifyPackId(`${tweak.host}-tweak`, draftTaken)
      manifest = baseManifest(id, mainT('packs.share.tweakName', { host: tweak.host }), mainT('packs.share.tweakDescription', { host: tweak.host }))
      const css = [generatedCss(tweak), sanitizeCss(tweak.css).css].filter((c) => c.trim()).join('\n\n')
      const entry: NonNullable<PackManifest['contributes']['tweaks']>[number] = { id: 'site', match: [tweak.host], ...(tweak.subdomains ? { subdomains: true } : {}) }
      if (css.trim()) {
        files.set('tweaks/site.css', Buffer.from(`${css}\n`))
        entry.css = 'tweaks/site.css'
      }
      if (tweak.js.trim()) {
        files.set('tweaks/site.js', Buffer.from(`${tweak.js}\n`))
        entry.js = 'tweaks/site.js'
        manifest.permissions.pageScripts = true
      }
      if (!entry.css && !entry.js) throw new PackFileError(mainT('packs.error.emptyTweak'))
      manifest.contributes.tweaks = [entry]
      manifest.permissions.sites = tweak.subdomains ? [tweak.host, `*.${tweak.host}`] : [tweak.host]
    } else if (kind === 'app') {
      const apps = appStoreInstance()
      if (!apps?.has(itemId)) throw new PackFileError(mainT('packs.error.missingItem'))
      const app = apps.get(itemId)
      const id = slugifyPackId(app.name, draftTaken)
      manifest = baseManifest(id, app.name, app.description)
      // Pack pages run no inline code, so each inline script becomes a file next to the page.
      const { html, scripts } = moveInlineScripts(apps.html(itemId))
      files.set('panel/index.html', Buffer.from(html))
      for (const [name, code] of scripts) files.set(`panel/${name}`, Buffer.from(code))
      manifest.contributes.panels = [{ id: 'app', title: app.name.slice(0, 60), html: 'panel/index.html' }]
      manifest.contributes.commands = [{ id: 'open', title: mainT('packs.share.openApp', { name: app.name }).slice(0, 80), run: 'panel:app' }]
    } else {
      const text = deps.companionText(itemId)
      if (!text) throw new PackFileError(mainT('packs.error.missingItem'))
      const parsed = JSON.parse(text) as { name?: string; persona?: string }
      const name = parsed.name ?? 'companion'
      const id = slugifyPackId(name, draftTaken)
      manifest = baseManifest(id, name, mainT('packs.share.companionDescription', { name }))
      const path = `companions/${slugifyPackId(name, () => false)}.json`
      files.set(path, Buffer.from(text))
      manifest.contributes.companions = [path]
    }
    files.set(PACK_MANIFEST_FILE, manifestText(manifest))
    store.writeDraft(manifest.id, files)
    return manifest.id
  }

  // ---- updates and indexes ----

  const checkUpdate = async (pack: LoadedPack): Promise<void> => {
    const url = pack.manifest.updateUrl
    if (!url) return
    try {
      const archive = await downloadPack(url, doFetch)
      const { files, signature } = decodeArchive(archive)
      const check = validatePack(files)
      if (!check.ok) throw new PackFileError(check.problems[0] ?? 'invalid')
      const next = check.pack.manifest
      if (next.id !== pack.manifest.id || comparePackVersions(next.version, pack.manifest.version) <= 0) {
        store.setUpdate(pack.manifest.id, null)
        return
      }
      const valid = signature && verifyPackSignature(packHash(files), signature) ? signature : null
      const keyId = valid?.keyId ?? null
      const fingerprint = valid ? fingerprintOf(valid) : null
      if (deps.trusted.refusal(next.id, fingerprint)) throw new PackFileError(mainT('packs.problem.otherAuthor'))
      const added = [...permissionDiff(pack.manifest, next), ...(promptsKey(promptsOf(pack.manifest, pack.skills, pack.files)) !== promptsKey(promptsOf(next, check.pack.skills, files)) ? [promptsChangedLine()] : [])]
      if (added.length === 0) {
        // Nothing new to approve: it applies on its own, as it came.
        store.install(files, { source: pack.entry.source, signature: keyId ? 'signed' : 'unsigned', keyId, enable: pack.entry.enabled, signatureFile: valid })
        deps.trusted.pin(next.id, fingerprint)
        runtime.tools.reset(next.id)
        store.log(next.id, { level: 'info', source: 'atelier', message: `Updated to ${next.version}.` })
      } else {
        store.setUpdate(pack.manifest.id, { version: next.version, url, added })
      }
    } catch (err) {
      store.log(pack.manifest.id, { level: 'warn', source: 'atelier', message: `Update check failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const checkUpdates = async (): Promise<PackSummary[]> => {
    // The indexes first, so a pack one of them withdrew gets no update offered; only for people who installed from one,
    // so no one else's Atelier starts fetching an index in the background.
    if (store.all().some((p) => p.entry.source.kind === 'index')) await browse()
    for (const pack of store.all()) if (!pack.firstParty && !pack.entry.withdrawn && pack.manifest.updateUrl) await checkUpdate(pack)
    store.noteUpdateCheck()
    return store.all().map(summary)
  }

  // ---- the organisation's policy ----

  /** Addresses the policy installs from right now, so their review lets them in. */
  const forcing = new Set<string>()

  /**
   * Installs what the policy force-installs and isn't here yet (or is off):
   * downloaded, checked against its SHA-256 when the policy gives one, and
   * installed through the same review, signed or not as it came.
   */
  const applyPolicy = async (): Promise<string[]> => {
    const problems: string[] = []
    for (const forced of store.policy.forceInstall) {
      const have = store.all().find((p) => p.entry.source.url === forced.url)
      if (have) {
        if (!have.entry.enabled) store.setEnabled(have.manifest.id, true)
        continue
      }
      try {
        const archive = await downloadPack(forced.url, doFetch)
        if (forced.sha256 && sha256(archive) !== forced.sha256) throw new PackFileError(mainT('packs.error.hashMismatch'))
        forcing.add(forced.url)
        const review = reviewArchive(archive, { kind: 'link', url: forced.url })
        confirmInstall(review.token)
      } catch (err) {
        problems.push(`${forced.url}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        forcing.delete(forced.url)
      }
    }
    return problems
  }

  /** The indexes as last read, for their pictures. */
  const lastIndexes = new Map<string, PackIndexFile>()
  const images = new Map<string, string | null>()

  const browse = async (): Promise<PackIndexEntry[]> => {
    const out: PackIndexEntry[] = []
    const read: Array<{ name: string; index: PackIndexFile }> = []
    let failed = false
    for (const source of store.indexes()) {
      // A private index is read once someone is signed in to it; until then Browse offers Sign in.
      const auth = privateIndex(source.url)
      if (auth && !(await runtime.signIns.fresh(INDEX_SIGNINS, auth)).signedIn) continue
      try {
        const index = await fetchIndex(source.url, doFetch)
        lastIndexes.set(source.url, index)
        read.push({ name: index.name ?? source.name ?? source.url, index })
        if (source.lastError || source.name !== index.name) store.saveIndex({ ...source, name: index.name, lastError: null })
        for (const p of index.packs) {
          out.push({
            indexUrl: source.url,
            id: p.id,
            name: p.name,
            description: p.description,
            version: p.version,
            url: p.url,
            sha256: p.sha256,
            author: p.author ?? null,
            installedVersion: store.get(p.id)?.manifest.version ?? null,
            kind: p.kind,
            category: p.category ?? null,
            size: p.size ?? null,
            color: p.color ?? null,
            hasImage: Boolean(p.image),
          })
        }
      } catch (err) {
        failed = true
        const message = err instanceof Error ? err.message : String(err)
        // Refused: the sign-in no longer counts there (revoked, another account); Browse offers Sign in again.
        if (auth && /\b(401|403)\b/.test(message)) runtime.signIns.signOut(INDEX_SIGNINS, auth.id)
        store.saveIndex({ ...source, lastError: message })
      }
    }
    // Withdrawn ids: a notice on installed copies; it clears only once every index could be read and none lists it.
    for (const pack of store.all()) {
      if (pack.firstParty) continue
      const hit = read.flatMap(({ name, index }) => index.withdrawn.filter((w) => w.id === pack.manifest.id).map((w) => ({ index: name, reason: w.reason })))[0]
      if (hit) store.setWithdrawn(pack.manifest.id, hit)
      else if (!failed) store.setWithdrawn(pack.manifest.id, null)
    }
    return out
  }

  /** An index entry's picture, fetched once and kept as a data URL. */
  const browseImage = async (indexUrl: string, id: string): Promise<string | null> => {
    const url = lastIndexes.get(indexUrl)?.packs.find((p) => p.id === id)?.image
    if (!url) return null
    if (images.has(url)) return images.get(url) ?? null
    try {
      const image = await downloadImage(url, doFetch)
      const data = `data:${image.mediaType};base64,${image.data.toString('base64')}`
      images.set(url, data)
      return data
    } catch {
      images.set(url, null)
      return null
    }
  }

  /**
   * Opening something of a pack (an app, a panel, a world) is asking for it:
   * a pack that is off turns on first. What still keeps it from running is
   * said plainly: its problems, the organisation's policy, what it waits for.
   */
  const prepareOpen = (id: string): void => {
    const pack = store.require(id)
    if (pack.problems.length > 0) throw new PackFileError(pack.problems[0] as string)
    const refusal = store.policyRefusal(id)
    if (refusal) throw new PackFileError(refusal)
    if (!pack.entry.enabled) store.setEnabled(id, true)
    runtime.allowAskingAgain(id)
    if (!runtime.isRunning(id)) {
      const waiting = runtime.waiting(id).map(waitText)
      throw new PackFileError(waiting.length > 0 ? mainT('packs.error.waiting', { name: pack.manifest.name, what: waiting.join(', ') }) : mainT('packs.error.off'))
    }
  }

  /** A world opens in the Worlds app: both its pack and Worlds turn on if they are off. */
  const prepareWorld = (ref: string): void => {
    const at = parseWorldRef(ref)
    if (!at) throw new PackFileError(mainT('packs.error.worldGone'))
    if (at.kind === 'pack') {
      if (!store.get(at.packId)) throw new PackFileError(mainT('packs.error.worldGone'))
      prepareOpen(at.packId)
    }
    prepareOpen(WORLDS_PACK_ID)
    if (!runtime.worldDoc(ref)) throw new PackFileError(mainT('packs.error.worldGone'))
  }

  const need = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new PackFileError(what)
    return value
  }

  const packs: Omit<Ns, 'openedReview'> & ReturnType<typeof extras> = {
    state: stateNow,
    get(id): PackDetail {
      const pack = store.require(id)
      return { ...summary(pack), manifest: pack.manifest, files: store.fileSizes(id).sort((a, b) => a.path.localeCompare(b.path)), log: store.logLines(id) }
    },
    setEnabled(id, enabled) {
      if (!enabled && store.isForced(id)) throw new PackFileError(mainT('packs.error.managed'))
      runtime.allowAskingAgain(id)
      return summary(store.setEnabled(id, enabled))
    },
    remove(id) {
      if (store.isForced(id)) throw new PackFileError(mainT('packs.error.managed'))
      store.remove(id)
      deps.trusted.forget(id)
      runtime.tools.reset(id)
      void runtime.sandbox.clear(id)
    },
    // Window-scoped (they need a dialog); the feature's window() part fills these.
    reviewFile: async () => null,
    loadFolder: async () => null,
    async reviewLink(url) {
      try {
        return reviewArchive(await downloadPack(url, doFetch), { kind: 'link', url })
      } catch (err) {
        if (err instanceof PackDownloadError || err instanceof PackFileError) throw err
        throw new PackFileError(err instanceof Error ? err.message : String(err))
      }
    },
    reviewDraft(id) {
      const d = store.draft(id)
      return makeReview(need(d.files, mainT('packs.error.missingDraft')), { kind: 'draft' }, null, true)
    },
    async reviewIndexEntry(indexUrl, id) {
      const index = await fetchIndex(indexUrl, doFetch)
      const entry = need(
        index.packs.find((p) => p.id === id),
        mainT('packs.error.notInIndex'),
      )
      const archive = await downloadPack(entry.url, doFetch)
      if (sha256(archive) !== entry.sha256) throw new PackFileError(mainT('packs.error.hashMismatch'))
      return reviewArchive(archive, { kind: 'index', url: indexUrl })
    },
    async reviewUpdate(id) {
      const pack = store.require(id)
      const url = need(pack.entry.update?.url ?? pack.manifest.updateUrl, mainT('packs.error.noUpdate'))
      return reviewArchive(await downloadPack(url, doFetch), pack.entry.source.kind === 'index' ? pack.entry.source : { kind: 'link', url })
    },
    confirmInstall,
    cancelReview(token) {
      reviews.delete(token)
    },
    exportPack: async () => null,
    remix(id, companionId) {
      const pack = store.require(id)
      if (pack.problems.length > 0) throw new PackFileError(mainT('packs.error.problemsRemix'))
      const own = Boolean(pack.entry.keyId && pack.entry.keyId === deps.author.keyId()) || pack.entry.source.kind === 'draft'
      // Your own pack keeps its id (the draft replaces it); anyone else's becomes a pack of yours.
      const newId = own ? id : slugifyPackId(`${id.slice(0, 22)}-remix`, draftTaken)
      if (own && store.hasDraft(id)) return startEditChat(id, pack.manifest.name, companionId)
      const manifest: PackManifest = {
        ...pack.manifest,
        id: newId,
        version: own ? bumpPackVersion(pack.manifest.version) : '1.0.0',
        ...(own ? {} : { forkedFrom: { id, version: pack.manifest.version, hash: pack.entry.hash } }),
      }
      if (!own) {
        delete manifest.updateUrl
        delete manifest.author
      }
      const files: PackFiles = new Map(store.allFiles(id))
      files.set(PACK_MANIFEST_FILE, manifestText(manifest))
      store.writeDraft(newId, files)
      return startEditChat(newId, manifest.name, companionId)
    },
    startBuild(description, companionId) {
      return deps.app.agent.startChat(mainT('packs.build.message', { description: description.trim() }), { ...(companionId ? { companionId } : {}), context: BUILD_CONTEXT, open: 'page', creator: true })
    },
    editDraft(id, companionId) {
      const d = store.draft(id)
      if (!store.hasDraft(id)) throw new PackFileError(mainT('packs.error.missingDraft'))
      const builtIn = store.draftChat(id)
      if (builtIn && !companionId) {
        try {
          deps.app.agent.view(builtIn)
          const win = deps.app.windows.focused() ?? deps.app.windows.all()[0]
          win?.tabs.openInternal(chatUrl(builtIn), { newTab: true })
          return builtIn
        } catch {
          // That chat is gone: a new one picks the draft up.
        }
      }
      return startEditChat(id, d.manifest?.name ?? id, companionId)
    },
    removeDraft(id) {
      store.removeDraft(id)
      runtime.endTestRun(id)
    },
    revealDraft: () => undefined,
    openPanel(id, panelId, beside) {
      prepareOpen(id)
      runtime.openPanel(id, panelId, null, beside === true)
    },
    openApp: (id, appId) => {
      prepareOpen(id)
      runtime.openApp(id, appId, null)
    },
    openWorld(ref) {
      prepareWorld(ref)
      runtime.openApp(WORLDS_PACK_ID, 'main', null, `world=${encodeURIComponent(ref)}`)
    },
    appStill: (id, appId) => runtime.appStill(id, appId),
    chooseAssets(id, appId, slot, choice) {
      const pack = store.require(id)
      const app = (pack.manifest.contributes.apps ?? []).find((a) => a.id === appId)
      if (!app?.assets?.some((s) => s.id === slot)) throw new PackFileError(mainT('packs.error.noApp'))
      if (choice && !runtime.assetOptions(id, appId, slot).some((o) => o.value === choice)) throw new PackFileError(mainT('packs.error.off'))
      store.setAssetChoice(id, slot, choice)
      // The app loads its art again from the new set.
      runtime.reloadPages(id)
      return summary(store.require(id))
    },
    reloadFolder(id) {
      return summary(store.reloadLinked(id))
    },
    setSecret(id, secretId, value) {
      const pack = store.require(id)
      const secret = need(pack.manifest.secrets?.find((k) => k.id === secretId), mainT('packs.error.missingItem'))
      const key = value.trim()
      // It goes in a request header: one line, no control characters.
      if (!key || key.length > PACK_SECRET_LIMITS.valueChars || /[\u0000-\u001f\u007f]/.test(key)) throw new PackFileError(mainT('packs.error.secretBad'))
      try {
        store.secrets.set(id, secret.id, key)
      } catch (err) {
        if (err instanceof SecretsUnavailable) throw new PackFileError(mainT('packs.error.secretKeychain'))
        throw err
      }
      store.log(id, { level: 'info', source: 'atelier', message: `You entered ${secret.name} (${secret.id}).` })
      runtime.secretChanged(id, secret.id)
      return summary(store.require(id))
    },
    async signIn(id, authId) {
      const pack = store.require(id)
      need(pack.manifest.auth?.find((a) => a.id === authId), mainT('packs.error.missingItem'))
      if (!runtime.isRunning(id)) throw new PackFileError(mainT('packs.error.signInGone'))
      try {
        await runtime.signIn(id, authId)
      } catch (err) {
        if (err instanceof SecretsUnavailable) throw new PackFileError(mainT('packs.error.secretKeychain'))
        throw new PackFileError(mainT('packs.error.signIn', { reason: err instanceof Error ? err.message : String(err) }))
      }
      return summary(store.require(id))
    },
    signOut(id, authId) {
      const pack = store.require(id)
      need(pack.manifest.auth?.find((a) => a.id === authId), mainT('packs.error.missingItem'))
      runtime.signOut(id, authId)
      return summary(store.require(id))
    },
    clearSecret(id, secretId) {
      const pack = store.require(id)
      const secret = need(pack.manifest.secrets?.find((k) => k.id === secretId), mainT('packs.error.missingItem'))
      store.secrets.clear(id, secret.id)
      store.log(id, { level: 'info', source: 'atelier', message: `You removed ${secret.name} (${secret.id}).` })
      runtime.secretChanged(id, secret.id)
      return summary(store.require(id))
    },
    revokeGranted(id) {
      store.require(id)
      store.setGranted(id, null)
      store.setFolder(id, null)
      return summary(store.require(id))
    },
    sidebar: () => runtime.sidebar(),
    items: () => runtime.items(),
    cards: () => runtime.cards(),
    openCard: (id, cardId) => runtime.openCard(id, cardId),
    addRoutine(id, templateId) {
      const pack = store.require(id)
      const t = need(
        (pack.manifest.contributes.routines ?? []).find((r) => r.id === templateId),
        mainT('packs.error.missingItem'),
      )
      const services = need(deps.services(), mainT('packs.error.notReady'))
      services.routines.save({ name: t.name, prompt: t.prompt, schedule: t.schedule, enabled: false })
    },
    async addCompanion(id, path) {
      const pack = store.require(id)
      if (!(pack.manifest.contributes.companions ?? []).includes(path)) throw new PackFileError(mainT('packs.error.missingItem'))
      const services = need(deps.services(), mainT('packs.error.notReady'))
      const text = need(pack.files.get(path), mainT('packs.error.missingItem')).toString('utf8')
      const preview = services.companions.previewImport(text)
      return services.companions.confirmImport(preview.token).name
    },
    addConnector(id, connectorId) {
      const pack = store.require(id)
      const conn = need(
        (pack.manifest.contributes.connectors ?? []).find((c) => c.id === connectorId),
        mainT('packs.error.missingItem'),
      )
      const services = need(deps.services(), mainT('packs.error.notReady'))
      return services.connectors.save({
        name: conn.name.slice(0, 48),
        source: 'custom',
        transport: conn.url ? { kind: 'remote', url: conn.url } : { kind: 'local', command: conn.command ?? '', args: conn.args ?? [], env: [] },
        auth: 'none',
        enabled: true,
      }).id
    },
    checkUpdates,
    async addIndex(url) {
      if (store.policy.indexes) throw new PackFileError(mainT('packs.policy.indexesLocked'))
      const index = await fetchIndex(url, doFetch)
      const source = { url, name: index.name, addedAt: now(), lastError: null }
      store.saveIndex(source)
      return source
    },
    removeIndex(url) {
      if (store.policy.indexes) throw new PackFileError(mainT('packs.policy.indexesLocked'))
      store.removeIndex(url)
    },
    browse,
    browseImage,
    async signInIndex(url) {
      const auth = need(privateIndex(url), mainT('packs.error.signInGone'))
      try {
        await runtime.signInIndex(auth)
      } catch (err) {
        if (err instanceof SecretsUnavailable) throw new PackFileError(mainT('packs.error.secretKeychain'))
        throw new PackFileError(mainT('packs.error.signIn', { reason: err instanceof Error ? err.message : String(err) }))
      }
      const source = store.indexes().find((i) => i.url === url)
      if (source?.lastError) store.saveIndex({ ...source, lastError: null })
      return stateNow()
    },
    findInBrowse(id) {
      const win = deps.app.windows.focused() ?? deps.app.windows.all()[0]
      win?.tabs.openInternal(packsPageUrl({ tab: 'browse', find: id }), { newTab: true })
    },
    clearLog(id) {
      if (store.policy.audit) throw new PackFileError(mainT('packs.policy.auditLog'))
      store.clearLog(id)
    },
    saveLog: async () => null,
    shareAs,
    ...extras(),
  }

  function extras() {
    return {
      stateNow,
      summary: (id: string) => summary(store.require(id)),
      reviewArchive,
      reviewFolder,
      exportArchive,
      exportWorld,
      applyPolicy,
      prepareOpen,
      prepareWorld,
      async checkUpdatesIfDue() {
        const last = store.lastUpdateCheck() ?? 0
        if (now() - last < 24 * 60 * 60_000) return
        await checkUpdates()
      },
    }
  }

  function startEditChat(id: string, name: string, companionId?: string): string {
    return deps.app.agent.startChat(mainT('packs.remix.message', { name }), { ...(companionId ? { companionId } : {}), context: `${BUILD_CONTEXT}\n\nThe draft to edit is "${id}". Start with read_pack_file("${id}", "${PACK_MANIFEST_FILE}") and ask what to change if the person hasn't said.`, open: 'page', creator: true })
  }

  return packs
}

/** An app's HTML with every inline <script> moved to script-<n>.js, for a pack page's CSP. Inline on* handlers stay and won't run. */
export function moveInlineScripts(html: string): { html: string; scripts: Map<string, string> } {
  const scripts = new Map<string, string>()
  const out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs: string, body: string) => {
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) return whole
    const name = `script-${scripts.size + 1}.js`
    scripts.set(name, `${body.trim()}\n`)
    return `<script${attrs} src="${name}"></script>`
  })
  return { html: out, scripts }
}

/** What a pack tells the assistant: each skill's instructions and steps, each tool's description, and each companion it offers. */
export function promptsOf(m: PackManifest, skills: readonly PackSkillFile[], files: PackFiles): PackReview['prompts'] {
  return [
    ...skills.map((s) => ({ kind: 'skill' as const, name: `/${s.doc.name}`, text: [s.doc.description, s.doc.instructions, ...s.doc.steps.map((st) => `${st.title}\n${st.instructions}`)].filter(Boolean).join('\n\n') })),
    ...(m.contributes.tools ?? []).map((t) => ({ kind: 'tool' as const, name: t.name, text: t.description })),
    ...(m.contributes.companions ?? []).flatMap((path) => companionPrompt(files.get(path)) ?? []),
  ]
}

/** A companion file's standing instructions, skills and routine prompts as one text: what it tells the assistant once added. */
function companionPrompt(data: Buffer | undefined): PackReview['prompts'][number] | null {
  if (!data) return null
  let file: ReturnType<typeof parseCompanionFile>
  try {
    file = parseCompanionFile(data.toString('utf8'))
  } catch {
    return null
  }
  const sections = [
    file.instructions.trim() ? `${mainT('packs.review.companionInstructions')}\n${file.instructions.trim()}` : '',
    ...(file.skills ?? []).map((s) => [mainT('packs.review.companionSkill', { name: s.name }), [s.description.trim(), skillReviewText(s)].filter(Boolean).join('\n\n')].join('\n')),
    ...(file.routines ?? []).map((r) => `${mainT('packs.review.companionRoutine', { name: r.name })}\n${r.prompt.trim()}`),
  ]
  return { kind: 'companion', name: file.name, text: sections.filter(Boolean).join('\n\n') }
}

const promptsKey = (prompts: PackReview['prompts']): string => JSON.stringify([...prompts].sort((a, b) => `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`)))

function companionName(data: Buffer | undefined): string | null {
  if (!data) return null
  try {
    const name = (JSON.parse(data.toString('utf8')) as { name?: unknown }).name
    return typeof name === 'string' ? name.slice(0, 80) : null
  } catch {
    return null
  }
}

/** Model-facing rules for building a pack (docs/packs.md is the full spec). */
export const BUILD_CONTEXT = [
  `You are building a pack for ${BRAND_NAME} for the person with the pack tools: create_pack, write_pack_file, read_pack_file, test_pack, propose_pack and list_packs. Call atelier_inspect first: it lists what window.atelier offers now, the surfaces, and the services and events of the packs that are running. Build only on what it lists as available.`,
  'A pack is a folder with atelier-pack.json (format "atelier-pack", manifestVersion 1, or 2 for a pack with apps; id, name, version, description, contributes, permissions) and its files.',
  `What a pack can contribute: skills (folders with SKILL.md: YAML front matter with name and description, then instructions), routines (templates: id, name, prompt, schedule), tweaks (id, match hosts, css and/or js files), themes (id, name, accent #rrggbb), companions (.ateliercompanion JSON, no memory; a companion's own skills go in its file's skills, [{ name, description, instructions, steps?, files? }], so only that companion gets them, while skills in contributes.skills go to every companion), connectors (id, name, and a remote MCP url or a local command), panels (id, title, html file; sidebar: true adds a sidebar row that opens it beside the page; icon: a .png or .svg up to 64 KB), apps (id, name, root: its folder, default "app", entry: its page inside root, default "index.html", build "kit" or "bundled", kind "game" or "tool", optional icon and sidebar: true), cards for the new tab page (id, title, module, open: a run; the module exports async function run() and returns a string or up to 5 short lines, which ${BRAND_NAME} draws), commands (id, title, run) and menus (id, title, context page|selection|link, run). A run is skill:<name>, panel:<id>, app:<id> or tool:<name>.`,
  `Apps (games and bigger tools in a tab) and packs that work together (services, events) have their own guide parts: call atelier_inspect({ guide: "apps" }) first when the person asks for an app, and "design" for how it should look (${BRAND_NAME} UI), then the parts it needs (kit, cast, ai, servers, local-server for a web server of the app’s own (phones as controllers), worlds, services, files, assets, notifications, sharing). A key never goes in a pack’s files: the servers part says how the person enters theirs. For an app, start from a starter with create_pack({ starter }) and verify it with test_pack({ playtest }) before you propose it.`,
  'Tools: { name, description, inputSchema (JSON Schema object), module (a .js file) }. The module exports async function run(input, ctx) and returns a string or JSON. Panels and tools run sandboxed with no network of their own; they call window.atelier: atelier.storage.get/set/remove/keys, atelier.page.info() / text() / query(selector) (only on hosts in permissions.sites), atelier.fetch(url, init) (only to hosts in permissions.network), atelier.notify({title, body}) (permissions.notifications), atelier.ask(prompt, {system}) (permissions.model), atelier.clipboard.write(text) (permissions.clipboard), atelier.open(url) and atelier.log(...).',
  'Permissions: { sites: [], network: [], pageScripts: false, notifications: false, model: false, clipboard: false }. Ask for the least the pack needs: every tweak host must be in sites, a tweak with js needs pageScripts, and only panels and tools may use network, model, notifications or clipboard. Reading sites together with any network host is shown to the person as a serious warning, so avoid it unless the pack truly needs it.',
  'Write plain, readable JavaScript modules: no npm packages, no bundlers, no minified code, no TypeScript. Use only relative imports inside the pack. Pack pages run no inline code: put every script in a .js file (<script type="module" src="panel.js">) and attach handlers with addEventListener, never onclick="…". Panels follow prefers-color-scheme for light and dark, work with the keyboard, and label their controls. Scripts, pages and SVG together stay under 1 MB.',
  'atelier.open(url) only opens addresses on hosts in permissions.network. In test_pack, atelier.fetch reaches only localhost and hosts an installed version of the same pack may already use, atelier.ask returns a stand-in answer unless the installed version may ask the model, and test pages open signed out (no cookies).',
  `Limits: ${PACK_LIMITS.files} files, ${PACK_LIMITS.fileBytes / 1024 / 1024} MB per file, ${PACK_LIMITS.packBytes / 1024 / 1024} MB per pack; a pack with an app may hold ${APP_PACK_LIMITS.files} files, ${APP_PACK_LIMITS.fileBytes / 1024 / 1024} MB per file and ${APP_PACK_LIMITS.packBytes / 1024 / 1024} MB in all. Ids: ${PACK_ID_PATTERN.source}.`,
  `For a working example, call read_pack_file on the draft after create_pack, or ask list_packs: the "${'atelier-example-reading-time'}" pack that comes with ${BRAND_NAME} has a skill, a panel, a command and a tool.`,
  'Work in steps: create_pack, write the files, then test_pack (fix every problem it reports and run each tool once), then propose_pack. You can never install or turn on a pack yourself: the person reviews the permissions in the card and installs it. Say in two or three sentences what the pack does and what it asks for.',
  `Built-in skills are a pack too ("${BUILTIN_SKILLS_PACK_ID}"); it can't be changed.`,
].join('\n')

/** The bytes in a folder, counted up to 20,000 entries (the person's own files a pack keeps). */
function folderBytes(dir: string): number {
  let total = 0
  let seen = 0
  const walk = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      if (++seen > 20_000) return
      const full = join(d, n)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else total += st.size
      } catch {
        // Gone since the listing.
      }
    }
  }
  walk(dir)
  return total
}
