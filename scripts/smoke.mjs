/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Launches the built app in smoke-test mode and exits with its status.
// A watchdog ends a run that stops making progress (ATELIER_SMOKE_MAX_MS, 20 min).
// The network guard: Chromium writes a net log for the run, and any request to
// a host outside this machine fails the run (scripts/smoke/netGuard.mjs).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { externalHosts } from './smoke/netGuard.mjs'

const env = { ...process.env, ATELIER_SMOKE: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

const logDir = mkdtempSync(join(tmpdir(), 'atelier-netlog-'))
const netLog = join(logDir, 'net-log.json')
const maxMs = Number(process.env.ATELIER_SMOKE_MAX_MS) || 20 * 60_000
const child = spawn(electron, ['.', `--log-net-log=${netLog}`, '--net-log-capture-mode=Default'], { stdio: 'inherit', env })
const watchdog = setTimeout(() => {
  console.error(`\nsmoke: no result after ${Math.round(maxMs / 1000)}s, stopping the app`)
  child.kill('SIGKILL')
}, maxMs)
child.on('exit', (code, signal) => {
  clearTimeout(watchdog)
  let status = code ?? (signal ? 1 : 0)
  // An app that stopped without its summary (a crash) says how it ended.
  if (status !== 0) console.error(`smoke: the app exited with code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}`)
  if (existsSync(netLog)) {
    const hosts = externalHosts(readFileSync(netLog, 'utf8'))
    if (hosts.length === 0) console.log('PASS  network guard: no request left the machine (Chromium net log)')
    else {
      console.log(`FAIL  network guard: requests left the machine, to ${hosts.join(', ')}`)
      status = status || 1
    }
  } else console.log('note  network guard: Chromium wrote no net log, so only the main-process fetch fence ran')
  rmSync(logDir, { recursive: true, force: true })
  process.exit(status)
})
