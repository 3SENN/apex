/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import { comspec } from './programs'

// Reading a value from the Windows registry with reg.exe (Apex has no native
// registry module). Its output is in the console's code page, so a path with
// an ü in it would arrive garbled; the query runs under chcp 65001, which
// makes it UTF-8. Its labels ("(Default)") are in the system's language, so
// only the value's type is matched.

/** The first string a `reg query … /ve` printed, with REG_EXPAND_SZ's %VARIABLES% expanded. */
export function parseDefaultValue(output: string, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const m = /^[ \t]+\S.*?[ \t]{2,}(REG_SZ|REG_EXPAND_SZ)[ \t]{2,}(.*?)[ \t]*$/m.exec(output)
  const value = m?.[2]
  if (!value) return null
  if (m[1] === 'REG_SZ') return value
  return value.replace(/%([^%]+)%/g, (whole, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] ?? whole)
}

/**
 * A key's default value, from its 32-bit view and then its 64-bit one (the
 * order Chrome reads them), or null when neither has one. Only plain key
 * names: the caller checks what it puts in one.
 */
export function readDefaultValue(key: string): string | null {
  if (process.platform !== 'win32' || !/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\[\w .\\-]+$/.test(key)) return null
  const reg = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const query = (view: string): string => `"${reg}" query "${key}" /ve /reg:${view}`
  const result = spawnSync(comspec(), ['/d', '/s', '/c', `"chcp 65001 >nul & ${query('32')} & ${query('64')}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 3000 })
  return parseDefaultValue(result.stdout ?? '')
}

/** Every named value a `reg query <key>` printed: strings as text, DWORDs as numbers (organisation policies). */
export function parseValues(output: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const m of output.matchAll(/^[ \t]+(\S(?:.*?\S)?)[ \t]{2,}(REG_SZ|REG_EXPAND_SZ|REG_DWORD|REG_QWORD)[ \t]{2,}(.*?)[ \t]*$/gm)) {
    const [, name, type, raw] = m as unknown as [string, string, string, string]
    if (name in out) continue
    out[name] = type === 'REG_DWORD' || type === 'REG_QWORD' ? Number.parseInt(raw, 16) : raw
  }
  return out
}

/** A key's named values, from its 64-bit view and then its 32-bit one; {} when it has none. Async, so nothing waits on reg.exe. */
export async function readValues(key: string): Promise<Record<string, string | number>> {
  if (process.platform !== 'win32' || !/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\[\w .\\-]+$/.test(key)) return {}
  const { spawn } = await import('node:child_process')
  const reg = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const query = (view: string): string => `"${reg}" query "${key}" /reg:${view}`
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawn(comspec(), ['/d', '/s', '/c', `"chcp 65001 >nul & ${query('64')} & ${query('32')}"`], { windowsHide: true, windowsVerbatimArguments: true })
    const timer = setTimeout(() => child.kill(), 3000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', () => resolve({}))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseValues(stdout))
    })
  })
}
