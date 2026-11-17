/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerLogCard } from '../chat/cards/registry'
import { registerRequestCard, registerRequestSource, type PendingRequest } from '../chat/requestCards'
import { ConnectConnectorCard } from './ConnectConnectorCard'
import { ConnectorApprovalCard, ConnectorApprovalLogCard } from './ConnectorApprovalCard'

// The connectors' renderer registrations, imported once by main.tsx: the editable
// connector approval in the request tray (CH-40), fed from the chat log's
// unanswered approvals; the answered ones as a line in the log; and the
// connect card for a service the chat needs (CH-41).
registerRequestCard('connector-approval', ConnectorApprovalCard)
registerRequestSource((items, chatId) =>
  items.flatMap((item): PendingRequest[] => (item.kind === 'connector-approval' && item.outcome === null ? [{ id: item.id, kind: 'connector-approval', chatId, data: item }] : [])),
)
registerLogCard('connector-approval', ConnectorApprovalLogCard)
registerLogCard('connector-needed', ConnectConnectorCard)
