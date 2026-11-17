/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The main-side workspace adapters other features call. Every
// Atelier-initiated write or delete of a text file snapshots a version first
// (skill files, memory notes and tidy folders); every delete that should be
// restorable goes through trash.put (skills, memory files, projects, apps
// and tables, and the file viewer's onDelete). The workspace feature binds
// the live stores at start-up; before that (and in other features' unit
// tests) a snapshot is a no-op and trash.put refuses, so nothing is deleted
// without a way back.
import type { FileRef, FileVersion, TrashItem, TrashKind, WatchedFolder } from '@shared/workspace'
import type { TrashAdapter } from './trash'
import type { VersionTarget } from './versions'

export type { TrashAdapter } from './trash'
export type { VersionTarget } from './versions'

const adapters = new Map<TrashKind, TrashAdapter>()
const targets = new Map<FileRef['kind'], VersionTarget>()

export function registerTrashAdapter(adapter: TrashAdapter): void {
  if (adapters.has(adapter.kind)) throw new Error(`A trash adapter for "${adapter.kind}" is already registered.`)
  adapters.set(adapter.kind, adapter)
}

export function trashAdapter(kind: TrashKind): TrashAdapter | undefined {
  return adapters.get(kind)
}

/**
 * How a kind of file is read and written live, so version history can mark
 * the current version and restore an earlier one. The workspace registers
 * folder, companion and memory files; skills and apps register their own.
 */
export function registerVersionTarget(kind: FileRef['kind'], target: VersionTarget): () => void {
  if (targets.has(kind)) throw new Error(`A version target for "${kind}" is already registered.`)
  targets.set(kind, target)
  return () => {
    if (targets.get(kind) === target) targets.delete(kind)
  }
}

export function versionTarget(kind: FileRef['kind']): VersionTarget | undefined {
  return targets.get(kind)
}

/** What the workspace feature binds at start-up. */
export interface WorkspaceBinding {
  snapshot(ref: FileRef, text: string | Buffer, label: FileVersion['label']): void
  put(kind: TrashKind, id: string): TrashItem
  /** A project's name and instructions for the frozen prompt (PromptOptions.project). */
  projectPrompt(projectId: string): { name: string; instructions: string } | null
  /** The grant an absolute path falls inside, or null (the file viewer opens `local` files inside a grant). */
  folderFor(absolutePath: string): WatchedFolder | null
}

let bound: WorkspaceBinding | null = null

export function bindWorkspace(binding: WorkspaceBinding | null): void {
  bound = binding
}

export const versions = {
  /** Must run before every Atelier-initiated write or delete of a text file. */
  snapshot(ref: FileRef, text: string | Buffer, label: FileVersion['label']): void {
    bound?.snapshot(ref, text, label)
  },
}

export const trash = {
  put(kind: TrashKind, id: string): TrashItem {
    if (!bound) throw new Error('Recently Deleted is not available yet.')
    return bound.put(kind, id)
  },
}

export const projects = {
  /** For the agent's prompt: null when the chat has no project or it was deleted. */
  promptFor(projectId: string | null | undefined): { name: string; instructions: string } | null {
    return projectId ? (bound?.projectPrompt(projectId) ?? null) : null
  },
}

export const folders = {
  /** For the file viewer: the watched folder an absolute path is inside (after realpath), or null. */
  grantFor(absolutePath: string): WatchedFolder | null {
    return bound?.folderFor(absolutePath) ?? null
  },
}
