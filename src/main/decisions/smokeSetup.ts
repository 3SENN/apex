/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DECISIONS_DEFAULTS } from '@shared/decisions'
import { SMOKE_SERVER } from './smokeServer'
import { assert, waitFor } from '../smokeKit'
import type { SmokeCheck } from '../smokeBrowser/types'
import { smokeRichChat } from '../agent/smokeClientRichChat'
import { PER_MESSAGE_EFFORT_BETA } from '../agent/turnDecisions'
import { decider } from './service'

// DC-15's smoke check (APEX_SMOKE_ONLY=decisions): the effort use is off by
// default; switched on, the stand-in model is sure every message needs no
// thinking (level 0), so a message on the API key runs at low through an
// effort-only system message the chat keeps, while the request's own effort
// stays the chat's (so the prompt cache does too).

const OWN_SERVER = SMOKE_SERVER

export const effortPerMessageCheck: SmokeCheck = {
  name: 'decisions: with the effort use on, a message the model is sure needs no thinking runs at low, and the chat keeps the change',
  async run(ctx) {
    const before = new Set(ctx.chats.list().map((c) => c.id))
    try {
      ctx.settings.update({ decisions: OWN_SERVER })
      assert(!decider().active('effort'), 'the effort use is off by default')
      ctx.settings.update({
        decisions: {
          ...OWN_SERVER,
          uses: { ...DECISIONS_DEFAULTS.uses, effort: true },
        },
      })
      assert(decider().active('effort'), 'the effort use is on once switched on')
      smokeRichChat.reset()
      const id = ctx.host.start('thanks!', {
        model: 'claude-opus-5-5',
        effort: 'medium',
        engine: 'api-key',
      })
      await waitFor(() => !ctx.host.isRunning(id) && ctx.chats.summary(id)?.status === 'finished', 15_000, 'the chat to finish')
      const content = ctx.chats.load(id)
      assert(JSON.stringify(content.effortMarks) === JSON.stringify([{ at: 0, effort: 'low' }]), `the chat keeps the change (got ${JSON.stringify(content.effortMarks)})`)
      const request = smokeRichChat.lastRequest as (typeof smokeRichChat.lastRequest & { output_config?: { effort?: string } }) | null
      const sent = (request?.messages ?? []) as Array<{
        role: string
        output_config?: { effort?: string } | null
      }>
      assert(
        sent.some((m) => m.role === 'system' && m.output_config?.effort === 'low'),
        'the request carries the effort message',
      )
      assert((request?.betas ?? []).includes(PER_MESSAGE_EFFORT_BETA), 'with the beta that reads it')
      assert(request?.output_config?.effort === 'medium', `the request’s own effort stays the chat’s (got ${request?.output_config?.effort})`)
      assert(
        Object.values(content.details).some((d) => d.effort === 'low'),
        'the turn’s details show the effort',
      )
    } finally {
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
      const started = ctx.chats
        .list()
        .filter((c) => !before.has(c.id))
        .map((c) => c.id)
      await waitFor(() => started.every((id) => !ctx.host.isRunning(id)), 10_000, 'the chat to finish').catch(() => undefined)
      if (started.length) ctx.chats.remove(started)
    }
  },
}
