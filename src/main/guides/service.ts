/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The guides service (ON-16): list and search Apex's own guides, and
// Try it. A bundle's skills are built-in skills named by name (already
// shipped, so they're reported as ready); its routines are saved paused for
// review; its connectors come back as suggestions for the chrome to offer.
import { BRAND_NAME } from '@shared/branding'
import { filterGuides, type Guide, type GuidesService } from '@shared/guides'
import type { RoutineSaveInput } from '@shared/routines'
import type { AgentHostApi } from '../agent/hostApi'
import { GUIDES, type CatalogueGuide } from './catalogue'

export interface GuidesDeps {
  skills: { byName(name: string): { id: string; name: string } | undefined }
  routines: { list(): Array<{ id: string; name: string }>; save(input: RoutineSaveInput): { id: string } }
  host: Pick<AgentHostApi, 'startChat'>
  activeCompanionId(): string
  /** Connector directory ids that exist; suggestions outside it are dropped. */
  directoryIds?(): readonly string[]
  catalogue?: readonly CatalogueGuide[]
}

const toGuide = ({ useCases: _useCases, ...guide }: CatalogueGuide): Guide => ({ ...guide, bundle: guide.bundle ? { skills: [...guide.bundle.skills], routines: guide.bundle.routines.map((r) => ({ ...r })), connectors: [...guide.bundle.connectors] } : null })

export function guideContext(guide: Guide): string {
  return `<guide id="${guide.id}">\nA guide the person opened in ${BRAND_NAME}. Walk them through it with a small, real example on what they have open; keep it short.\n\n${guide.body.trim()}\n</guide>`
}

export function createGuidesService(deps: GuidesDeps): GuidesService {
  const catalogue = deps.catalogue ?? GUIDES
  const find = (id: string): CatalogueGuide => {
    const guide = catalogue.find((g) => g.id === id)
    if (!guide) throw new Error('That guide doesn’t exist.')
    return guide
  }
  return {
    list: (q) => filterGuides(catalogue, q ?? {}).map(toGuide),
    get: (id) => toGuide(find(id)),
    tryIt(id) {
      const guide = find(id)
      if (guide.tryIt === 'start-chat') {
        const companionId = deps.activeCompanionId()
        const chatId = deps.host.startChat(`Show me how this works: ${guide.title}.`, { ...(companionId ? { companionId } : {}), context: guideContext(guide), open: 'page' })
        return { installedSkills: [], routines: [], connectorSuggestions: [], chatId }
      }
      if (guide.tryIt === 'open' || !guide.bundle) return { installedSkills: [], routines: [], connectorSuggestions: [], chatId: null }
      const installedSkills = guide.bundle.skills.flatMap((name) => {
        const skill = deps.skills.byName(name)
        return skill ? [skill.name] : []
      })
      const existing = deps.routines.list()
      const routines = guide.bundle.routines.map((draft) => {
        // Trying a guide twice never makes a second copy.
        const same = existing.find((r) => r.name === draft.name)
        if (same) return same.id
        const companionId = draft.companionId ?? deps.activeCompanionId()
        return deps.routines.save({ ...draft, ...(companionId ? { companionId } : {}), enabled: false }).id
      })
      const known = deps.directoryIds ? new Set(deps.directoryIds()) : null
      const connectorSuggestions = guide.bundle.connectors.filter((c) => !known || known.has(c))
      return { installedSkills, routines, connectorSuggestions, chatId: null }
    },
    forUseCases(ids) {
      const wanted = new Set(ids.map((id) => id.replace(/^other:.*/, '')).filter(Boolean))
      const matched = catalogue.filter((g) => g.useCases.some((u) => wanted.has(u)))
      return (matched.length > 0 ? matched : catalogue.filter((g) => g.category === 'basics')).map(toGuide)
    },
  }
}
