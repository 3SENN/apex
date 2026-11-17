/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Packs in main (docs/packs.md): the store, the runtime (sandbox, bridge,
// tool host, contribution sync), the service and the builder tools. The
// services that need a window (file pickers, Reveal in Finder, panels in this
// window) come from window(); index.ts binds the merged services and the
// companion exporter once every feature has started.
import { randomUUID } from 'node:crypto'
import { registerMenuContribution } from '@shared/menuModel'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app as electronApp, dialog, safeStorage, shell, type Session } from 'electron'
import { APP_PACK_LIMITS, DEFAULT_PACK_INDEXES, PACK_APP_FILE_EXTENSION, PACK_ARCHIVE_EXTENSIONS, PACK_FILE_EXTENSION, PACK_MANIFEST_FILE, PACK_WORLD_FILE_EXTENSION, packsPageUrl, type PacksServices } from '@shared/packs'
import { WORLDS_PACK_ID } from '@shared/worlds'
import type { Services } from '@shared/services'
import type { AppContext, Feature, ServiceParts, SessionInfo } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { registerResetStep } from '../reset'
import { registerStorageCategory } from '../storage'
import { pathSize } from '../coreStorage'
import { registerPackAgentTools } from './agentTools'
import { DevLinks } from './devLinks'
import type { CastSource } from './runtime'
import { registerPackBuilderTools } from './builder'
import { PackFileError } from './files'
import { readPolicy } from './policy'
import { firstPartyPacks } from './firstParty'
import { PacksRuntime } from './runtime'
import { createPacksService } from './service'
import { AuthorKey, TrustedKeys, type KeyVault } from './signing'
import type { SecretCipher } from './secrets'
import { createServerIndicator } from './serverBar'
import { PACK_SECRETS_FILE, PACK_SIGNINS_FILE, PackStore } from './store'

type Ns = PacksServices['packs']

interface Binding {
  services: Services | null
  installSession: ((session: Session, info: SessionInfo) => void) | null
  companionText(id: string): string | null
  companionName(id: string): string | null
  /** The companions an app may cast (docs/apps.md › The cast): visible ones, with what speak needs; never memory. */
  cast: CastSource | null
}

let bound: Binding = { services: null, installSession: null, companionText: () => null, companionName: () => null, cast: null }
let afterBind: (() => void) | null = null
let current: { store: PackStore; runtime: PacksRuntime; service: ReturnType<typeof createPacksService>; serverBar: ReturnType<typeof createServerIndicator> } | null = null

/** index.ts calls this once the services are merged: pack companions, connectors and routines go through them, and pack partitions get the webRequest mux. */
export function bindPacks(binding: Partial<Binding>): void {
  bound = { ...bound, ...binding }
  afterBind?.()
}

const opened = new Map<string, import('@shared/packs').PackReview | { error: string }>()

/** A double-clicked .atelierpack or .atelierapp: its review, shown on atelier://packs in this window. */
export function openPackFile(path: string, win: import('../features/types').WindowContext | null): void {
  if (!current || !win) return
  let token: string
  try {
    if (statSync(path).size > APP_PACK_LIMITS.packBytes + 1024 * 1024) throw new PackFileError(mainT('packs.error.tooBig'))
    const review = current.service.reviewArchive(readFileSync(path), { kind: 'file' })
    opened.set(review.token, review)
    token = review.token
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('packs', 'An opened pack file could not be read', { error: message })
    // The page says what went wrong with which file, rather than opening on nothing.
    token = randomUUID()
    opened.set(token, { error: mainT('packs.error.openFile', { name: basename(path), reason: message }) })
  }
  win.tabs.openInternal(`${packsPageUrl()}?opened=${token}`, { newTab: true })
}

/** The running packs (smoke checks); null before start-up. */
export function packsRuntime(): typeof current {
  return current
}

function keyVault(smoke: boolean): KeyVault {
  return {
    encrypt(plain) {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain.toString('base64'))
      if (smoke) return Buffer.from(plain.toString('base64'))
      throw new PackFileError(mainT('packs.error.keychain'))
    },
    decrypt(sealed) {
      if (safeStorage.isEncryptionAvailable()) return Buffer.from(safeStorage.decryptString(sealed), 'base64')
      if (smoke) return Buffer.from(sealed.toString('utf8'), 'base64')
      throw new PackFileError(mainT('packs.error.keychain'))
    },
  }
}

/** The keys people enter for packs' secrets (docs/apps.md › Keys): the system keychain, or in a smoke run (a throwaway profile) plain text. */
function secretCipher(smoke: boolean): SecretCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable() || smoke,
    encrypt: (text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')),
    decrypt: (data) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8')),
  }
}

export function createPacksFeature(): Feature {
  const stops: Array<() => void> = []

  return {
    name: 'packs',
    app(app: AppContext): ServiceParts {
      // The community index comes with Atelier, but never into a smoke run, which reaches nothing outside the machine.
      const store = new PackStore(app.dataDir, { firstParty: firstPartyPacks(), cipher: secretCipher(app.smoke), ...(app.smoke ? {} : { defaultIndexes: DEFAULT_PACK_INDEXES }) })
      const author = new AuthorKey(store.root, keyVault(app.smoke))
      const trusted = new TrustedKeys(store.root)
      const serverBar = createServerIndicator(app)
      const runtime = new PacksRuntime({ store, app, preload: join(__dirname, '../preload/pack.js'), installSession: () => bound.installSession, cast: () => bound.cast, serverIndicator: serverBar })
      const service = createPacksService({ store, runtime, author, trusted, app, services: () => bound.services, companionText: (id) => bound.companionText(id) })
      current = { store, runtime, service, serverBar }
      // Worlds: Share… in the viewer saves an .atelierworld, a signed pack holding just the world.
      runtime.worldShare = async (ref, contents) => {
        const { name, data } = service.exportWorld(ref)
        let target: string | null
        if (app.smoke) target = join(mkdtempSync(join(tmpdir(), 'atelier-smoke-worlds-')), name)
        else {
          const owner = app.windows.fromWebContents(contents.id)?.window ?? app.windows.focused()?.window
          const options = { defaultPath: join(electronApp.getPath('downloads'), name), filters: [{ name: mainT('packs.file.worldFilter'), extensions: [PACK_WORLD_FILE_EXTENSION] }] }
          const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
          target = picked.canceled || !picked.filePath ? null : picked.filePath
        }
        if (!target) return null
        writeFileSync(target, data)
        return target
      }
      registerPackAgentTools({ store, runtime })
      registerPackBuilderTools({
        store,
        runtime,
        app,
        companionName: (id) => bound.companionName(id),
        isOwn: (id) => {
          const pack = store.get(id)
          return Boolean(pack && (pack.entry.source.kind === 'draft' || (pack.entry.keyId && pack.entry.keyId === author.keyId())))
        },
      })

      let pending: ReturnType<typeof setTimeout> | null = null
      const publish = (): void => {
        if (pending) clearTimeout(pending)
        pending = setTimeout(() => {
          pending = null
          try {
            app.broadcast({ type: 'packs', state: service.stateNow() })
          } catch (err) {
            log.warn('packs', 'Publishing the packs state failed', { error: err instanceof Error ? err.message : String(err) })
          }
        }, 150)
      }
      // Developer mode: a linked folder reloads on change, and its open tabs and tool host with it.
      const devLinks = new DevLinks(store, (id) => {
        runtime.tools.reset(id)
        runtime.reloadPages(id)
      })
      stops.push(() => devLinks.dispose())
      const onChanged = (): void => {
        runtime.sync()
        devLinks.sync()
        publish()
      }
      store.on('changed', onChanged)
      store.on('log', publish)
      stops.push(() => store.off('changed', onChanged), () => store.off('log', publish))
      runtime.sync()
      afterBind = () => runtime.sync()
      // The organisation's policy, read in the background (never in the way of start-up); nothing happens without one.
      void readPolicy({ smoke: app.smoke })
        .then(async ({ policy, problems }) => {
          for (const p of problems) log.warn('packs', 'An organisation policy value was ignored', { problem: p })
          if (!policy.managed) return
          store.setPolicy(policy)
          for (const p of await service.applyPolicy()) log.warn('packs', 'A pack the policy installs could not be installed', { problem: p })
        })
        .catch((err: unknown) => log.warn('packs', 'The organisation policy could not be applied', { error: err instanceof Error ? err.message : String(err) }))

      // Settings › Your data and Reset Atelier: the packs folder (your author key only with the secrets).
      const removePacks = async (dryRun: boolean, secrets: boolean): Promise<{ removed: string[] }> => {
        const { readdirSync, rmSync, existsSync } = await import('node:fs')
        if (!existsSync(store.root)) return { removed: [] }
        const isSecret = (n: string): boolean => n === 'author-key.json' || n === PACK_SECRETS_FILE || n === PACK_SIGNINS_FILE
        const names = readdirSync(store.root).filter((n) => (secrets ? isSecret(n) : !isSecret(n)))
        if (!dryRun) {
          for (const n of names) rmSync(join(store.root, n), { recursive: true, force: true })
          for (const p of store.all()) if (!p.firstParty) void runtime.sandbox.clear(p.manifest.id)
        }
        if (!dryRun && secrets) {
          store.secrets.reload()
          store.signInFile.reload()
        }
        return { removed: names.map((n) => join('packs', n)) }
      }
      // AP-02: the Packs page from the menus: the main menu's tools, and the menu bar's Extensions menu after the Web Store's rows.
      const openPacks = (itemId: string, windowId: number | null): void => {
        const win = (windowId !== null ? app.windows.get(windowId) : null) ?? app.windows.focused() ?? app.windows.all()[0]
        win?.tabs.openInternal(itemId === 'packs-browse' ? packsPageUrl({ tab: 'browse' }) : packsPageUrl())
      }
      stops.push(
        registerMenuContribution({ id: 'p-packs-main', target: 'main-menu:tools', build: () => [{ id: 'packs-open', label: mainT('packs.menu.entry'), icon: 'package' }], run: openPacks }),
        registerMenuContribution({
          id: 'p-packs-menu',
          target: 'extensions',
          build: () => [
            { id: 'packs-sep', label: '', type: 'separator' },
            { id: 'packs-open', label: mainT('packs.menu.manage') },
            { id: 'packs-browse', label: mainT('packs.menu.browse') },
          ],
          run: openPacks,
        }),
      )
      stops.push(
        registerStorageCategory({ id: 'packs', label: mainT('packs.storage.label'), order: 65, measure: () => pathSize(store.root) }),
        registerResetStep({ id: 'packs', order: 45, label: mainT('packs.storage.reset'), run: ({ dryRun }) => removePacks(dryRun, false) }),
        registerResetStep({ id: 'packs-author-key', order: 46, label: mainT('packs.storage.resetKey'), secrets: true, run: ({ dryRun }) => removePacks(dryRun, true) }),
      )

      if (!app.smoke) {
        // Updates: once a day while Atelier runs, the first look a minute after start.
        const check = (): void => void service.checkUpdatesIfDue().catch((err: unknown) => log.warn('packs', 'Update check failed', { error: err instanceof Error ? err.message : String(err) }))
        const first = setTimeout(check, 60_000)
        const every = setInterval(check, 6 * 60 * 60_000)
        first.unref?.()
        every.unref?.()
        stops.push(() => clearTimeout(first), () => clearInterval(every))
      }

      const { stateNow: _s, summary: _m, reviewArchive: _r, exportArchive: _e, checkUpdatesIfDue: _c, ...methods } = service
      const openedReview: Ns['openedReview'] = (token) => {
        const review = opened.get(token) ?? null
        opened.delete(token)
        if (review && 'error' in review) throw new PackFileError(review.error)
        return review
      }
      return { packs: { ...methods, openedReview } satisfies Ns }
    },
    window(win): ServiceParts {
      const exportDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-smoke-packs-'))
      const need = (): NonNullable<typeof current> => {
        if (!current) throw new PackFileError(mainT('packs.error.notReady'))
        return current
      }
      const packs: Partial<Ns> = {
        async reviewFile() {
          const { service } = need()
          const smokeFile = process.env.ATELIER_SMOKE_PACK_FILE
          let file: string | null = null
          if (smokeFile && need().runtime && process.env.ATELIER_SMOKE) file = smokeFile
          else {
            const picked = await dialog.showOpenDialog(win.window, { properties: ['openFile'], filters: [{ name: mainT('packs.file.filter'), extensions: [...PACK_ARCHIVE_EXTENSIONS] }] })
            file = picked.canceled ? null : (picked.filePaths[0] ?? null)
          }
          if (!file) return null
          if (statSync(file).size > APP_PACK_LIMITS.packBytes + 1024 * 1024) throw new PackFileError(mainT('packs.error.tooBig'))
          return service.reviewArchive(readFileSync(file), { kind: 'file' })
        },
        async loadFolder() {
          const { service } = need()
          const smokeFolder = process.env.ATELIER_SMOKE_PACK_FOLDER
          let dir: string | null = null
          if (smokeFolder && process.env.ATELIER_SMOKE) dir = smokeFolder
          else {
            const picked = await dialog.showOpenDialog(win.window, { properties: ['openDirectory'], title: mainT('packs.devFolder.pick') })
            dir = picked.canceled ? null : (picked.filePaths[0] ?? null)
          }
          return dir ? service.reviewFolder(dir) : null
        },
        async exportPack(id, from, share) {
          const { service } = need()
          const image = share?.image ? Buffer.from(share.image.slice(share.image.indexOf(',') + 1), 'base64') : null
          const { name, data } = service.exportArchive(id, from, share ? { note: share.note?.trim() || null, image } : null)
          let target: string | null
          if (process.env.ATELIER_SMOKE) target = join(exportDir(), name)
          else {
            const picked = await dialog.showSaveDialog(win.window, { defaultPath: join(electronApp.getPath('downloads'), name), filters: [{ name: mainT('packs.file.filter'), extensions: [[PACK_APP_FILE_EXTENSION, PACK_WORLD_FILE_EXTENSION].find((ext) => name.endsWith(`.${ext}`)) ?? PACK_FILE_EXTENSION] }] })
            target = picked.canceled || !picked.filePath ? null : picked.filePath
          }
          if (!target) return null
          writeFileSync(target, data)
          // The share image goes beside the file too, as companion Export does, for posting where the file is shared.
          if (image) {
            try {
              writeFileSync(target.replace(/\.[^./\\]+$/, '') + '.png', image)
            } catch (err) {
              log.warn('packs', 'The share image could not be saved beside the pack', { error: err instanceof Error ? err.message : String(err) })
            }
          }
          return target
        },
        async saveLog(id) {
          const { store } = need()
          const pack = store.require(id)
          const name = `${pack.manifest.id}-log.jsonl`
          const lines = store.logLines(id).map((l) => JSON.stringify(l)).join('\n')
          let target: string | null
          if (process.env.ATELIER_SMOKE) target = join(mkdtempSync(join(tmpdir(), 'atelier-smoke-log-')), name)
          else {
            const picked = await dialog.showSaveDialog(win.window, { defaultPath: join(electronApp.getPath('downloads'), name), filters: [{ name: mainT('packs.file.logFilter'), extensions: ['jsonl'] }] })
            target = picked.canceled || !picked.filePath ? null : picked.filePath
          }
          if (!target) return null
          writeFileSync(target, lines ? `${lines}\n` : '')
          return target
        },
        revealDraft(id) {
          const { store } = need()
          if (!store.hasDraft(id)) throw new PackFileError(mainT('packs.error.missingDraft'))
          shell.showItemInFolder(join(store.draftDir(id), PACK_MANIFEST_FILE))
        },
        openPanel(id, panelId, beside) {
          const { service, runtime } = need()
          service.prepareOpen(id)
          runtime.openPanel(id, panelId, win, beside === true)
        },
        openApp: (id, appId) => {
          const { service, runtime } = need()
          service.prepareOpen(id)
          runtime.openApp(id, appId, win)
        },
        openWorld(ref) {
          const { service, runtime } = need()
          service.prepareWorld(ref)
          runtime.openApp(WORLDS_PACK_ID, 'main', win, `world=${encodeURIComponent(ref)}`)
        },
        openCard: (id, cardId) => need().runtime.openCard(id, cardId, win),
      }
      // A sleeping pack tab wakes in a fresh view: it needs its sandbox rules again.
      win.tabs.on('view-replaced', (tab) => current?.runtime.hardenTab(tab))
      return { packs }
    },
    tab(tab) {
      current?.runtime.hardenTab(tab)
    },
    dispose() {
      for (const stop of stops.splice(0)) {
        try {
          stop()
        } catch {
          // Already gone.
        }
      }
      current?.runtime.dispose()
      current = null
      afterBind = null
    },
  }
}
