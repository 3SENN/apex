/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { MeetingDetailView } from '../meetings/MeetingDetailView'
import { MeetingList } from '../meetings/MeetingList'
import { readMeetingsQuery } from '../meetings/logic'

// apex://meetings[/<id>][?filter=recordings&q=<text>] (MV-12, MV-13, DS-105):
// the library of meetings and recordings, or one meeting.

export interface MeetingsPageProps {
  tabId: string
  url: string
  meetingId: string | null
}

export function MeetingsPage({ tabId, url, meetingId }: MeetingsPageProps): ReactElement {
  if (meetingId) return <MeetingDetailView key={meetingId} tabId={tabId} meetingId={meetingId} />
  const { filter, q } = readMeetingsQuery(url)
  return <MeetingList tabId={tabId} initialFilter={filter} initialQuery={q} />
}
