/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// build_app: the agent hands Apex one self-contained HTML
// file; Apex checks it (inline only, at most 2 MB), stores it as a draft
// version and puts an app-built card in the chat, where you preview it and
// Save. It never waits on you, so it works in any chat but a private one
// (an app outlives the chat). APP-UI: the model builds with Apex UI (the
// design notes ride in the description), and the result shows it the draft
// in light and dark with the design problems the check found.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APP_DESIGN_NOTES, lintAppDesign } from '@shared/appDesign'
import { APP_HTML_MAX, validateAppHtml, type AppSummary } from '@shared/apps'
import { isFlagOn } from '@shared/flags'
import { registerClientTool, type ClientTool } from '../agent/tools/registry'
import type { DraftPreview } from './preview'
import type { AppStore } from './store'

export interface AppToolDeps {
  store: AppStore
  changed(): void
  /** The draft off-screen in light and dark (absent in tests). */
  preview?(appId: string, versionId: string): Promise<DraftPreview>
}

const input = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(2_000),
    html: z.string().min(1).max(APP_HTML_MAX),
    appId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  })
  .strict()

export function registerAppTools(deps: AppToolDeps): void {
  registerClientTool({
    name: 'build_app',
    group: 'apps',
    description: `Builds or updates a small app the person can run in ${BRAND_NAME}: one self-contained HTML file (at most 2 MB) with all CSS and JavaScript inline. It runs sandboxed with no network: no external scripts, stylesheets, fonts, images or iframes (use inline SVG or data: URLs), no pop-ups, no navigation away. localStorage works. Support keyboard use and light and dark (prefers-color-scheme). Pass appId to save a new version of an app you built before. The person previews the draft in the chat and saves it.\n\n${APP_DESIGN_NOTES}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short name, up to 80 characters.' },
        description: { type: 'string', description: 'One sentence on what it does.' },
        html: { type: 'string', description: 'The complete HTML document.' },
        appId: { type: 'string', description: 'The id of an app to update, from an earlier build_app result.' },
      },
      required: ['name', 'description', 'html'],
      additionalProperties: false,
    },
    parse: input,
    enabled: (setup) => !setup.private && setup.workspace.apps && isFlagOn(setup.flags, 'apps'),
    async run(args, ctx) {
      const check = validateAppHtml(args.html)
      if (!check.ok) return { content: `The app was not saved: ${check.reason} Fix it and call build_app again.`, isError: true }
      let app: AppSummary
      let versionId: string
      if (args.appId) {
        if (!deps.store.has(args.appId)) return { content: 'There is no app with that appId. Leave appId out to build a new one.', isError: true }
        versionId = deps.store.addDraft(args.appId, args.html, { name: args.name, description: args.description })
        app = deps.store.get(args.appId)
      } else {
        const created = deps.store.create({ name: args.name, description: args.description, owner: ctx.companionId, createdBy: ctx.companionId, html: args.html })
        app = created.app
        versionId = created.versionId
      }
      ctx.emit({ type: 'app-built', requestId: randomUUID(), appId: app.id, versionId, name: app.name })
      deps.changed()
      const design = lintAppDesign(args.html)
      const preview = deps.preview ? await deps.preview(app.id, versionId).catch((): DraftPreview => ({ images: [], errors: [] })) : null
      const looked = (preview?.images.length ?? 0) > 0
      return {
        content: JSON.stringify({
          ok: true,
          appId: app.id,
          versionId,
          status: 'draft',
          note: 'The draft is in a card in this chat. The person can preview it and press Save; until then the previous version (if any) keeps running.',
          ...(looked ? { screenshots: 'The images are the draft in light, then dark, as the person will see it.' } : {}),
          ...(design.length > 0 ? { design } : {}),
          ...(preview && preview.errors.length > 0 ? { errors: preview.errors } : {}),
          next:
            design.length > 0 || (preview?.errors.length ?? 0) > 0
              ? 'Fix the design problems and errors, then call build_app again with this appId before telling the person it is ready.'
              : looked
                ? 'Look at the screenshots: if anything is off (spacing, contrast, alignment, something cut off), fix it with build_app and this appId; otherwise tell the person it is ready.'
                : 'Tell the person it is ready.',
        }),
        ...(looked ? { images: preview!.images } : {}),
      }
    },
  } satisfies ClientTool<z.infer<typeof input>>)
}
