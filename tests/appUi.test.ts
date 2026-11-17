/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_DESIGN_NOTES, PACK_DESIGN_NOTES, lintAppDesign } from '../src/shared/appDesign'
import { appUiStyle, withAppUi } from '../src/main/apps/ui'
import { serveApp } from '../src/main/apps/protocol'
import { starterFiles } from '../src/main/packs/starters'

const UI = readFileSync('src/kit/ui.css', 'utf8')
const BROWSER = readFileSync('src/renderer/src/styles.css', 'utf8')

/** The custom properties declared in the first `:root {` block after `from`, values with whitespace collapsed. */
function rootTokens(css: string, from = 0): Map<string, string> {
  const start = css.indexOf(':root {', from)
  let depth = 0
  let end = start
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, ' ').trim()]))
}

describe(`${BRAND_NAME} UI for apps (APP-UI)`, () => {
  it('carries the browser’s own token values', () => {
    const app = rootTokens(UI, UI.indexOf('@layer atelier.tokens {'))
    const browser = rootTokens(BROWSER)
    let shared = 0
    for (const [name, value] of app) {
      const theirs = browser.get(name)
      // Profile colours are the chrome's own; apps take their defaults.
      if (theirs === undefined || theirs.includes('var(--profile')) continue
      expect(value, name).toBe(theirs)
      shared++
    }
    expect(shared).toBeGreaterThan(80)
  })

  it('puts everything in cascade layers, so the app’s own CSS wins', () => {
    const outside = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer [\w., ]+;/, '')
    let depth = 0
    for (const m of outside.matchAll(/@layer [\w.]+ \{|\{|\}/g)) {
      if (m[0] === '}') depth--
      else if (m[0].startsWith('@layer')) depth++
      else {
        expect(depth, `a rule outside a layer near "${outside.slice(Math.max(0, (m.index ?? 0) - 40), m.index).trim()}"`).toBeGreaterThan(0)
        depth++
      }
    }
  })

  it('has every component the design notes name', () => {
    const named = new Set([...`${APP_DESIGN_NOTES}\n${PACK_DESIGN_NOTES}`.matchAll(/\.(ax-[a-z-]+(?:__[a-z]+)?)/g)].map((m) => m[1]!))
    const skill = readFileSync('src/main/skills/builtin/app-design/SKILL.md', 'utf8')
    for (const m of skill.matchAll(/class="([^"]+)"/g)) for (const c of m[1]!.split(/\s+/)) if (c.startsWith('ax-')) named.add(c)
    expect(named.size).toBeGreaterThan(25)
    for (const c of named) expect(UI, c).toMatch(new RegExp(`\\.${c.replace(/[-_]/g, (x) => `\\${x}`)}\\b`))
  })

  it('goes first in the app’s head, making one when there is none', () => {
    const style = '<style data-atelier-ui>x</style>'
    expect(withAppUi('<!doctype html><html><head><title>A</title></head><body></body></html>', style)).toBe(`<!doctype html><html><head>${style}<title>A</title></head><body></body></html>`)
    expect(withAppUi('<!doctype html><html lang="en"><body><header>h</header></body></html>', style)).toBe(`<!doctype html><html lang="en"><head>${style}</head><body><header>h</header></body></html>`)
    expect(withAppUi('<!DOCTYPE html><p>hi</p>', style)).toBe(`<!DOCTYPE html>${style}<p>hi</p>`)
    expect(withAppUi('<p>hi</p>', style)).toBe(`${style}<p>hi</p>`)
    expect(withAppUi('<p>hi</p>', '')).toBe('<p>hi</p>')
  })

  it('brings the companion’s accent in its token layer', () => {
    expect(appUiStyle(null, '#ff8a5c')).toBe('')
    const styled = appUiStyle(':root{}', '#ff8a5c')
    expect(styled).toMatch(/^<style data-atelier-ui>/)
    expect(styled).toMatch(/@layer atelier\.tokens \{ :root \{ --companion-accent-light: #[0-9a-f]{6};.*--companion-accent-dark: #[0-9a-f]{6};/)
    expect(appUiStyle(':root{}', 'red;}</style><script>')).not.toContain('<script>')
    expect(appUiStyle(':root{}', null)).not.toContain('--companion-accent')
  })

  it('is served in every app page', async () => {
    const store = { html: () => '<!doctype html><html><head><title>T</title></head><body></body></html>' }
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const res = serveApp(store, id, `atelier-app://${id}/`, () => '<style data-atelier-ui></style>')
    expect(await res.text()).toContain('<head><style data-atelier-ui></style><title>T</title>')
  })
})

const CLEAN = `<!doctype html><html><head><title>Tips</title><style>
.total { color: var(--text-primary); }
</style></head><body><main class="ax-app"><h1 class="ax-title">Tip splitter</h1>
<label class="ax-label" for="t">Total</label><input class="ax-input" id="t" inputmode="decimal">
<label class="ax-check"><input type="checkbox" role="switch" class="ax-switch"> Round up</label>
<button class="ax-btn ax-btn--icon" aria-label="Reset"><svg class="ax-icon"></svg></button>
<input type="hidden" name="x"><p>© 2026</p></main></body></html>`

const SLOP = `<!doctype html><html><head><title>✨ Tips</title><style>
@import url(https://fonts.googleapis.com/css2?family=Poppins);
body { font-family: 'Poppins', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
.card { background: rgba(255,255,255,0.1); backdrop-filter: blur(12px); border-left: 4px solid #a78bfa; box-shadow: 0 0 30px rgba(167,139,250,.6); transition: all .3s; }
.eyebrow { text-transform: uppercase; letter-spacing: .1em; color: #c4b5fd; }
button:focus { outline: none; }
</style></head><body><h1>💸 Tip Splitter</h1><input id="total" placeholder="Total"><select><option>15%</option></select></body></html>`

describe('the design check', () => {
  it(`passes an app built with ${BRAND_NAME} UI`, () => {
    expect(lintAppDesign(CLEAN)).toEqual([])
  })

  it('names the generic look, at most eight problems', () => {
    const found = lintAppDesign(SLOP)
    expect(found.length).toBe(8)
    const text = found.join('\n')
    for (const bit of [`${BRAND_NAME} UI`, 'colours are written out', 'gradients', 'frosted glass', 'glowing', 'emoji', 'own font', 'stripe']) expect(text).toContain(bit)
  })

  it('reports the rest once the first problems are fixed', () => {
    const fewer = SLOP.replace(/linear-gradient\([^)]*\)/, 'var(--bg-page)').replace('backdrop-filter: blur(12px);', '').replace('box-shadow: 0 0 30px rgba(167,139,250,.6);', '').replace('💸 ', '').replace('✨ ', '')
    const text = lintAppDesign(fewer).join('\n')
    for (const bit of ['all caps', 'focus outline', 'transition: all', '2 form controls have no label']) expect(text).toContain(bit)
  })

  it('counts colours, not the app’s own tokens', () => {
    const tokens = '<style>:root { --ink: #111; --paper: #fafafa; --line: rgb(0 0 0 / 10%); --x: #222; } .a { color: var(--ink); }</style><div class="ax-app"></div>'
    expect(lintAppDesign(tokens)).toEqual([])
  })
})

describe('starters', () => {
  it('are scripts that parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-starters-'))
    for (const starter of ['game-3d', 'game-2d', 'tool', 'story', 'sorter'] as const) {
      const file = join(dir, `${starter}.mjs`)
      writeFileSync(file, starterFiles(starter, { id: 'x.y', name: 'Test', description: 'A test.' }).get('app/main.js')!)
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      expect(check.status, `${starter}: ${check.stderr}`).toBe(0)
    }
  })

  it(`link ${BRAND_NAME} UI first and write no colours of their own`, () => {
    for (const starter of ['game-3d', 'game-2d', 'tool', 'story', 'sorter'] as const) {
      const files = starterFiles(starter, { id: 'x.y', name: 'Test', description: 'A test.' })
      const page = files.get('app/index.html')!.toString()
      expect(page.indexOf('/__atelier/kit/1/atelier-kit/ui.css')).toBeGreaterThan(-1)
      expect(page.indexOf('/__atelier/kit/1/atelier-kit/ui.css')).toBeLessThan(page.indexOf('./style.css'))
      expect(files.get('app/style.css')!.toString(), starter).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
      const code = files.get('app/main.js')!.toString()
      // A 3D scene keeps its own light and world colours; the interface takes Atelier UI's.
      if (starter !== 'game-3d') expect(code, starter).not.toMatch(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/i)
      expect(code, starter).not.toMatch(/6b5bff|f7f5ff|15131f/i)
    }
  })
})
