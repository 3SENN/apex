/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerLogCard } from './registry'
import { CompactionCard, FileCard, MemoryCard, PartialCard, SuggestionsCard, TabOpenedCard } from './ReplyCards'

// The reply cards (CH-26, CH-27), registered once when the chat log loads.
// The connectors UI registers `connector-needed` from its own module.
registerLogCard('compaction', CompactionCard)
registerLogCard('suggestions', SuggestionsCard)
registerLogCard('memory-change', MemoryCard)
registerLogCard('tab-opened', TabOpenedCard)
registerLogCard('file-produced', FileCard)
registerLogCard('partial', PartialCard)
