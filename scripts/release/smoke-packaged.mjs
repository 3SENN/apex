#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Runs the smoke test inside the packaged app: the same checks as
// `npm run smoke`, but in the fused, asar-only build electron-builder made.
//
//   node scripts/release/smoke-packaged.mjs            the app for this machine, under dist/
//   node scripts/release/smoke-packaged.mjs --public   also require the public-release check
//   node scripts/release/smoke-packaged.mjs --app <path to .app, .exe or binary>
//
// Smoke mode makes no request outside the machine: chats use the offline
// Messages stand-in and a temporary data folder. On Linux without a display it
// runs under xvfb-run.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { smokeProblems, smokeSummary } from './checks.mjs'
import { releaseSettings } from './config.mjs'
import { REPO as REPO_ROOT, packagedApp } from './paths.mjs'

const TIMEOUT_MS = 20 * 60_000

function launcher(executable) {
  if (process.platform !== 'linux' || process.env.DISPLAY) return [executable, []]
  const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' })
  if (xvfb.status !== 0) throw new Error('no display and no xvfb-run: install xvfb, or set DISPLAY')
  return ['xvfb-run', ['-a', executable]]
}

/** Launches the packaged app in smoke mode; resolves to the reasons it fails (empty when it passes). */
export function smokePackaged({ executable, publicRelease, timeoutMs = TIMEOUT_MS, log = (s) => process.stdout.write(s) }) {
  // The fused app's asar holds no tests/: fixture folders come from the repo.
  const fixtures = join(REPO_ROOT, 'tests', 'fixtures')
  const env = { ...process.env, ATELIER_SMOKE: '1', ATELIER_SMOKE_FIXTURES: fixtures, ATELIER_SMOKE_NODE: process.execPath, ATELIER_SMOKE_TLS: process.env.ATELIER_SMOKE_TLS ?? join(fixtures, 'tls') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const [cmd, args] = launcher(executable)
  return new Promise((resolvePromise) => {
    let output = ''
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      output += `\nsmoke-packaged: timed out after ${Math.round(timeoutMs / 60_000)} min\n`
      child.kill('SIGKILL')
    }, timeoutMs)
    const take = (chunk) => {
      const s = chunk.toString()
      output += s
      log(s)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise([`could not launch ${executable}: ${err.message}`])
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise(smokeProblems(smokeSummary(output), { exitCode: code, publicRelease }))
    })
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--app')
  let executable
  if (at >= 0) {
    const given = argv[at + 1] ?? ''
    executable = given.endsWith('.app') ? join(given, 'Contents', 'MacOS', basename(given, '.app')) : given
  } else {
    executable = packagedApp()?.executable
  }
  if (!executable || !existsSync(executable)) {
    console.error('smoke-packaged: no packaged app; run npm run package:mac (or :win, :linux) first')
    process.exit(1)
  }
  const publicRelease = argv.includes('--public') || releaseSettings().publicRelease
  const problems = await smokePackaged({ executable, publicRelease })
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    process.exit(1)
  }
  console.log('smoke-packaged: the packaged app passed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
