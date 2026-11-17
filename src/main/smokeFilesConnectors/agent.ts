/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent } from '@shared/ipc'
import { CODE_EXECUTION_BETA } from '../agent/documents'
import { ON_DEMAND_BETA, THRESHOLD_BETA } from '../agent/compaction'
import { SMOKE_GENERATED, smokeRichChat } from '../agent/smokeClientRichChat'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// The agent turn: request building (documents, compaction), rich-card
// events and generated files. Offline only: the scripted smoke client
// answers "smoke:" messages with compaction blocks, code-execution outputs
// and client-tool calls; nothing reaches the network.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(condition: () => boolean, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const logOf = (ctx: SmokeContext, id: string): AgentEvent[] => ctx.host.view(id).log

async function run(ctx: SmokeContext, text: string, chatId?: string): Promise<string> {
  const id = chatId ?? ctx.host.start(text)
  if (chatId) ctx.host.send(chatId, text)
  await waitFor(() => !ctx.host.isRunning(id), `the chat to answer “${text}”`)
  return id
}

export const checks: SmokeCheck[] = [
  {
    name: 'threshold compaction keeps its block and shows a card; manual compaction starts later requests from the summary',
    async run(ctx) {
      smokeRichChat.reset()
      const id = await run(ctx, 'smoke:compaction please')
      assert(smokeRichChat.lastRequest?.betas?.includes(THRESHOLD_BETA), `betas: ${JSON.stringify(smokeRichChat.lastRequest?.betas)}`)
      const done = logOf(ctx, id).find((e) => e.type === 'compaction' && e.state === 'done')
      assert(done, 'no compaction card')
      const saved = ctx.chats.load(id).messages.filter((m) => m.role === 'assistant').at(-1)
      assert(Array.isArray(saved?.content) && saved.content[0]?.type === 'compaction', 'the compaction block was not kept')

      ctx.host.compact(id)
      await waitFor(() => logOf(ctx, id).some((e) => e.type === 'compaction' && e.trigger === 'manual' && e.state !== 'running'), 'the manual compaction')
      assert(smokeRichChat.lastRequest?.betas?.includes(ON_DEMAND_BETA), 'manual compaction sent no on-demand beta')
      await run(ctx, 'and then?', id)
      const first = smokeRichChat.lastRequest?.messages[0]
      assert(Array.isArray(first?.content) && (first.content as Array<{ type: string }>)[0]?.type === 'compaction', 'the next request did not start from the summary')
    },
  },
  {
    name: 'Files and documents runs code with the skills, reuses the container and saves the generated file',
    async run(ctx) {
      const before = ctx.settings.get().documents
      ctx.settings.update({ documents: true })
      try {
        smokeRichChat.reset()
        const id = await run(ctx, 'smoke:document make a table')
        const request = smokeRichChat.lastRequest
        assert(request?.betas?.includes(CODE_EXECUTION_BETA), 'no code-execution beta')
        assert(request?.tools?.some((t) => t.type === 'code_execution_20260521'), 'no code execution tool')
        assert(!request?.tools?.some((t) => t.type?.endsWith('_20260209')), 'dynamic web tools went out with code execution')
        const produced = logOf(ctx, id).find((e) => e.type === 'file-produced')
        assert(produced?.type === 'file-produced' && produced.file.name === SMOKE_GENERATED.name, 'the generated file was not saved')
        await run(ctx, 'thanks', id)
        assert(smokeRichChat.lastRequest?.container?.id === 'container_smoke_1', 'the container was not reused')
      } finally {
        ctx.settings.update({ documents: before })
      }
    },
  },
  {
    name: 'client tools show next steps, a saved artifact and a connector card',
    async run(ctx) {
      const steps = await run(ctx, 'smoke:suggest')
      assert(logOf(ctx, steps).some((e) => e.type === 'suggestions' && e.items.length === 2), 'no suggestions card')
      const artifact = await run(ctx, 'smoke:artifact')
      const file = logOf(ctx, artifact).filter((e) => e.type === 'file-produced').at(-1)
      assert(file?.type === 'file-produced' && file.file.artifact && file.file.state === 'ready', `artifact: ${JSON.stringify(file)}`)
      const connector = await run(ctx, 'smoke:connector')
      assert(logOf(ctx, connector).some((e) => e.type === 'connector-needed' && e.service === 'Linear'), 'no connector card')
    },
  },
]
export const shots: ShotSpec[] = []
