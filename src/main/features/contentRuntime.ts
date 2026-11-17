/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AttachmentStore, ChatContextRegistry, ChatFilesReader } from '../intake/types'
import type { ConnectorRuntime } from '../connectors/runtime'
import type { ExtensionsHost } from '../extensions/service'
import type { LibraryFiles, ViewerHooks } from '../files/types'
import type { ProfileManager } from '../profiles/service'
import { notAvailableYet } from './personalRuntime'

// The chat and files part of the app context: the main-only APIs these
// features share, filled by their feature modules in FEATURES order (profiles,
// intake, files, connectors, richChat, extensions). Until a slot is filled it
// throws "Not available yet", so a feature can code against it before its
// owner has set it up.

export interface ContentRuntime {
  /** One session and data folder per profile. */
  profiles: ProfileManager
  /** Prepared attachments for requests. */
  attachments: AttachmentStore
  /** The pages in each chat (CH-34). */
  chatContext: ChatContextRegistry
  /** The chat's virtual files (CH-28), for the file viewer (chat-file targets). */
  chatFiles: ChatFilesReader
  /** Generated files, reports and artifacts. */
  libraryFiles: LibraryFiles
  /** The viewer's main-side hooks (Recently Deleted). */
  viewer: ViewerHooks
  /** Remote servers and local tools for requests. */
  connectors: ConnectorRuntime
  /** Extensions per profile session. */
  extensions: ExtensionsHost
}

export function emptyContentRuntime(): ContentRuntime {
  return {
    profiles: notAvailableYet<ProfileManager>('profile manager'),
    attachments: notAvailableYet<AttachmentStore>('attachment store'),
    chatContext: notAvailableYet<ChatContextRegistry>('chat context'),
    chatFiles: notAvailableYet<ChatFilesReader>('chat files'),
    libraryFiles: notAvailableYet<LibraryFiles>('library files'),
    viewer: notAvailableYet<ViewerHooks>('viewer'),
    connectors: notAvailableYet<ConnectorRuntime>('connector runtime'),
    extensions: notAvailableYet<ExtensionsHost>('extensions host'),
  }
}
