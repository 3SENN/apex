/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Dialogs and toasts. One dialog at a time per window; others
// queue, and duplicates by `dedupeKey` are dropped. The chrome keeps today's
// confirm and alert call shapes.
import type { Rect } from './overlay'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastSpec {
  kind: ToastKind
  text: string
  detail?: string
  action?: { id: string; label: string }
  /** Main-side only: a toast with undo shows an Undo button. */
  undo?: () => void | Promise<void>
  durationMs?: number
  tabId?: string
}

export type DialogIcon = 'info' | 'warning' | 'danger' | 'lock'

export type DialogButtonStyle = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'

export interface DialogButton {
  id: string
  label: string
  style: DialogButtonStyle
  align?: 'start' | 'end'
  /** This button answers Esc. */
  escape?: boolean
  /** This button answers Enter. */
  enter?: boolean
}

export interface DialogInput {
  id: string
  label: string
  type: 'text' | 'password'
  value?: string
}

export interface DialogSpec {
  title: string
  description?: string
  icon?: DialogIcon
  callout?: string
  inputs?: DialogInput[]
  checkbox?: { label: string; checked: boolean }
  buttons: DialogButton[]
  dedupeKey?: string
}

export interface DialogResult {
  /** null when dismissed without a button (window closed, replaced). */
  button: string | null
  inputs: Record<string, string>
  checked: boolean
}

// What crosses IPC; functions stay on their side

/** Options for main's dialogs.show (extended). */
export interface DialogShowOptions {
  /** A tab dialog blocks only that page and follows its tab. */
  tabId?: string
  /** A tab dialog that closes (as cancel) when focus leaves the window. */
  closeOnBlur?: boolean
  /** Resolves as dismissed after this long (page dialogs). */
  timeoutMs?: number
}

/** A toast as it crosses IPC: `undo` is a flag, the callback stays with whoever showed it. */
export interface ToastWire {
  /** Reusing an id replaces that toast in place ("Saving…" then "Saved"). */
  id?: string
  kind: ToastKind
  text: string
  detail?: string
  action?: { id: string; label: string }
  undo?: boolean
  durationMs?: number
  tabId?: string
}

/** How a toast ended. The opener runs its undo or action callback on 'undo' or 'action'. */
export type ToastOutcome = 'undo' | 'action' | 'timeout' | 'closed' | 'replaced' | 'tab-switch'

/** The `dialog` surface's props: the spec plus the area its backdrop covers (window CSS px). */
export interface DialogSurfaceProps {
  spec: DialogSpec
  scope: 'window' | 'tab'
  area: Rect
  /** Page dialogs say which site asked, so a page can't pass itself off as Atelier. */
  origin?: string
}

/** The `toast` surface's props. */
export interface ToastSurfaceProps {
  toast: ToastWire & { id: string }
  /** The tab's pane (or content area) the toast centres in, window CSS px. */
  area: Rect
}

/** The `qr-code` surface's props. */
export interface QrSurfaceProps {
  url: string
  title: string
  /** An SVG data URL from shared/qr.ts. */
  svg: string
  area: Rect
}

/** The `task-manager` sheet's props: the sheet polls taskManager.list itself. */
export interface TaskManagerSurfaceProps {
  area: Rect
}

export type TaskKind = 'browser' | 'gpu' | 'chrome' | 'overlay' | 'tab' | 'view' | 'utility'

/** One row of the task manager. */
export interface TaskRow {
  /** 'browser', 'gpu', 'chrome', 'overlay', 'tab:<tabId>', 'pid:<pid>'. */
  id: string
  kind: TaskKind
  title: string
  /** The tab's favicon, when it has one. */
  icon: string | null
  pid: number
  /** Resident memory in bytes. */
  memoryBytes: number
  /** CPU use since the last sample, 0–100 per core. */
  cpuPercent: number
  /** Only tabs can be ended; the crash page then offers a reload. */
  canEnd: boolean
}

/** What atelier://view-source loads. */
export interface ViewSourceResult {
  url: string
  /** The document's text, capped at VIEW_SOURCE_MAX_BYTES. */
  text: string
  truncated: boolean
  contentType: string
  status: number
}

export const VIEW_SOURCE_MAX_BYTES = 4 * 1024 * 1024

/** The chrome's own services for dialogs, toasts, the QR code and the task manager (merged into MenuServices). */
export interface DialogServices {
  dialogs: {
    /** The chrome's confirm and alert go through main's per-window queue. */
    show(spec: DialogSpec, tabId?: string): Promise<DialogResult>
    /** The chrome's fallback dialog answers (before the overlay host is ready, or after it failed). */
    answer(id: string, result: DialogResult): void
  }
  toasts: {
    show(toast: ToastWire): Promise<ToastOutcome>
    dismiss(id: string): void
    /** The chrome's fallback toast reports how it ended. */
    outcome(id: string, outcome: ToastOutcome): void
  }
  taskManager: {
    list(): Promise<TaskRow[]>
    /** Ends a tab's renderer; the tab shows the crash page. */
    end(id: string): void
  }
  viewSource: {
    load(url: string): Promise<ViewSourceResult>
  }
}

/** Events for the chrome's fallback hosts (MenuEvent). */
export type DialogEvent =
  | { type: 'dialog-fallback'; id: string; spec: DialogSpec; tabId: string | null; origin: string | null }
  | { type: 'dialog-fallback-close'; id: string }
  | { type: 'toast-fallback'; toast: ToastWire & { id: string } }
