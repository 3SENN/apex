/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The files renderer API (OV-32, CH-28): open a file in the viewer or
// in quick look, and the shared preview renderers that the viewer page,
// quick look, the chat files modal and the Workspace surfaces draw files with.
export { openViewer, openQuickLook, openChatFiles, openFilesSurface } from './open'
export { FilePreview, FilePlaceholder, FrontmatterHeader, SaveFailedNotice, type FilePreviewProps } from './preview/FilePreview'
export { useViewerDoc, type ViewerDocHandle } from './useViewerDoc'
export { RenameDialog, type RenameDialogProps } from './RenameDialog'
export { ArtifactStrip } from './ArtifactStrip'
