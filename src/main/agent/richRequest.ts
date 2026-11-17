/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BetaMessageParam, BetaToolUnion, MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { LocalToolSnapshot } from '@shared/connectors'
import { replyToolParams } from './replyTools'
import { compactionParts, requestMessages } from './compaction'
import { CODE_EXECUTION_BETA, containerParam, withDocuments } from './documents'
import { localToolParams } from './localTools'

// What the richer chat features add to one Messages API request, applied
// after the base buildRequest so the base shape stays as it was for chats
// without them: documents (code execution, container skills, basic web
// tools), compaction, the reply client tools, local connector tools, and
// mcp_toolset configs that keep tools that were off when the chat started
// off for its whole life.

export interface RichRequest {
  documents: boolean
  containerId: string | null
  compaction: boolean
  /** An on-demand summary request (SS-03). */
  manual?: boolean
  /** The reply client tools, frozen at the first message. */
  replyTools: readonly string[]
  localTools: readonly LocalToolSnapshot[]
  /** mcp_server_name to the tools disabled when the chat started. */
  mcpDisabled: Readonly<Record<string, readonly string[]>>
}

type Request = Omit<MessageCreateParamsStreaming, 'stream'>

export function applyRichRequest(request: Request, c: RichRequest): Request {
  let tools: BetaToolUnion[] = [...(request.tools ?? [])]
  if (c.documents) tools = withDocuments(tools)
  tools = tools.map((tool) => {
    if (tool.type !== 'mcp_toolset') return tool
    const off = c.mcpDisabled[tool.mcp_server_name] ?? []
    return off.length > 0 ? { ...tool, configs: Object.fromEntries([...off].sort().map((name) => [name, { enabled: false }])) } : tool
  })
  tools.push(...replyToolParams(c.replyTools), ...localToolParams(c.localTools))

  const messages = request.messages as BetaMessageParam[]
  const compaction = compactionParts({ compaction: c.compaction, messages, manual: c.manual === true })
  const betas = [...new Set([...(request.betas ?? []), ...(c.documents ? [CODE_EXECUTION_BETA] : []), ...compaction.betas])]
  const out: Request = { ...request, tools, messages: requestMessages(messages) }
  if (betas.length > 0) out.betas = betas
  if (c.documents) out.container = containerParam(c.containerId)
  if (compaction.context_management) out.context_management = compaction.context_management
  if (compaction.compaction) out.compaction = compaction.compaction
  return out
}
