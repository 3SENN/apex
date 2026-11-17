/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds native/haptics/build/atelier_haptics.node, Atelier's trackpad haptics
// addon, with node-gyp against the installed Electron's headers. macOS
// only: on other platforms the JS loader (native/haptics/index.js) stubs
// it, so there is nothing to build.
//
//   node scripts/build-native.mjs                 universal (arm64 + x64, lipo)
//   node scripts/build-native.mjs --arch=host     this Mac's architecture only
//   node scripts/build-native.mjs --arch=arm64    or x64
//
// ATELIER_NATIVE_ARCH sets the default for --arch. The build tools (node-gyp,
// node-addon-api) live in native/haptics/node_modules and are installed
// there on first run; the Electron headers download into
// native/haptics/.electron-gyp. Nothing outside native/haptics is written.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch as hostArch, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(repo, 'native', 'haptics')
const out = join(root, 'build')
const binary = join(out, 'atelier_haptics.node')
const devdir = join(root, '.electron-gyp')
const distUrl = 'https://electronjs.org/headers'

// node-gyp's names, and the matching Mach-O names lipo reports.
const MACHO = { arm64: 'arm64', x64: 'x86_64' }

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message)
}

function parseArch(argv) {
  let value = process.env.ATELIER_NATIVE_ARCH || 'universal'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--arch') value = argv[++i] ?? ''
    else if (arg.startsWith('--arch=')) value = arg.slice('--arch='.length)
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/build-native.mjs [--arch=universal|host|arm64|x64]')
      process.exit(0)
    } else fail(`unknown argument ${arg}`)
  }
  if (value === 'universal') return ['arm64', 'x64']
  if (value === 'host') value = hostArch()
  if (value in MACHO) return [value]
  fail(`--arch must be universal, host, arm64 or x64 (got ${value || 'nothing'})`)
}

function electronVersion() {
  const manifest = join(repo, 'node_modules', 'electron', 'package.json')
  if (!existsSync(manifest)) fail('Electron is not installed; run npm install in the repo first.')
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    fail(`could not read a version from ${manifest}`)
  }
  return version
}

// node-gyp and node-addon-api are build-only tools, kept out of the repo's
// own package.json and lockfile.
function ensureBuildTools() {
  const gyp = join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  const addonApi = join(root, 'node_modules', 'node-addon-api', 'package.json')
  if (existsSync(gyp) && existsSync(addonApi)) return gyp
  const command = existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install'
  console.log(`atelier-haptics: installing build tools (npm ${command}) into native/haptics/node_modules`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  execFileSync(npm, [command, '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (!existsSync(gyp)) fail('node-gyp is still missing after npm install')
  return gyp
}

function nodeGyp(gyp, args) {
  execFileSync(process.execPath, [gyp, ...args], { cwd: root, stdio: 'inherit' })
}

function lipoArchs(file) {
  return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/).sort()
}

// Loads the result inside the installed Electron (as Node), through the
// same loader the app will use, to prove the ABI and the architecture.
function verifyInElectron(file) {
  const electron = createRequire(join(repo, 'package.json'))('electron')
  if (typeof electron !== 'string' || !existsSync(electron)) {
    fail('could not find the Electron binary to verify the addon with')
  }
  const script = [
    `const h = require(${JSON.stringify(join(root, 'index.js'))})`,
    `  .loadHaptics({ paths: [${JSON.stringify(file)}] })`,
    'console.log(JSON.stringify({ electron: process.versions.electron, available: h.available, reason: h.reason, error: h.error }))',
  ].join('\n')
  const result = spawnSync(electron, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const line = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  let report
  try {
    report = JSON.parse(line)
  } catch {
    fail(`Electron could not run the load check:\n${result.stderr || result.stdout}`)
  }
  if (!report.available) fail(`Electron ${report.electron} could not load the addon: ${report.reason} ${report.error ?? ''}`)
  console.log(`atelier-haptics: loads in Electron ${report.electron}`)
}

function build() {
  const arches = parseArch(process.argv.slice(2))
  const version = electronVersion()
  const gyp = ensureBuildTools()
  console.log(`atelier-haptics: building for Electron ${version} (${arches.join(' + ')})`)

  const staging = mkdtempSync(join(tmpdir(), 'atelier-haptics-'))
  try {
    const slices = arches.map((arch) => {
      nodeGyp(gyp, [
        'rebuild',
        '--release',
        `--target=${version}`,
        `--arch=${arch}`,
        `--dist-url=${distUrl}`,
        `--devdir=${devdir}`,
      ])
      const built = join(out, 'Release', 'atelier_haptics.node')
      if (!existsSync(built)) fail(`node-gyp finished without ${built}`)
      const got = lipoArchs(built)
      if (got.length !== 1 || got[0] !== MACHO[arch]) fail(`the ${arch} slice is ${got.join(' + ')}`)
      const slice = join(staging, `atelier_haptics-${arch}.node`)
      copyFileSync(built, slice)
      return slice
    })

    // Leave only the finished binary in build/, so nothing picks up a
    // single-architecture build/Release copy by mistake.
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    if (slices.length > 1) execFileSync('lipo', ['-create', ...slices, '-output', binary], { stdio: 'inherit' })
    else copyFileSync(slices[0], binary)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // Ad hoc, so Apple silicon will load it in dev; packaging re-signs it
  // with the app's identity.
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' })

  const want = arches.map((arch) => MACHO[arch]).sort()
  const have = lipoArchs(binary)
  if (have.join(' ') !== want.join(' ')) fail(`built ${have.join(' + ')}, wanted ${want.join(' + ')}`)

  if (arches.includes(hostArch())) verifyInElectron(binary)
  else console.log(`atelier-haptics: no ${hostArch()} slice, so the Electron load check is skipped`)

  console.log(`atelier-haptics: built ${binary} (${have.join(' + ')})`)
}

if (process.platform !== 'darwin') {
  console.log('atelier-haptics: macOS only, skipping (the loader stubs it here).')
} else {
  try {
    build()
  } catch (err) {
    console.error(`atelier-haptics: ${err instanceof BuildError ? err.message : err?.stack ?? err}`)
    process.exitCode = 1
  }
}
