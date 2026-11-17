/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Workspace sections: the lazy imports of each section's
// page, including the apps and tables sections. Which tab a
// section shows under is @shared/workspace's workspaceTabOf; the old
// Timeline address has no page here (it goes to History).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { WorkspaceSection } from '@shared/workspace'

/** What the hub hands a section; the apps and tables sections take none of it. */
export interface WorkspaceSectionProps {
  /** atelier://workspace/<section>/<id> (a project, a folder). */
  itemId?: string | null
  /** atelier://workspace/search?q=, or what is typed in the hub's search field. */
  query?: string | null
  tabId?: string
  /** The tab's address, for sections that keep state in it. */
  url?: string
}

type SectionPage = LazyExoticComponent<ComponentType<WorkspaceSectionProps>>

const COMPONENTS: Record<Exclude<WorkspaceSection, 'timeline'>, SectionPage> = {
  home: lazy(() => import('./home/HomeSection')),
  projects: lazy(() => import('./projects/ProjectsSection')),
  files: lazy(() => import('./files/FilesSection')),
  apps: lazy(() => import('./apps/AppsSection')),
  tables: lazy(() => import('./tables/TablesSection')),
  trash: lazy(() => import('./trash/TrashSection')),
  search: lazy(() => import('./search/SearchSection')),
}

/** The page a section shows: Tables without a table is the Files tab; Timeline has none. */
export function sectionPage(section: WorkspaceSection, itemId: string | null): SectionPage | null {
  if (section === 'timeline') return null
  if (section === 'tables' && !itemId) return COMPONENTS.files
  return COMPONENTS[section]
}
