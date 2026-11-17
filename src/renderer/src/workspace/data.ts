/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Live data for the workspace renderer: each hook loads once and follows its app
// event (projects, folders, spaces, the search index, Recently Deleted).
import { useEffect, useState } from 'react'
import type { IndexState, Project, SpaceInfo, WatchedFolder } from '@shared/workspace'
import { call } from '../api'
import { useEvent, useResource, type Resource } from '../settings/data'

export function useProjects(): Resource<Project[]> {
  const projects = useResource(() => call('projects', 'list'))
  useEvent('projects', (e) => projects.set(e.items))
  return projects
}

export function useFolders(): Resource<WatchedFolder[]> {
  const folders = useResource(() => call('folders', 'list'))
  useEvent('folders', (e) => folders.set(e.items))
  return folders
}

/** The search index's build state; null until known. */
export function useIndexState(): IndexState | null {
  const [state, setState] = useState<IndexState | null>(null)
  useEffect(() => {
    let live = true
    call('search', 'state')
      .then((s) => live && setState(s))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  useEvent('search-index', (e) => setState(e.state))
  return state
}

/** This window's spaces, or null before they load (or while spaces are unavailable). */
export function useSpaces(): SpaceInfo[] | null {
  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null)
  const load = (): void => {
    call('spaces', 'list')
      .then(setSpaces)
      .catch(() => setSpaces(null))
  }
  useEffect(load, [])
  useEvent('spaces', load)
  useEvent('projects', load)
  return spaces
}

/** How many items Recently Deleted holds; null until known. */
export function useTrashCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    call('trash', 'list')
      .then((items) => setCount(items.length))
      .catch(() => undefined)
  }, [])
  useEvent('trash', (e) => setCount(e.count))
  return count
}
