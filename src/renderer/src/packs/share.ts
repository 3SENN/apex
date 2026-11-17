/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Share as pack (docs/packs.md): turns a skill, tweak, app or companion into
// a draft pack and opens it on the Packs page, where you can review, export
// or hand it to a companion to extend.
import { packsPageUrl, type PackShareKind } from '@shared/packs'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { toast } from '../ui'

export async function shareAsPack(kind: PackShareKind, itemId: string): Promise<void> {
  try {
    const draft = await call('packs', 'shareAs', kind, itemId)
    toast.show({ message: t('packs.share.made') })
    await call('pages', 'open', packsPageUrl({ draft }))
  } catch (err) {
    toast.show({ tone: 'error', message: errorText(err) })
  }
}
