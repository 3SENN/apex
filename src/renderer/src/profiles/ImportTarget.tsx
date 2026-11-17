/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { Profile } from '@shared/profiles'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { Button } from '../ui'
import { Row } from '../settings/kit'
import { ProfileBadge } from './HueSwatches'
import './profiles.css'

// ST-46: an import goes into the profile of the window it runs in.
// To bring a browser into a new profile, make the profile first: it opens
// in its own window, where Import runs into it.

export function ImportTargetRow({ disabled = false }: { disabled?: boolean }): ReactElement | null {
  const t = useT()
  const [profile, setProfile] = useState<Profile | null>(null)
  useEffect(() => {
    let live = true
    call('profiles', 'current').then(
      (p) => live && setProfile(p),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  if (!profile) return null
  return (
    <Row title={t('profiles.import.target')} description={t('profiles.import.current', { name: profile.name })} icon={<ProfileBadge name={profile.name} hue={profile.hue} size={20} />} anchor="import-target">
      <Button size="sm" variant="secondary" disabled={disabled} onClick={(e) => void openSurface('profile-create', anchorFromElement(e.currentTarget), {}).catch(() => undefined)}>
        {t('profiles.import.new')}
      </Button>
    </Row>
  )
}
