/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { actionLabelOf, executionOf } from '@shared/connectors'
import {
  buildFormModel,
  editSummary,
  fromWallTime,
  inputFromValues,
  isEmail,
  parseRawInput,
  splitEmails,
  toWallTime,
  valuesFromInput,
  type DateTimeValue,
} from '../src/renderer/src/connectors/logic/schemaForm'
import { commandLine, draftExecution, emptyDraft, envRow, logoProblem, splitCommandLine, toInput, validateDraft } from '../src/renderer/src/connectors/logic/addForm'

// CH-40's schema-to-form model and edit summary, and SK-15's custom
// server form checks (each problem names its field).

const schema = {
  type: 'object',
  required: ['to', 'subject'],
  properties: {
    to: { type: 'array', items: { type: 'string', format: 'email' } },
    cc: { type: 'array', items: { type: 'string' } },
    subject: { type: 'string', title: 'Subject line', maxLength: 120 },
    body: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    urgent: { type: 'boolean' },
    start: { type: 'string', format: 'date-time' },
    meta: { type: 'object' },
  },
}

const input = { to: ['ana@example.com'], subject: 'Hello', body: 'Line one', priority: 'normal', count: 2, urgent: false, start: '2026-11-02T14:00:00Z', meta: { a: 1 }, extra: 'kept' }

describe('the schema form model', () => {
  const model = buildFormModel(schema)

  it('picks a control for each property, in schema order', () => {
    expect(model.usable).toBe(true)
    expect(model.fields.map((f) => [f.key, f.kind])).toEqual([
      ['to', 'emails'],
      ['cc', 'emails'],
      ['subject', 'text'],
      ['body', 'multiline'],
      ['priority', 'enum'],
      ['count', 'number'],
      ['urgent', 'boolean'],
      ['start', 'datetime'],
      ['meta', 'json'],
    ])
    expect(model.fields.find((f) => f.key === 'subject')).toMatchObject({ label: 'Subject line', required: true, maxLength: 120 })
    expect(model.fields.find((f) => f.key === 'count')).toMatchObject({ integer: true, minimum: 1, maximum: 10 })
  })

  it('is unusable without object properties', () => {
    expect(buildFormModel({ type: 'string' }).usable).toBe(false)
    expect(buildFormModel(null).usable).toBe(false)
  })

  it('round-trips untouched values exactly, unknown keys included', () => {
    const initial = valuesFromInput(model, input, 'Europe/Brussels')
    expect(initial.start).toEqual({ local: '2026-11-02T15:00', zone: 'Europe/Brussels' })
    const out = inputFromValues(model, initial, input, initial)
    expect(out.errors).toEqual({})
    expect(out.input).toEqual(input)
    expect(editSummary(input, out.input)).toEqual([])
  })

  it('applies edits, validates them and sums them up', () => {
    const initial = valuesFromInput(model, input, 'UTC')
    const edited = { ...initial, to: ['ana@example.com', 'bo@example.org'], subject: 'Hi there', count: '3', urgent: true, body: '' }
    const out = inputFromValues(model, edited, input, initial)
    expect(out.errors).toEqual({})
    expect(out.input).toMatchObject({ to: ['ana@example.com', 'bo@example.org'], subject: 'Hi there', count: 3, urgent: true })
    expect('body' in out.input).toBe(false)
    const summary = editSummary(input, out.input)
    expect(summary.map((c) => [c.key, c.change])).toEqual([
      ['to', 'changed'],
      ['subject', 'changed'],
      ['body', 'removed'],
      ['count', 'changed'],
      ['urgent', 'changed'],
    ])
    expect(summary[0]).toMatchObject({ before: 'ana@example.com', after: 'ana@example.com, bo@example.org' })
  })

  it('names what is wrong with each field', () => {
    const initial = valuesFromInput(model, input, 'UTC')
    const bad = { ...initial, to: ['nope'], subject: '', count: '11', priority: 'urgent', meta: '{', start: { local: '2026-13', zone: 'UTC' } as DateTimeValue }
    const { errors } = inputFromValues(model, bad, input, initial)
    expect(errors.to).toEqual({ key: 'connectors.form.email', vars: { value: 'nope' } })
    expect(errors.subject?.key).toBe('connectors.form.required')
    expect(errors.count).toEqual({ key: 'connectors.form.max', vars: { max: 10 } })
    expect(errors.priority?.key).toBe('connectors.form.enum')
    expect(errors.meta?.key).toBe('connectors.form.json')
    expect(errors.start?.key).toBe('connectors.form.datetime')
    expect(inputFromValues(model, { ...initial, count: '2.5' }, input, initial).errors.count?.key).toBe('connectors.form.integer')
  })

  it('converts wall time in a zone to an ISO time with that offset', () => {
    expect(fromWallTime({ local: '2026-07-01T09:30', zone: 'Europe/Brussels' })).toBe('2026-07-01T09:30:00+02:00')
    expect(fromWallTime({ local: '2026-12-01T09:30', zone: 'America/New_York' })).toBe('2026-12-01T09:30:00-05:00')
    expect(fromWallTime({ local: '2026-12-01T09:30', zone: 'UTC' })).toBe('2026-12-01T09:30:00Z')
    expect(Date.parse(fromWallTime({ local: '2026-03-29T12:00', zone: 'Europe/Brussels' }) ?? '')).toBe(Date.parse('2026-03-29T10:00:00Z'))
    expect(toWallTime('2026-12-01T14:30:00Z', 'America/New_York')).toBe('2026-12-01T09:30')
    expect(fromWallTime({ local: 'nope', zone: 'UTC' })).toBeNull()
  })

  it('splits and checks recipients', () => {
    expect(splitEmails('a@x.io, b@y.io;c@z.io\nd@w.io e@v.io')).toEqual(['a@x.io', 'b@y.io', 'c@z.io', 'd@w.io', 'e@v.io'])
    expect(splitEmails('Ana Lee <ana@x.io>, bo@y.io')).toEqual(['Ana Lee <ana@x.io>', 'bo@y.io'])
    expect(isEmail('Ana Lee <ana@x.io>')).toBe(true)
    expect(isEmail('ana@x')).toBe(false)
  })

  it('checks the raw JSON view', () => {
    expect(parseRawInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseRawInput('[1]')).toEqual({ ok: false, error: { key: 'connectors.form.rawObject' } })
    expect(parseRawInput('{').ok).toBe(false)
  })

  it('names the confirm button after the action', () => {
    expect(actionLabelOf({ name: 'create_issue' })).toBe('Create issue')
    expect(actionLabelOf({ name: 'sendMail', title: 'Send email' })).toBe('Send email')
  })
})

describe('the custom server form', () => {
  it('names the wrong field', () => {
    const d = { ...emptyDraft('remote'), displayName: '', url: 'http://example.com/mcp', auth: 'api-key' as const }
    const errors = validateDraft(d)
    expect(errors.displayName?.key).toBe('connectors.error.nameMissing')
    expect(errors.url?.key).toBe('connectors.field.urlInsecure')
    expect(errors.headerName?.key).toBe('connectors.field.headerMissing')
    expect(errors.secret?.key).toBe('connectors.add.secretMissing')
    expect(validateDraft({ ...d, displayName: 'Mine', url: 'http://localhost:3000/mcp', auth: 'none' })).toEqual({})
    expect(validateDraft({ ...d, displayName: 'Mine', url: 'https://x.dev/mcp', auth: 'bearer', secret: 'abc', headerName: 'Host' }).headerName?.key).toBe('connectors.field.headerReserved')
  })

  it('checks a local command, its arguments and environment', () => {
    const d = { ...emptyDraft('local'), displayName: 'Notes', command: '', env: [envRow({ name: 'NODE_OPTIONS' }), envRow({ name: '1BAD' }), envRow({ name: 'TOKEN' }), envRow({ name: 'TOKEN' })], cwd: 'relative/dir' }
    const errors = validateDraft(d)
    expect(errors.command?.key).toBe('connectors.field.commandMissing')
    expect(errors['env.0.name']?.key).toBe('connectors.field.envForbidden')
    expect(errors['env.1.name']?.key).toBe('connectors.field.envName')
    expect(errors['env.3.name']?.key).toBe('connectors.field.envDuplicate')
    expect(errors.cwd?.key).toBe('connectors.field.cwd')
  })

  it('builds the save input and keeps saved secrets', () => {
    const local = toInput({ ...emptyDraft('local'), id: 'c1', displayName: ' Notes ', command: 'npx', args: ['-y', 'notes'], env: [envRow({ name: 'API_KEY', secret: true, saved: true }), envRow({ name: 'MODE', value: 'fast' })] })
    expect(local).toMatchObject({ id: 'c1', name: 'Notes', source: 'custom', auth: 'none', transport: { kind: 'local', command: 'npx', args: ['-y', 'notes'], cwd: null } })
    expect(local.transport.kind === 'local' && local.transport.env).toEqual([
      { name: 'API_KEY', secret: true, value: undefined },
      { name: 'MODE', secret: false, value: 'fast' },
    ])
    const remote = toInput({ ...emptyDraft('remote'), displayName: 'Mine', url: 'https://x.dev/mcp', auth: 'bearer', hasSecret: true })
    expect(remote.secret).toBeUndefined()
    expect(toInput({ ...emptyDraft('remote'), displayName: 'Mine', url: 'https://x.dev/mcp', auth: 'bearer', secret: ' t0k ' }).secret).toBe('t0k')
  })

  it('says where a server runs', () => {
    expect(draftExecution({ ...emptyDraft('remote'), url: 'https://x.dev/mcp' })).toBe('server')
    expect(draftExecution({ ...emptyDraft('remote'), url: 'https://x.dev/mcp', headerName: 'X-Key' })).toBe('local')
    expect(draftExecution({ ...emptyDraft('remote'), url: 'http://192.168.1.4/mcp' })).toBe('local')
    expect(draftExecution(emptyDraft('local'))).toBe('local')
    expect(executionOf({ kind: 'remote', url: 'https://x.dev/mcp', headerName: null }, 'api-key')).toBe('local')
  })

  it('splits a pasted command line without a shell, and quotes it back', () => {
    expect(splitCommandLine(`npx -y "@acme/notes server" --dir '/tmp/my notes' a\\ b`)).toEqual({ command: 'npx', args: ['-y', '@acme/notes server', '--dir', '/tmp/my notes', 'a b'] })
    expect(splitCommandLine(`node ""`)).toEqual({ command: 'node', args: [''] })
    expect(commandLine('npx', ['-y', 'my server', "it's"])).toBe(`npx -y 'my server' 'it'\\''s'`)
  })

  it('accepts only small images as a logo', () => {
    expect(logoProblem({ type: 'image/png', size: 1000 })).toBeNull()
    expect(logoProblem({ type: 'application/pdf', size: 10 })).toBe('connectors.field.logoType')
    expect(logoProblem({ type: 'image/png', size: 300 * 1024 })).toBe('connectors.field.logoSize')
  })
})
