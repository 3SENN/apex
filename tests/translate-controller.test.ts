/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { TRANSLATE_DEFAULTS, type AppleStatus, type PageLanguageHints, type PageTranslateCommand, type TranslateSettings } from '@shared/translate'
import { TranslateController } from '../src/main/translate/controller'
import { TranslateError, fakeEngine, type TranslateEngine } from '../src/main/translate/engines'
import { TranslateHelper, parseHelperLine, type HelperProcess } from '../src/main/translate/helper'

// Page translation's main side (TR-01 to TR-06, TR-10): the controller's flow
// from hints to offer, translating, batches, Show original and the never
// choices, with fake engines; and the helper's line protocol over fake pipes.

const FRENCH = 'Le gouvernement a annoncé mardi une série de mesures pour soutenir les familles et les entreprises. Les syndicats ont salué une avancée, mais ils demandent plus de moyens pour les services publics.'
const hints = (patch: Partial<PageLanguageHints> = {}): PageLanguageHints => ({ declared: 'fr', contentLanguage: null, ogLocale: null, optOut: false, sample: FRENCH, ...patch })

function setup(opts: { apple?: AppleStatus; settings?: Partial<TranslateSettings>; engines?: Partial<Record<'apple' | 'companion', TranslateEngine>> } = {}) {
  let settings: TranslateSettings = { ...TRANSLATE_DEFAULTS, ...opts.settings }
  const commands: PageTranslateCommand[] = []
  let changes = 0
  const engines = { apple: fakeEngine('apple'), companion: fakeEngine('companion'), ...opts.engines }
  let n = 0
  const c = new TranslateController({
    prefs: () => ({ settings, languages: ['en-US'] }),
    savePrefs: (_tab, next) => {
      settings = next
    },
    appleStatus: async () => opts.apple ?? 'installed',
    engine: (id) => engines[id],
    command: (_tab, cmd) => commands.push(cmd),
    changed: () => void changes++,
    newSession: () => `s${++n}`,
  })
  return { c, commands, engines, settings: () => settings, changes: () => changes }
}

const URL = 'https://www.lemonde.fr/article'

describe('the translate controller', () => {
  it('offers on a French page, translates on request, answers batches and restores', async () => {
    const { c, commands } = setup()
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints())
    expect(c.info('t1')).toMatchObject({ status: 'offer', language: 'fr', target: 'en', host: 'www.lemonde.fr', always: false, neverSite: false })
    await c.translate('t1')
    expect(commands).toEqual([{ kind: 'start', session: 's1', source: 'fr', target: 'en' }])
    expect(c.info('t1')).toMatchObject({ status: 'translating', engine: 'apple' })
    expect(await c.batch('t1', 's1', ['Bonjour le monde'])).toEqual({ texts: ['Hello world'] })
    expect(await c.batch('t1', 'old', ['Bonjour'])).toEqual({ error: 'failed' })
    c.report('t1', { kind: 'progress', session: 's1', done: 3, total: 10 })
    expect(c.info('t1')?.progress).toEqual({ done: 3, total: 10 })
    c.report('t1', { kind: 'done', session: 's1', done: 10, total: 10 })
    expect(c.info('t1')?.status).toBe('translated')
    // While translated, new hints (the page now reads as English) change nothing.
    await c.hints('t1', URL, hints({ sample: 'The government announced a series of measures on Tuesday to support families and businesses across the country.' }))
    expect(c.info('t1')?.status).toBe('translated')
    c.restore('t1')
    expect(commands.at(-1)).toEqual({ kind: 'restore' })
    expect(c.info('t1')?.status).toBe('offer')
    expect(await c.batch('t1', 's1', ['Bonjour'])).toEqual({ error: 'failed' })
  })

  it('offers nothing on your own language, and starts over on navigation', async () => {
    const { c } = setup()
    c.navigated('t1', 'https://example.com/')
    await c.hints('t1', 'https://example.com/', hints({ declared: 'en', sample: '' }))
    expect(c.info('t1')).toBeNull()
    await c.hints('t1', 'https://example.com/', hints())
    expect(c.info('t1')?.status).toBe('offer')
    c.navigated('t1', 'https://example.com/next')
    expect(c.info('t1')).toBeNull()
  })

  it('translates an always language at once, but only once per page', async () => {
    const { c, commands } = setup({ settings: { always: ['fr'] } })
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints())
    await new Promise((r) => setTimeout(r, 0))
    expect(commands).toEqual([{ kind: 'start', session: 's1', source: 'fr', target: 'en' }])
    c.restore('t1')
    await c.hints('t1', URL, hints())
    await new Promise((r) => setTimeout(r, 0))
    expect(commands.filter((x) => x.kind === 'start')).toHaveLength(1)
    expect(c.info('t1')).toMatchObject({ status: 'offer', always: true })
  })

  it('says why when no engine can translate, and uses the companion when allowed', async () => {
    const off = setup({ apple: 'supported' })
    off.c.navigated('t1', URL)
    await off.c.hints('t1', URL, hints())
    await off.c.translate('t1')
    expect(off.commands).toEqual([])
    expect(off.c.info('t1')).toMatchObject({ status: 'error', error: 'not-installed' })

    const on = setup({ apple: 'unavailable', settings: { companion: true } })
    on.c.navigated('t1', URL)
    await on.c.hints('t1', URL, hints())
    await on.c.translate('t1')
    expect(on.c.info('t1')).toMatchObject({ status: 'translating', engine: 'companion' })
    expect(await on.c.batch('t1', 's1', ['Lire la suite'])).toEqual({ texts: ['Read more'] })
    expect((on.engines.apple as ReturnType<typeof fakeEngine>).calls).toEqual([])
  })

  it('hands over to the companion when Apple fails mid-page and the companion is allowed', async () => {
    const failing: TranslateEngine = {
      id: 'apple',
      async translate() {
        throw new TranslateError('not-installed')
      },
    }
    const { c } = setup({ settings: { companion: true }, engines: { apple: failing } })
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints())
    await c.translate('t1')
    expect(await c.batch('t1', 's1', ['Bonjour le monde'])).toEqual({ texts: ['Hello world'] })
    expect(c.info('t1')?.engine).toBe('companion')

    const strict = setup({ engines: { apple: failing } })
    strict.c.navigated('t1', URL)
    await strict.c.hints('t1', URL, hints())
    await strict.c.translate('t1')
    expect(await strict.c.batch('t1', 's1', ['x'])).toEqual({ error: 'not-installed' })
  })

  it('remembers a chosen target, and the never choices restore and hide the offer', async () => {
    const { c, commands, settings } = setup()
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints())
    await c.translate('t1', 'nl-BE')
    expect(settings().target).toBe('nl')
    expect(commands.at(-1)).toMatchObject({ kind: 'start', target: 'nl' })
    c.setNeverSite('t1', true)
    expect(settings().neverSites).toEqual(['www.lemonde.fr'])
    expect(commands.at(-1)).toEqual({ kind: 'restore' })
    expect(c.info('t1')).toBeNull()
    c.setNeverSite('t1', false)
    c.settingsChanged()
    expect(c.info('t1')?.status).toBe('offer')
    c.setNeverLanguage('t1', true)
    expect(settings().never).toEqual(['fr'])
    expect(c.info('t1')).toBeNull()
    c.setNeverLanguage('t1', false)
    c.setAlways('t1', true)
    expect(settings()).toMatchObject({ always: ['fr'], never: [] })
  })

  it('offers Translate to or Show original in the page menu, even where the offer is hidden (TR-13)', async () => {
    const { c } = setup({ settings: { neverSites: ['www.lemonde.fr'] } })
    c.navigated('t1', URL)
    expect(c.menu('t1')).toBeNull()
    await c.hints('t1', URL, hints())
    expect(c.info('t1')).toBeNull()
    expect(c.menu('t1')).toEqual({ kind: 'translate', target: 'en' })
    await c.translate('t1')
    expect(c.menu('t1')).toEqual({ kind: 'restore' })
    c.restore('t1')
    expect(c.menu('t1')).toEqual({ kind: 'translate', target: 'en' })
    await c.hints('t1', URL, hints({ declared: 'en', sample: '' }))
    expect(c.menu('t1')).toBeNull()
    c.navigated('t2', 'apex://settings')
    expect(c.menu('t2')).toBeNull()
  })

  it('reports an unknown language instead of guessing', async () => {
    const { c, commands } = setup()
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints({ declared: null, sample: '' }))
    expect(c.info('t1')).toBeNull()
    await c.translate('t1')
    expect(commands).toEqual([])
  })

  it('takes a page failure as an error and ignores reports from old sessions', async () => {
    const { c } = setup()
    c.navigated('t1', URL)
    await c.hints('t1', URL, hints())
    await c.translate('t1')
    c.report('t1', { kind: 'done', session: 'other', done: 1, total: 1 })
    expect(c.info('t1')?.status).toBe('translating')
    c.report('t1', { kind: 'failed', session: 's1', error: 'failed' })
    expect(c.info('t1')).toMatchObject({ status: 'error', error: 'failed' })
  })
})

function fakeProcess(answer: (req: Record<string, unknown>) => string | null): HelperProcess & { killed: boolean } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit: (() => void) | null = null
  const proc = {
    stdin,
    stdout,
    killed: false,
    kill() {
      proc.killed = true
      exit?.()
    },
    once(_e: 'exit', fn: () => void) {
      exit = fn
      return proc
    },
  }
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += String(chunk)
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      const out = answer(JSON.parse(line) as Record<string, unknown>)
      if (out !== null) stdout.write(`${out}\n`)
    }
  })
  return proc
}

describe('the translation helper protocol (TR-05)', () => {
  it('checks every line', () => {
    expect(parseHelperLine('{"id":1,"type":"status","status":"installed"}')).toEqual({ id: 1, type: 'status', status: 'installed' })
    expect(parseHelperLine('{"id":1,"type":"status","status":"maybe"}')).toBeNull()
    expect(parseHelperLine('not json')).toBeNull()
    expect(parseHelperLine('{"id":2,"type":"error","code":"not-installed","message":"x"}')).toMatchObject({ code: 'not-installed' })
  })

  it('asks, translates, detects and maps errors', async () => {
    let spawned = 0
    const helper = new TranslateHelper({
      path: () => '/fake/apex-translate',
      spawner: () => {
        spawned++
        return fakeProcess((req) => {
          if (req.op === 'status') return JSON.stringify({ id: req.id, type: 'status', status: req.source === 'fr' ? 'installed' : 'supported' })
          if (req.op === 'translate' && req.source === 'xx') return JSON.stringify({ id: req.id, type: 'error', code: 'not-installed', message: 'Not downloaded.' })
          if (req.op === 'translate') return `noise\n${JSON.stringify({ id: req.id, type: 'result', texts: (req.texts as string[]).map((t) => t.toUpperCase()) })}`
          if (req.op === 'detect') return JSON.stringify({ id: req.id, type: 'detect', language: 'fr', confidence: 0.98 })
          return null
        })
      },
    })
    expect(await helper.status('fr', 'en')).toBe('installed')
    expect(await helper.status('de', 'en')).toBe('supported')
    expect(await helper.translate('fr', 'en', ['a', 'b'])).toEqual(['A', 'B'])
    await expect(helper.translate('xx', 'en', ['a'])).rejects.toMatchObject({ code: 'not-installed' })
    expect(await helper.detect('Bonjour')).toEqual({ language: 'fr', confidence: 0.98 })
    expect(spawned).toBe(1)
    helper.dispose()
  })

  it('is unavailable without a helper, and fails pending work when it stops', async () => {
    const none = new TranslateHelper({ path: () => null })
    expect(await none.status('fr', 'en')).toBe('unavailable')
    await expect(none.translate('fr', 'en', ['a'])).rejects.toMatchObject({ code: 'unavailable' })
    expect(await none.detect('x')).toBeNull()

    let proc: ReturnType<typeof fakeProcess> | null = null
    const silent = new TranslateHelper({ path: () => '/fake', spawner: () => (proc = fakeProcess(() => null)) })
    const pending = silent.translate('fr', 'en', ['a'])
    proc!.kill()
    await expect(pending).rejects.toMatchObject({ code: 'failed' })
    silent.dispose()
  })
})
