/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DECISIONS_DEFAULTS } from '@shared/decisions'
import { SMOKE_SERVER } from './smokeServer'
import type { AutoGroupResult } from '@shared/services/tabs'
import { mainT } from '../i18n/mainT'
import { omnibox } from '../omnibox'
import { assert } from '../smokeKit'
import type { SmokeCheck } from '../smokeBrowser/types'

// Group tabs' smoke check (DC-18, APEX_SMOKE_ONLY=decisions): off, the rule
// groups the smoke server's pages by site (127.0.0.1) and Undo ends the
// group; with the stand-in model, which is sure of the first option, the
// tabs go under its first topic (Work) when the window has no named group,
// and a later tab joins the window's first named group. The command bar
// offers the row and says how it will group.

const OWN_SERVER = SMOKE_SERVER

export const groupTabsCheck: SmokeCheck = {
  name: 'decisions: Group tabs goes by site, and by topic or into your group with the model',
  async run(ctx) {
    for (const p of ['a', 'b', 'c', 'd']) ctx.server.page(`/dc18/${p}`, `<!doctype html><title>Group tabs ${p}</title><p>${p}</p>`)
    const open = (p: string): string => ctx.tabs.create(`${ctx.server.http}/dc18/${p}`, { activate: false }).id
    const ids: string[] = []
    const undos: string[] = []
    const groupOf = (id: string): string | null => ctx.tabs.groupOf(id)
    const named = (): { id: string; name: string }[] => ctx.tabs.groups().filter((g) => g.name.trim() !== '')
    const run = async (only: string[]): Promise<AutoGroupResult> => {
      const result = await ctx.chrome.invoke<AutoGroupResult>('tabGroups', 'auto', only)
      if (result.undo) undos.push(result.undo)
      return result
    }
    const bar = async (): Promise<{ id: string; subtitle?: string } | undefined> => {
      const groups = await omnibox.query(mainT('tabs.autoGroup.command'), {
        windowId: -1,
        signal: new AbortController().signal,
      })
      return groups.flatMap((g) => g.rows).find((r) => r.action.kind === 'command' && r.action.id === 'group-tabs')
    }
    try {
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
      ids.push(open('a'), open('b'), open('c'))
      const row = await bar()
      assert(row?.subtitle === mainT('tabs.autoGroup.bySite'), `the command bar offers Group tabs by site (got ${JSON.stringify(row)})`)

      const bySite = await run(ids)
      const site = ctx.tabs.groups().find((g) => g.id === groupOf(ids[0] ?? ''))
      assert(bySite.tabs === 3 && bySite.groups === 1 && bySite.undo, `the rule groups the three pages (got ${JSON.stringify(bySite)})`)
      assert(site?.name === '127.0.0.1' && ids.every((id) => groupOf(id) === site.id), `one group named after the site (got ${JSON.stringify(site)})`)
      await ctx.chrome.invoke('tabGroups', 'undoAuto', bySite.undo)
      undos.splice(undos.indexOf(bySite.undo ?? ''), 1)
      assert(
        ids.every((id) => groupOf(id) === null && ctx.tabs.find(id)),
        'Undo ends the group and keeps the tabs',
      )

      ctx.settings.update({
        decisions: {
          ...OWN_SERVER,
          uses: { ...DECISIONS_DEFAULTS.uses, tabs: true },
        },
      })
      assert((await bar())?.subtitle === mainT('tabs.autoGroup.byTopic'), 'the command bar says it groups by topic')
      const first = named()[0]
      const byTopic = await run(ids)
      assert(byTopic.tabs === 3, `the model groups the three pages (got ${JSON.stringify(byTopic)})`)
      if (first) {
        assert(
          ids.every((id) => groupOf(id) === first.id),
          `the stand-in picks the window's first named group, ${first.name}`,
        )
      } else {
        const work = ctx.tabs.groups().find((g) => g.id === groupOf(ids[0] ?? ''))
        assert(work?.name === mainT('tabs.topic.work') && ids.every((id) => groupOf(id) === work.id), `one group under the stand-in's first topic (got ${JSON.stringify(work)})`)
      }

      const later = open('d')
      ids.push(later)
      const target = named()[0]
      const joined = await run([later])
      assert(joined.tabs === 1 && joined.groups === 1 && target && groupOf(later) === target.id, `a later tab joins the first named group (got ${JSON.stringify(joined)})`)
    } finally {
      for (const id of undos.reverse()) await ctx.chrome.invoke('tabGroups', 'undoAuto', id).catch(() => undefined)
      for (const id of ids) if (ctx.tabs.find(id)) ctx.tabs.close(id)
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    }
  },
}
