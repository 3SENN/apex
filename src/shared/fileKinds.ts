/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// How Atelier's viewer reads a file: its media type from the name, how
// it previews, which code language it is, and Markdown front matter. Pure,
// so main (the viewer service) and the chrome (the shared renderers, the
// chat files modal) agree.
import type { FilePreviewable } from './files'

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  xlsx: XLSX_MEDIA_TYPE,
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Source files by extension; the highlighter's language for each. */
const CODE_LANGUAGES: Record<string, CodeLanguage> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'py', sh: 'sh', bash: 'sh', zsh: 'sh',
  css: 'css', scss: 'css', less: 'css',
  xml: 'xml', plist: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
  sql: 'sql',
  go: 'c', rs: 'c', java: 'c', kt: 'c', swift: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', php: 'c',
}

export type CodeLanguage = 'js' | 'json' | 'py' | 'sh' | 'css' | 'xml' | 'yaml' | 'sql' | 'c' | 'plain'

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The media type for a file name; text for source code, octet-stream when unknown. */
export function mediaTypeOf(name: string): string {
  const ext = extensionOf(name)
  if (Object.hasOwn(MEDIA_TYPES, ext)) return MEDIA_TYPES[ext] as string
  if (Object.hasOwn(CODE_LANGUAGES, ext)) return 'text/x-source'
  return 'application/octet-stream'
}

export function codeLanguageOf(name: string): CodeLanguage {
  const ext = extensionOf(name)
  return Object.hasOwn(CODE_LANGUAGES, ext) ? (CODE_LANGUAGES[ext] as CodeLanguage) : 'plain'
}

/** How a file previews, from its name first (it knows code and sheets) and its media type second. */
export function previewableOf(name: string, mediaType: string, size: number): FilePreviewable {
  if (size === 0) return 'empty'
  const ext = extensionOf(name)
  const type = mediaType.split(';')[0]?.trim().toLowerCase() || mediaTypeOf(name)
  if (type === 'image/svg+xml' || ext === 'svg') return 'svg'
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (type === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown'
  if (type === 'text/html' || ext === 'html' || ext === 'htm') return 'html'
  if (type === 'text/csv' || type === 'text/tab-separated-values' || type === XLSX_MEDIA_TYPE || ext === 'csv' || ext === 'tsv' || ext === 'xlsx') return 'sheet'
  if (Object.hasOwn(CODE_LANGUAGES, ext) || type === 'text/x-source' || type === 'application/json' || type === 'application/xml' || type === 'application/yaml') return 'code'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/octet-stream' && ext === '') return 'unknown'
  if (type === 'application/octet-stream' || type.startsWith('application/')) return 'binary'
  return 'unknown'
}

/** Kinds whose content is text the viewer can show and, from an editable source, edit. */
export function isTextPreviewable(previewable: FilePreviewable, name: string): boolean {
  if (previewable === 'sheet') return extensionOf(name) !== 'xlsx'
  return previewable === 'text' || previewable === 'markdown' || previewable === 'code' || previewable === 'html' || previewable === 'svg'
}

/** HTML, SVG and Markdown can open as a sandboxed artifact tab. */
export function isArtifactable(previewable: FilePreviewable): boolean {
  return previewable === 'html' || previewable === 'svg' || previewable === 'markdown'
}

export interface Frontmatter {
  data: Record<string, string>
  /** The text after the closing fence; the whole text when there is none. */
  body: string
}

const FENCE = /^---[ \t]*\r?\n/

/**
 * Splits YAML-style front matter ("---" lines around "key: value" pairs) off
 * a Markdown file. Only flat string values are read; lists and nested maps are
 * kept as their raw text so nothing is lost from the header.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const source = text.replace(/^﻿/, '')
  if (!FENCE.test(source)) return { data: {}, body: text }
  const rest = source.replace(FENCE, '')
  const close = /^---[ \t]*$/m.exec(rest)
  if (!close) return { data: {}, body: text }
  const head = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, '')
  const data: Record<string, string> = {}
  let last: string | null = null
  for (const line of head.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}):[ \t]*(.*)$/.exec(line)
    if (pair) {
      last = (pair[1] as string).trim()
      data[last] = unquote((pair[2] as string).trim())
    } else if (last !== null && /^\s+\S/.test(line)) {
      // A continuation (a list item or folded text) joins its key's value.
      data[last] = [data[last], line.trim()].filter(Boolean).join(' ')
    }
  }
  return { data, body }
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1)
  return value
}

/** A short type label for a file's pill ("Markdown", "Spreadsheet", "PNG image"). */
export function kindLabelKey(previewable: FilePreviewable): `files.kind.${FilePreviewable}` {
  return `files.kind.${previewable}`
}
