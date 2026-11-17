/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '../src/shared/diagnostics'
import { FileLogger, LOG_FILE, parseLine, rotatedName } from '../src/main/diagnostics/logger'
import { captureAgentErrors, captureRoutineOutcomes, captureSpeechExit, endedRuns, type RoutineOutcomeItem } from '../src/main/diagnostics/capture'
import { log } from '../src/main/log'

vi.mock('electron', () => ({ app: { on: vi.fn() } }))

// The file logger: JSON lines, rotation and its cap, the per-source rate
// limit with its "dropped" entry, debug gating and queries.

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atelier-logger-'))
const entry = (t: number, message: string, over: Partial<LogEntry> = {}): LogEntry => ({ t, level: 'info', source: 'main', message, ...over })

function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
  let t = start
  return { now: () => t, advance: (ms) => void (t += ms) }
}

describe('FileLogger', () => {
  it('buffers until configured, then writes JSON lines', () => {
    const dir = tmp()
    const logger = new FileLogger({ timers: false })
    logger.write(entry(1, 'before the folder was known'))
    expect(existsSync(join(dir, LOG_FILE))).toBe(false)
    logger.configure(dir)
    logger.write(entry(2, 'after', { data: { n: 1 } }))
    logger.flushSync()
    const lines = readFileSync(join(dir, LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogEntry)
    expect(lines.map((l) => l.message)).toEqual(['before the folder was known', 'after'])
    expect(lines[1]?.data).toEqual({ n: 1 })
  })

  it('rotates at the size limit and keeps only the newest files', () => {
    const dir = tmp()
    const c = clock()
    const logger = new FileLogger({ timers: false, now: c.now, ratePerSecond: 10_000 })
    logger.configure(dir, { maxBytes: 1000, keep: 3 })
    for (let i = 0; i < 200; i++) {
      logger.write(entry(i, `line ${i} ${'x'.repeat(40)}`))
      if (i % 10 === 0) logger.flushSync()
    }
    logger.flushSync()
    expect(existsSync(join(dir, LOG_FILE))).toBe(true)
    for (let i = 1; i <= 3; i++) expect(existsSync(join(dir, rotatedName(i))), rotatedName(i)).toBe(true)
    expect(existsSync(join(dir, rotatedName(4)))).toBe(false)
    // The cap: no file passes the limit, and everything kept is at most (keep + 1) files.
    for (const f of logger.files()) expect(statSync(f.path).size).toBeLessThanOrEqual(1000)
    expect(logger.files()).toHaveLength(4)
    // The newest line is in atelier.log; the oldest kept are in the last rotated file.
    const all = logger.readAll()
    expect(all.at(-1)?.message).toMatch(/^line 199 /)
    expect(all.map((e) => e.t)).toEqual([...all.map((e) => e.t)].sort((a, b) => a - b))
  })

  it('never splits a line across a rotation', () => {
    const dir = tmp()
    const logger = new FileLogger({ timers: false, ratePerSecond: 10_000 })
    logger.configure(dir, { maxBytes: 300, keep: 5 })
    for (let i = 0; i < 30; i++) logger.write(entry(i, `entry ${i} ${'y'.repeat(30)}`))
    logger.flushSync()
    for (const f of logger.files()) for (const line of readFileSync(f.path, 'utf8').trim().split('\n')) expect(parseLine(line)).not.toBeNull()
  })

  it('holds each source to its rate and reports what it dropped', () => {
    const dir = tmp()
    const c = clock()
    const logger = new FileLogger({ timers: false, now: c.now, ratePerSecond: 5 })
    logger.configure(dir)
    for (let i = 0; i < 12; i++) logger.write(entry(c.now(), `burst ${i}`, { source: 'noisy' }))
    // Another source is not affected.
    expect(logger.write(entry(c.now(), 'calm', { source: 'calm' }))).toBe(true)
    c.advance(1000)
    logger.write(entry(c.now(), 'next second', { source: 'noisy' }))
    const all = logger.readAll()
    expect(all.filter((e) => e.source === 'noisy' && e.message.startsWith('burst'))).toHaveLength(5)
    const dropped = all.find((e) => e.message === '7 messages dropped')
    expect(dropped).toMatchObject({ level: 'warn', source: 'noisy', data: { dropped: 7 } })
    expect(all.at(-1)?.message).toBe('next second')
  })

  it('writes the dropped count at flush once a source goes quiet', () => {
    const dir = tmp()
    const c = clock()
    const logger = new FileLogger({ timers: false, now: c.now, ratePerSecond: 2 })
    logger.configure(dir)
    for (let i = 0; i < 5; i++) logger.write(entry(c.now(), `x${i}`))
    c.advance(1500)
    logger.flushSync()
    expect(logger.readAll().map((e) => e.message)).toEqual(['x0', 'x1', '3 messages dropped'])
  })

  it('writes debug entries only when debug is on', () => {
    const dir = tmp()
    const off = new FileLogger({ timers: false })
    off.configure(dir)
    expect(off.write(entry(1, 'quiet', { level: 'debug' }))).toBe(false)
    const on = new FileLogger({ timers: false, debug: true })
    on.configure(tmp())
    expect(on.write(entry(1, 'loud', { level: 'debug' }))).toBe(true)
  })

  it('tells tail listeners about accepted entries only', () => {
    const logger = new FileLogger({ timers: false, ratePerSecond: 1, now: () => 5 })
    const seen: string[] = []
    const stop = logger.onWrite((e) => void seen.push(e.message))
    logger.write(entry(5, 'a'))
    logger.write(entry(5, 'b'))
    stop()
    logger.write(entry(5, 'c', { source: 'other' }))
    expect(seen).toEqual(['a'])
  })

  it('queries across files, filters and pages back, and clears', () => {
    const dir = tmp()
    const logger = new FileLogger({ timers: false, ratePerSecond: 10_000 })
    logger.configure(dir, { maxBytes: 400 })
    for (let i = 0; i < 40; i++) logger.write(entry(i, `m${i}`, { level: i % 4 === 0 ? 'error' : 'info', source: i % 2 ? 'agent' : 'main' }))
    const errors = logger.query({ levels: ['error'] })
    expect(errors.entries.map((e) => e.t)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36])
    expect(errors.files).toBeGreaterThan(1)
    expect(errors.totalBytes).toBeGreaterThan(0)
    const page = logger.query({ limit: 5 })
    expect(page.entries.map((e) => e.t)).toEqual([35, 36, 37, 38, 39])
    expect(page.hasMore).toBe(true)
    expect(logger.query({ limit: 5, before: 35 }).entries.map((e) => e.t)).toEqual([30, 31, 32, 33, 34])
    logger.clear()
    expect(logger.query({}).entries).toEqual([])
    expect(logger.files()).toHaveLength(1)
  })

  it('skips malformed lines', () => {
    const dir = tmp()
    writeFileSync(join(dir, LOG_FILE), `not json\n${JSON.stringify(entry(1, 'ok'))}\n{"t":"x"}\n`)
    const logger = new FileLogger({ timers: false })
    logger.configure(dir)
    expect(logger.readAll().map((e) => e.message)).toEqual(['ok'])
    expect(parseLine('{"t":1,"level":"loud","source":"x","message":"y"}')).toBeNull()
  })
})

describe('captured outcomes', () => {
  const collect = (): { entries: LogEntry[]; off: () => void } => {
    const entries: LogEntry[] = []
    const off = log.onEntry((e) => void entries.push(e))
    return { entries, off }
  }

  it('logs agent error kinds only, never the message', () => {
    let listener: ((signal: { kind: string; event?: { type: string; code?: string; message?: string } }) => void) | null = null
    const off = captureAgentErrors({ onControl: (fn) => ((listener = fn), () => (listener = null)) })
    const { entries, off: stop } = collect()
    listener!({ kind: 'event', event: { type: 'error', code: 'rate-limited', message: 'my private chat text' } })
    listener!({ kind: 'event', event: { type: 'text', message: 'hello' } })
    listener!({ kind: 'claim' })
    stop()
    off()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn', source: 'agent', data: { kind: 'rate-limited' } })
    expect(JSON.stringify(entries)).not.toContain('private')
    expect(listener).toBeNull()
  })

  it('finds the routine runs that ended, ignoring the first look', () => {
    const seen = new Map<string, number | null>()
    const item = (id: string, lastRunAt: number | null, lastStatus: RoutineOutcomeItem['lastStatus'] = 'ok'): RoutineOutcomeItem => ({ id, lastRunAt, lastStatus })
    expect(endedRuns(seen, [item('a', 10), item('b', null)], true)).toEqual([])
    expect(endedRuns(seen, [item('a', 10), item('b', null)], false)).toEqual([])
    expect(endedRuns(seen, [item('a', 20, 'error'), item('b', 5, null)], false)).toEqual([{ status: 'error' }, { status: 'other' }])
    expect(endedRuns(seen, [item('c', 7)], false)).toEqual([{ status: 'ok' }])
    expect([...seen.keys()]).toEqual(['c'])
  })

  it('logs routine outcomes without names, and stops when asked', () => {
    let items: Array<RoutineOutcomeItem & { name: string }> = [{ id: 'r1', lastRunAt: 1, lastStatus: 'ok', name: 'Morning news' }]
    const listeners = new Set<(items: RoutineOutcomeItem[]) => void>()
    const off = captureRoutineOutcomes({ list: () => items, on: (_e, fn) => listeners.add(fn), off: (_e, fn) => listeners.delete(fn) })
    const { entries, off: stop } = collect()
    items = [{ ...items[0]!, lastRunAt: 2, lastStatus: 'error' }]
    for (const fn of listeners) fn(items)
    stop()
    off()
    expect(listeners.size).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn', source: 'routines', data: { status: 'error' } })
    expect(JSON.stringify(entries)).not.toContain('Morning')
  })

  it('tells an expected speech helper exit from a crash', () => {
    const { entries, off } = collect()
    captureSpeechExit(0, true)
    captureSpeechExit(9, false)
    off()
    expect(entries.map((e) => [e.level, e.source])).toEqual([
      ['info', 'speech'],
      ['warn', 'speech'],
    ])
  })
})
