#!/usr/bin/env node
/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */
// Renders Atelier's brand art from the real companion: the default Pip, smiling,
// drawn by the app's own still renderer (src/renderer/src/companion/render.ts,
// renderCompanionImage) in a hidden Electron window, with a transparent
// background. Writes 1024 px masters:
//
//   branding/official/art/pip-head.png   the frameless floating head (the small avatars' framing)
//   branding/official/art/pip-full.png   the whole companion
//   branding/official/art/group-<id>-{head,full}.png  the .atelierpack group picture's Mochi and Bolt (Pip is pip-*)
//
//   node scripts/app-icons/render-pip.mjs              render into branding/official/art/
//   node scripts/app-icons/render-pip.mjs --out <dir>  render somewhere else
//   node scripts/app-icons/render-pip.mjs --size <px>  another master size (default 1024)
//
// The masters are committed, so builds and scripts/app-icons/generate.mjs
// never need a GPU: re-run this only when Pip's look or the renderer changes,
// then run generate.mjs. The page is bundled with Vite from scripts/app-icons/pip/
// and the companion assets come straight from src/renderer/public/companion/.
// Nothing is fetched from the network.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { decodePNG } from './lib/png.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
export const BRAND_DIR = 'branding/official/art'
export const MASTER_SIZE = 1024
/** Pip's head and body, then the .atelierpack group picture's other members (pip/render.ts GROUP; Pip there is pip-*). */
export const GROUP_IDS = ['mochi', 'bolt']
export const MASTER_NAMES = ['pip-head', 'pip-full', ...GROUP_IDS.flatMap((id) => [`group-${id}-head`, `group-${id}-full`])]

function parseArgs(argv) {
  const opts = { out: join(REPO, BRAND_DIR), size: MASTER_SIZE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = resolve(argv[++i])
    else if (a === '--size') opts.size = Number(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
    else throw new Error(`Unknown option ${a}`)
  }
  if (!Number.isInteger(opts.size) || opts.size < 64 || opts.size > 2048) throw new Error('--size must be a whole number from 64 to 2048')
  return opts
}

async function bundlePage(outDir) {
  const { build } = await import('vite')
  await build({
    configFile: false,
    root: join(HERE, 'pip'),
    base: './',
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: { '@shared': join(REPO, 'src/shared') } },
    build: { outDir, emptyOutDir: true, minify: false, rollupOptions: { input: join(HERE, 'pip/render.html') } }
  })
}

/** Checks a master: the right size, a clear ground and a solid companion in it. */
export function checkMaster(buf, size) {
  const img = decodePNG(buf)
  if (img.width !== size || img.height !== size) throw new Error(`expected ${size}×${size}, got ${img.width}×${img.height}`)
  let solid = 0
  for (let i = 3; i < img.pixels.length; i += 4) if (img.pixels[i] === 255) solid++
  const corners = [0, size - 1, (size - 1) * size, size * size - 1].map((p) => img.pixels[p * 4 + 3])
  if (corners.some((a) => a !== 0)) throw new Error('the background is not transparent')
  if (solid < size * size * 0.08) throw new Error('the companion is missing or too small')
  return img
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('Usage: node scripts/app-icons/render-pip.mjs [--out <dir>] [--size <px>]')
    return
  }
  const work = mkdtempSync(join(tmpdir(), 'atelier-pip-'))
  try {
    const page = join(work, 'page')
    const shots = join(work, 'shots')
    await bundlePage(page)
    const { default: electron } = await import('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const r = spawnSync(electron, [join(HERE, 'pip/main.mjs'), page, join(REPO, 'src/renderer/public/companion'), shots, String(opts.size)], {
      env,
      encoding: 'utf8',
      timeout: 120_000
    })
    if (r.status !== 0) throw new Error(`Electron could not render Pip (exit ${r.status ?? r.signal}).\n${r.stderr ?? ''}`)
    mkdirSync(opts.out, { recursive: true })
    for (const name of MASTER_NAMES) {
      const file = join(shots, `${name}.png`)
      if (!existsSync(file)) throw new Error(`Electron wrote no ${name}.png`)
      const buf = readFileSync(file)
      checkMaster(buf, opts.size)
      const dest = join(opts.out, `${name}.png`)
      if (existsSync(dest) && readFileSync(dest).equals(buf)) console.log(`unchanged ${dest}`)
      else {
        writeFileSync(dest, buf)
        console.log(`wrote ${dest}`)
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
