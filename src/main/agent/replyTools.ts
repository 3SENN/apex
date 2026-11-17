/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { z } from 'zod'

// The artifact and suggestion client tools offered to the model (fixed names; inputs
// validated with zod; tool_choice stays auto). save_artifact streams its
// input eagerly so a long artifact shows while it is written.

export const REPLY_TOOLS = {
  suggestNextSteps: 'suggest_next_steps',
  saveArtifact: 'save_artifact',
  suggestConnector: 'suggest_connector',
} as const

export type ReplyToolName = (typeof REPLY_TOOLS)[keyof typeof REPLY_TOOLS]

export const ARTIFACT_FORMATS = ['markdown', 'html', 'svg', 'csv', 'json', 'text'] as const
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number]

/** DS-63's next-step block: 1 to 4 short steps the person can toggle into the draft. */
export const suggestNextStepsInput = z.object({
  heading: z.string().trim().min(1).max(120).optional(),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(4),
}).strict()

export const saveArtifactInput = z.object({
  title: z.string().trim().min(1).max(200),
  format: z.enum(ARTIFACT_FORMATS),
  content: z.string().min(1).max(2_000_000),
}).strict()

/** CH-41: the model asks for a connector it doesn't have; the card offers to connect it. */
export const suggestConnectorInput = z.object({
  service: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(500),
}).strict()

export const REPLY_TOOL_INPUTS = {
  [REPLY_TOOLS.suggestNextSteps]: suggestNextStepsInput,
  [REPLY_TOOLS.saveArtifact]: saveArtifactInput,
  [REPLY_TOOLS.suggestConnector]: suggestConnectorInput,
} as const satisfies Record<ReplyToolName, z.ZodType>

// Definitions as the model sees them, the frozen set per chat, and the
// runner both engines share: the API-key loop routes calls here, and Claude
// Code reaches the same tools through Apex's local MCP server.

const REPLY_TOOL_DESCRIPTIONS: Record<ReplyToolName, string> = {
  suggest_next_steps:
    'Offer the user one to four short next steps they might want, shown under your reply as choices they can add to their next message. Use it at the end of a reply when there are clear follow-ups; write each step as something the user would say.',
  save_artifact:
    'Save a finished piece of work as a file in the user’s Library › Files: a document in Markdown, a web page (html), an image (svg), a table (csv), data (json) or plain text. Use it for things worth keeping or opening on their own, not for short answers. HTML and SVG open as a sandboxed page with no network access.',
  suggest_connector:
    `Tell the user that a service they mentioned could be connected to ${BRAND_NAME} (for example their calendar, notes or issue tracker) so you can work with it. Give the service’s name and, in one sentence, why connecting it would help with what they asked.`,
}

/** Which of these tools a chat gets, fixed at its first message. Background routine runs never wait on the user, so they only save artifacts. */
export function replyToolNames(setup: { routine: boolean }): ReplyToolName[] {
  const names: ReplyToolName[] = setup.routine ? ['save_artifact'] : ['save_artifact', 'suggest_connector', 'suggest_next_steps']
  return names.sort()
}

export function isReplyTool(name: string): name is ReplyToolName {
  return name in REPLY_TOOL_INPUTS
}

function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return rest
}

export interface ReplyToolSpec {
  name: ReplyToolName
  description: string
  inputSchema: Record<string, unknown>
}

export function replyToolSpecs(names: readonly string[]): ReplyToolSpec[] {
  return names.filter(isReplyTool).map((name) => ({ name, description: REPLY_TOOL_DESCRIPTIONS[name], inputSchema: inputSchemaOf(REPLY_TOOL_INPUTS[name]) }))
}

/** The custom tool params for the API-key request; save_artifact streams its input. */
export function replyToolParams(names: readonly string[]): Array<{ name: string; description: string; input_schema: { type: 'object'; [key: string]: unknown }; eager_input_streaming?: boolean }> {
  return replyToolSpecs(names).map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: { ...spec.inputSchema, type: 'object' as const },
    ...(spec.name === REPLY_TOOLS.saveArtifact ? { eager_input_streaming: true } : {}),
  }))
}

const ARTIFACT_FILES: Record<ArtifactFormat, { extension: string; mediaType: string }> = {
  markdown: { extension: 'md', mediaType: 'text/markdown' },
  html: { extension: 'html', mediaType: 'text/html' },
  svg: { extension: 'svg', mediaType: 'image/svg+xml' },
  csv: { extension: 'csv', mediaType: 'text/csv' },
  json: { extension: 'json', mediaType: 'application/json' },
  text: { extension: 'txt', mediaType: 'text/plain' },
}

/** A safe file name for an artifact title. */
export function artifactFileName(title: string, format: ArtifactFormat): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'Untitled'
  return `${base}.${ARTIFACT_FILES[format].extension}`
}

export function artifactMediaType(format: ArtifactFormat): string {
  return ARTIFACT_FILES[format].mediaType
}

/** HTML and SVG open as an artifact tab (sandboxed), the rest in the viewer. */
export const isArtifactFormat = (format: ArtifactFormat): boolean => format === 'html' || format === 'svg'

/** The first zod issue as "field: message", so the model can fix its call. */
export function inputError(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path.length ? issue.path.join('.') : 'input'
  return `Invalid input for ${field}: ${issue?.message ?? 'not valid'}.`
}
