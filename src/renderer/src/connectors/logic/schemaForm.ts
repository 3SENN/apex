/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageKey } from '@shared/i18n/core'

// CH-40: the editable approval's model. A tool's JSON Schema becomes a form
// (strings, a multiline body, numbers, booleans, enums, email lists as chips,
// dates and times with a time zone); anything else is edited as JSON. Fields
// you didn't touch keep their exact original value, so the summary of your
// edits lists only what you changed. Main checks the result against the
// schema again (ajv) before the call goes out.

export type FieldKind = 'text' | 'multiline' | 'email' | 'emails' | 'number' | 'boolean' | 'enum' | 'datetime' | 'date' | 'time' | 'json'

export interface FormField {
  key: string
  label: string
  description: string
  kind: FieldKind
  required: boolean
  integer?: boolean
  options?: (string | number)[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface FormModel {
  fields: FormField[]
  /** False when the schema isn't an object with properties: only the JSON view works. */
  usable: boolean
}

export interface DateTimeValue {
  /** Wall time, `YYYY-MM-DDTHH:mm`, in `zone`. */
  local: string
  zone: string
}

export type FieldValue = string | boolean | string[] | DateTimeValue
export type FormValues = Record<string, FieldValue>

export interface FieldError {
  key: MessageKey
  vars?: Record<string, string | number>
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const MULTILINE_NAME = /(^|_)(body|content|message|text|description|notes?|comment|markdown|html)$/i
const EMAIL_LIST_NAME = /^(to|cc|bcc|recipients?|attendees|emails?|invitees|guests)$/i
const EMAIL_NAME = /(^|_)(email|e_mail)$|^(from|reply_?to|sender)$/i
const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/

/** create_issue → "Create issue"; dueDate → "Due date". */
export function humanizeKey(key: string): string {
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key
}

/** The schema's own type, ignoring a null alternative ("type": ["string", "null"]). */
function typeOf(schema: Json): string | null {
  const t = schema.type
  if (typeof t === 'string') return t
  if (Array.isArray(t)) {
    const rest = t.filter((x) => x !== 'null')
    return rest.length === 1 && typeof rest[0] === 'string' ? rest[0] : null
  }
  if (Array.isArray(schema.enum)) return 'enum'
  return null
}

function fieldFor(key: string, schema: Json, required: boolean): FormField {
  const base = {
    key,
    label: typeof schema.title === 'string' && schema.title.trim() ? schema.title.trim().slice(0, 80) : humanizeKey(key),
    description: typeof schema.description === 'string' ? schema.description.trim().slice(0, 300) : '',
    required,
  }
  const type = typeOf(schema)
  const format = typeof schema.format === 'string' ? schema.format : ''
  const values = Array.isArray(schema.enum) ? schema.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number') : null
  if (values && values.length > 0 && values.length === (schema.enum as unknown[]).length) return { ...base, kind: 'enum', options: values }
  if (type === 'boolean') return { ...base, kind: 'boolean' }
  if (type === 'number' || type === 'integer') {
    return {
      ...base,
      kind: 'number',
      integer: type === 'integer',
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
    }
  }
  if (type === 'string') {
    const lengths = {
      ...(typeof schema.minLength === 'number' ? { minLength: schema.minLength } : {}),
      ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
    }
    if (format === 'date-time') return { ...base, kind: 'datetime' }
    if (format === 'date') return { ...base, kind: 'date' }
    if (format === 'time') return { ...base, kind: 'time' }
    if (format === 'email' || EMAIL_NAME.test(key)) return { ...base, kind: 'email', ...lengths }
    const multiline = MULTILINE_NAME.test(key) || (typeof schema.maxLength === 'number' && schema.maxLength > 300) || format === 'markdown'
    return { ...base, kind: multiline ? 'multiline' : 'text', ...lengths }
  }
  if (type === 'array' && isObject(schema.items)) {
    const items = schema.items
    if (typeOf(items) === 'string' && (items.format === 'email' || EMAIL_LIST_NAME.test(key))) return { ...base, kind: 'emails' }
  }
  return { ...base, kind: 'json' }
}

/** The form for a tool's input schema; properties keep the schema's order. */
export function buildFormModel(schema: unknown): FormModel {
  if (!isObject(schema) || !isObject(schema.properties)) return { fields: [], usable: false }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [])
  const fields = Object.entries(schema.properties)
    .filter(([, s]) => isObject(s))
    .slice(0, 60)
    .map(([key, s]) => fieldFor(key, s as Json, required.has(key)))
  return { fields, usable: fields.length > 0 }
}

// ---- time zones ----

/** The viewer's own time zone, or UTC. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const FALLBACK_ZONES = ['UTC', 'Europe/London', 'Europe/Brussels', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney']

/** Every time zone the runtime knows, with UTC and the viewer's own first. */
export function timeZones(): string[] {
  let all: string[] = FALLBACK_ZONES
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (fn) all = fn('timeZone')
  } catch {
    // The short list above.
  }
  const own = localZone()
  return [...new Set(['UTC', own, ...all])]
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Minutes the zone is ahead of UTC at an instant. */
export function zoneOffset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000)
}

/** An ISO date-time shown as wall time in a zone. */
export function toWallTime(iso: string, zone: string): string | null {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const shifted = new Date(at + zoneOffset(zone, at) * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

/** Wall time in a zone as an ISO date-time with that zone's offset ("2026-11-02T15:00:00+01:00"). */
export function fromWallTime(value: DateTimeValue): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.local)
  if (!m) return null
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  let offset: number
  try {
    offset = zoneOffset(value.zone, guess - zoneOffset(value.zone, guess) * 60_000)
  } catch {
    return null
  }
  if (value.zone === 'UTC') return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// ---- emails ----

/** The address in "Name <a@b.co>", or the text itself. */
export function addressOf(entry: string): string {
  const m = /<([^<>]+)>\s*$/.exec(entry)
  return (m?.[1] ?? entry).trim()
}

export function isEmail(entry: string): boolean {
  return EMAIL.test(addressOf(entry))
}

/** Splits pasted or typed text into chips at commas, semicolons and new lines (and spaces between bare addresses). */
export function splitEmails(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .flatMap((part) => (/</.test(part) ? [part] : part.split(/\s+/)))
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- values ----

function valueFor(field: FormField, raw: unknown, zone: string): FieldValue {
  switch (field.kind) {
    case 'boolean':
      return raw === true
    case 'emails':
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : typeof raw === 'string' ? splitEmails(raw) : []
    case 'datetime': {
      const wall = typeof raw === 'string' ? toWallTime(raw, zone) : null
      return { local: wall ?? '', zone }
    }
    case 'number':
      return typeof raw === 'number' ? String(raw) : ''
    case 'enum':
      return raw === undefined || raw === null ? '' : String(raw)
    case 'json':
      return raw === undefined ? '' : JSON.stringify(raw, null, 2)
    default:
      return typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw)
  }
}

/** The form's values for an input object. */
export function valuesFromInput(model: FormModel, input: unknown, zone = localZone()): FormValues {
  const source = isObject(input) ? input : {}
  return Object.fromEntries(model.fields.map((f) => [f.key, valueFor(f, source[f.key], zone)]))
}

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Parsed = { ok: true; value: unknown; omit: boolean } | { ok: false; error: FieldError }

function parseField(field: FormField, value: FieldValue): Parsed {
  const empty = (): Parsed => (field.required ? { ok: false, error: { key: 'connectors.form.required' } } : { ok: true, value: undefined, omit: true })
  switch (field.kind) {
    case 'boolean':
      return { ok: true, value: value === true, omit: false }
    case 'emails': {
      const list = Array.isArray(value) ? value : []
      if (list.length === 0) return field.required ? { ok: false, error: { key: 'connectors.form.required' } } : { ok: true, value: [], omit: false }
      const bad = list.find((e) => !isEmail(e))
      return bad ? { ok: false, error: { key: 'connectors.form.email', vars: { value: bad } } } : { ok: true, value: list, omit: false }
    }
    case 'datetime': {
      const dt = value as DateTimeValue
      if (!dt.local) return empty()
      const iso = fromWallTime(dt)
      return iso ? { ok: true, value: iso, omit: false } : { ok: false, error: { key: 'connectors.form.datetime' } }
    }
    case 'number': {
      const text = String(value).trim()
      if (!text) return empty()
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: { key: 'connectors.form.number' } }
      if (field.integer && !Number.isInteger(n)) return { ok: false, error: { key: 'connectors.form.integer' } }
      if (field.minimum !== undefined && n < field.minimum) return { ok: false, error: { key: 'connectors.form.min', vars: { min: field.minimum } } }
      if (field.maximum !== undefined && n > field.maximum) return { ok: false, error: { key: 'connectors.form.max', vars: { max: field.maximum } } }
      return { ok: true, value: n, omit: false }
    }
    case 'enum': {
      const text = String(value)
      if (!text) return empty()
      const option = field.options?.find((o) => String(o) === text)
      return option === undefined ? { ok: false, error: { key: 'connectors.form.enum' } } : { ok: true, value: option, omit: false }
    }
    case 'json': {
      const text = String(value).trim()
      if (!text) return empty()
      try {
        return { ok: true, value: JSON.parse(text), omit: false }
      } catch {
        return { ok: false, error: { key: 'connectors.form.json' } }
      }
    }
    case 'email': {
      const text = String(value).trim()
      if (!text) return empty()
      return isEmail(text) ? { ok: true, value: text, omit: false } : { ok: false, error: { key: 'connectors.form.email', vars: { value: text } } }
    }
    default: {
      const text = String(value)
      if (!text.trim()) return empty()
      if (field.minLength !== undefined && text.length < field.minLength) return { ok: false, error: { key: 'connectors.form.minLength', vars: { min: field.minLength } } }
      if (field.maxLength !== undefined && text.length > field.maxLength) return { ok: false, error: { key: 'connectors.form.maxLength', vars: { max: field.maxLength } } }
      if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, error: { key: 'connectors.form.datetime' } }
      if (field.kind === 'time' && !/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return { ok: false, error: { key: 'connectors.form.datetime' } }
      return { ok: true, value: text, omit: false }
    }
  }
}

/**
 * The input the form describes. Untouched fields keep the original's exact
 * value; keys the schema doesn't list pass through unchanged.
 */
export function inputFromValues(model: FormModel, values: FormValues, original: unknown, initial: FormValues): { input: Json; errors: Record<string, FieldError> } {
  const input: Json = isObject(original) ? { ...original } : {}
  const errors: Record<string, FieldError> = {}
  for (const field of model.fields) {
    const value = values[field.key]
    if (value === undefined) continue
    if (sameValue(value, initial[field.key])) {
      // Untouched: keep it as it was (or absent), but still say when a required field is empty.
      const had = field.key in input && input[field.key] !== undefined && input[field.key] !== ''
      if (field.required && !had) errors[field.key] = { key: 'connectors.form.required' }
      continue
    }
    const parsed = parseField(field, value)
    if (!parsed.ok) {
      errors[field.key] = parsed.error
      continue
    }
    if (parsed.omit) delete input[field.key]
    else input[field.key] = parsed.value
  }
  return { input, errors }
}

/** The raw JSON view's text, checked: it must be one object. */
export function parseRawInput(text: string): { ok: true; value: Json } | { ok: false; error: FieldError } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: { key: 'connectors.form.rawInvalid', vars: { detail: err instanceof Error ? err.message.slice(0, 120) : '' } } }
  }
  return isObject(value) ? { ok: true, value } : { ok: false, error: { key: 'connectors.form.rawObject' } }
}

// ---- edit summary ----

export interface EditChange {
  key: string
  change: 'added' | 'changed' | 'removed'
  before: string
  after: string
}

/** A value as one short line for the summary. */
export function shortValue(value: unknown, max = 80): string {
  if (value === undefined) return ''
  const text = typeof value === 'string' ? value : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join(', ') : JSON.stringify(value)
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What you changed, top-level key by key, in the original's order and then new keys. */
export function editSummary(original: unknown, edited: unknown): EditChange[] {
  const a = isObject(original) ? original : {}
  const b = isObject(edited) ? edited : {}
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  const out: EditChange[] = []
  for (const key of keys) {
    const inA = key in a && a[key] !== undefined
    const inB = key in b && b[key] !== undefined
    if (inA && inB && JSON.stringify(a[key]) === JSON.stringify(b[key])) continue
    if (!inA && !inB) continue
    out.push({ key, change: !inA ? 'added' : !inB ? 'removed' : 'changed', before: shortValue(a[key]), after: shortValue(b[key]) })
  }
  return out
}
