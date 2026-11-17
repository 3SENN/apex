/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The no-analytics guard: Apex sends no
// telemetry. This fails when a telemetry package lands in package.json or
// the lockfile, or when source imports one or names a telemetry host.

const ROOT = join(__dirname, '..')
const PACKAGE = /^(@sentry\/|sentry(-|$)|raven(-|$)|@segment\/|analytics-node$|posthog|mixpanel|@amplitude\/|amplitude(-|$)|@datadog\/|dd-trace|datadog|@bugsnag\/|bugsnag)/i
const HOSTS = /\b(sentry\.io|ingest\.sentry|posthog\.com|i\.posthog|api\.segment\.io|cdn\.segment\.com|segmentapis\.com|mixpanel\.com|amplitude\.com|datadoghq\.(com|eu)|browser-intake-datadog|bugsnag\.com|sessions\.bugsnag)\b/i
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
// Connectors you choose to add (an MCP server for your own Sentry account,
// say) name those services; that is your data going where you send it.
const USER_CHOSEN = [join('src', 'main', 'connectors', 'directory.json')]

function telemetryPackages(names: Iterable<string>): string[] {
  return [...names].filter((name) => PACKAGE.test(name))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|js|mjs|cjs|html|css|json)$/.test(name)) out.push(path)
  }
  return out
}

describe('no analytics', () => {
  it('recognises telemetry packages, and only those', () => {
    expect(telemetryPackages(['@sentry/electron', 'posthog-js', '@segment/analytics-next', 'mixpanel-browser', '@amplitude/analytics-node', 'dd-trace', '@bugsnag/electron', 'raven-js'])).toHaveLength(8)
    expect(telemetryPackages(['react', 'fflate', 'zod', 'electron-updater', 'path-segments'])).toEqual([])
  })

  it('has no telemetry package in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}))
    expect(telemetryPackages(names)).toEqual([])
  })

  it('has no telemetry package anywhere in the lockfile', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages?: Record<string, unknown> }
    const names = Object.keys(lock.packages ?? {}).map((key) => key.split('node_modules/').pop() ?? '').filter(Boolean)
    expect(telemetryPackages(names)).toEqual([])
  })

  it('never imports telemetry or names a telemetry host in src', () => {
    const found: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      if (USER_CHOSEN.some((allowed) => file.endsWith(allowed))) continue
      const text = readFileSync(file, 'utf8')
      const host = HOSTS.exec(text)
      if (host) found.push(`${file}: ${host[0]}`)
      for (const match of text.matchAll(IMPORT)) if (telemetryPackages([match[1] ?? '']).length) found.push(`${file}: import ${match[1]}`)
    }
    expect(found).toEqual([])
    // It reads all of src (about 15 MB), so it gets more than the default 5 s on a busy machine.
  }, 30_000)
})
