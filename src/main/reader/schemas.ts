/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { READER_LIMITS, READER_TAGS, countNodes, type ReaderArticle, type ReaderElement, type ReaderNode, type ReaderServices } from '@shared/reader'

// Reader schemas (RD-01, RD-03): Services.reader's arguments, and the article
// a page sends, checked again in main: only the allowed elements, web or mail
// links, http(s) or small inline images, and the size limits.

const tabId = z.string().min(1).max(128)

export const READER_SCHEMAS: { reader: { [M in keyof ReaderServices['reader']]: z.ZodType<unknown[]> } } = {
  reader: {
    toggle: z.tuple([tabId]),
    open: z.tuple([tabId]),
    close: z.tuple([tabId]),
    article: z.tuple([tabId]),
  },
}

const webUrl = z
  .string()
  .max(READER_LIMITS.url)
  .regex(/^(https?:\/\/|mailto:)/i)
const imageUrl = z.union([
  z
    .string()
    .max(READER_LIMITS.url)
    .regex(/^https?:\/\//i),
  z
    .string()
    .max(READER_LIMITS.dataImage)
    .regex(/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i),
])
const id = z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/)
const size = z.number().int().min(1).max(20_000)

const elementSchema: z.ZodType<ReaderElement> = z.lazy(() =>
  z
    .object({
      tag: z.enum(READER_TAGS),
      href: webUrl.optional(),
      anchor: id.optional(),
      src: imageUrl.optional(),
      alt: z.string().max(READER_LIMITS.attr).optional(),
      width: size.optional(),
      height: size.optional(),
      start: z.number().int().min(-1_000_000).max(1_000_000).optional(),
      colSpan: z.number().int().min(1).max(1000).optional(),
      rowSpan: z.number().int().min(1).max(1000).optional(),
      id: id.optional(),
      title: z.string().max(READER_LIMITS.attr).optional(),
      children: z.array(nodeSchema).max(READER_LIMITS.nodes).optional(),
    })
    .strict()
    .refine((el) => el.tag === 'a' || (el.href === undefined && el.anchor === undefined), 'Only links carry an address.')
    .refine((el) => el.tag === 'img' || el.src === undefined, 'Only images carry a source.'),
) as z.ZodType<ReaderElement>

const nodeSchema: z.ZodType<ReaderNode> = z.lazy(() => z.union([z.string().max(READER_LIMITS.chars), elementSchema]))

const meta = (max: number) => z.string().max(max).nullable()

export const articleSchema: z.ZodType<ReaderArticle> = z
  .object({
    url: z.string().max(READER_LIMITS.url),
    title: z.string().max(READER_LIMITS.title),
    byline: meta(READER_LIMITS.title),
    siteName: meta(READER_LIMITS.title),
    excerpt: meta(READER_LIMITS.meta),
    lang: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/)
      .nullable(),
    dir: z.enum(['ltr', 'rtl']).nullable(),
    publishedTime: meta(64),
    words: z.number().int().min(0).max(10_000_000),
    minutes: z.number().int().min(1).max(100_000),
    body: z.array(nodeSchema).min(1).max(READER_LIMITS.nodes),
  })
  .strict()
  .refine((a) => countNodes(a.body) <= READER_LIMITS.nodes, 'The article is too large.')

export const pageStateSchema = z.object({ url: z.string().max(READER_LIMITS.url), readerable: z.boolean() }).strict()

export const pageResultSchema = z.union([
  z.object({ requestId: z.number().int().nonnegative(), ok: z.literal(true), article: articleSchema }).strict(),
  z.object({ requestId: z.number().int().nonnegative(), ok: z.literal(false), error: z.string().max(200) }).strict(),
])
