/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome's side of "Move to project" (projectActions.ts): follows the
// project list from the `projects` event and carries out a click: take the
// chats out of their projects, move them into one, or create a project
// (the editor dialog) and move them there. Imported for its effect by the
// Space row (always in the sidebar) and the Workspace hub.
import { t } from '@shared/i18n/core'
import { projectOfChats, type Project, type ProjectMenuAction } from '@shared/workspace'
import { apex, call } from '../api'
import { toast } from '../ui'
import { fail } from './open'
import { connectProjectMenus } from './projectActions'
import { openProjectEditor } from './ProjectEditor'

let known: Project[] = []

async function moveTo(project: Project, chatIds: string[]): Promise<void> {
  const updated = await call('projects', 'addChats', project.id, chatIds)
  known = known.map((p) => (p.id === updated.id ? updated : p))
  toast.show({ message: t('workspace.menu.moved', { count: chatIds.length, name: project.name }), tone: 'success' })
}

async function run(action: ProjectMenuAction, chatIds: string[]): Promise<void> {
  try {
    if (action.kind === 'none') {
      const of = projectOfChats(known, chatIds)
      const byProject = new Map<string, string[]>()
      for (const [chatId, projectId] of of) byProject.set(projectId, [...(byProject.get(projectId) ?? []), chatId])
      for (const [projectId, ids] of byProject) await call('projects', 'removeChats', projectId, ids)
      if (of.size > 0) toast.show({ message: t('workspace.menu.unfiled', { count: of.size }), tone: 'success' })
      return
    }
    if (action.kind === 'new') {
      const created = await openProjectEditor(null)
      if (!created) return
      known = [...known.filter((p) => p.id !== created.id), created]
      await moveTo(created, chatIds)
      return
    }
    const project = known.find((p) => p.id === action.id) ?? (await call('projects', 'get', action.id))
    await moveTo(project, chatIds)
  } catch (err) {
    fail(err)
  }
}

let started = false

/** Starts following projects and connects the runner; safe to call more than once. */
export function startProjectMenus(): void {
  if (started) return
  started = true
  Promise.resolve(call('projects', 'list'))
    .then((items) => {
      known = items
    })
    .catch(() => undefined)
  apex.onAppEvent((event) => {
    if (event.type === 'projects') known = event.items
  })
  connectProjectMenus({ projects: () => known, run })
}

startProjectMenus()
