/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for the workspace renderer. They live in @shared/workspace (so
// unit tests and the node typecheck reach them) and are re-exported
// here for the chrome.
export type { EntrySort } from '@shared/workspace'
export {
  breadcrumbs,
  parentPath,
  sortEntries,
  groupHits,
  daysLeft,
  spaceView,
  viewerTargetOf,
  joinPath,
  projectColor,
  filterProjects,
  selectionState,
  toggled,
  pruneSelection,
  searchPageUrl,
  activeSpace,
  spacesShown,
  SPACE_MOVE_PREFIX,
  spaceMoveSpec,
  spaceMoveTarget,
} from '@shared/workspace'
