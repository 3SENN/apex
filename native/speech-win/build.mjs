/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds native/speech-win/build/apex-speech.exe, Apex's Windows speech
// helper: .NET 8, self-contained, single file. scripts/build-speech-helper.mjs
// calls this on Windows; it needs the .NET 8 SDK, so it runs in CI
// (windows-latest), never on the Mac.
//
//   node scripts/build-speech-helper.mjs              this machine's architecture
//   node scripts/build-speech-helper.mjs --arch=arm64 or x64
//
// Each architecture publishes into build/win-<arch>/, and the one asked for
// is copied to build/apex-speech.exe, the path Apex runs in development and
// electron-builder packages.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const project = join(root, 'ApexSpeech.csproj')
const out = join(root, 'build')
const ARCHES = ['x64', 'arm64']

function parseArch(argv) {
  let value = process.env.APEX_SPEECH_ARCH || process.arch
  for (const arg of argv) {
    if (arg.startsWith('--arch=')) value = arg.slice('--arch='.length)
    else throw new Error(`apex-speech.exe: unknown argument ${arg}`)
  }
  if (!ARCHES.includes(value)) throw new Error(`apex-speech.exe: --arch must be x64 or arm64 (got ${value})`)
  return value
}

function dotnet(args) {
  return execFileSync('dotnet', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
}

export function buildWindowsHelper(argv = []) {
  const arch = parseArch(argv)
  let version
  try {
    version = dotnet(['--version']).trim()
  } catch {
    throw new Error('apex-speech.exe: the .NET 8 SDK is not installed (https://dot.net). The helper is built in CI on Windows.')
  }
  if (Number.parseInt(version, 10) < 8) throw new Error(`apex-speech.exe: needs the .NET 8 SDK or newer (found ${version}).`)

  const target = join(out, `win-${arch}`)
  mkdirSync(target, { recursive: true })
  execFileSync(
    'dotnet',
    ['publish', project, '-c', 'Release', '-r', `win-${arch}`, '--self-contained', 'true', '-p:PublishSingleFile=true', '-o', target, '--nologo'],
    { cwd: root, stdio: 'inherit' },
  )
  const exe = join(target, 'apex-speech.exe')
  if (!existsSync(exe)) throw new Error(`apex-speech.exe: dotnet publish wrote no ${exe}`)
  const dest = join(out, 'apex-speech.exe')
  copyFileSync(exe, dest)
  console.log(`apex-speech.exe: built ${dest} (win-${arch}, .NET ${version})`)
  return dest
}
