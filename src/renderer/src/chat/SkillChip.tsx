/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Wand2 } from 'lucide-react'
import type { UserMessageSkill } from '@shared/agentTools'
import { skillUrl } from '@shared/url'
import { call } from '../api'
import { useT } from '../i18n/useT'
import './chatTools.css'

/** SK-04: the skill a message ran, in place of the raw /command; it opens the skill, and built-in skills carry a badge. */
export function SkillChip({ skill }: { skill: UserMessageSkill }): ReactElement {
  const t = useT()
  return (
    <button type="button" className="cd-skill-chip" aria-label={t('chatTools.skill.open', { name: skill.name })} onClick={() => void call('pages', 'open', skillUrl(skill.id)).catch(() => undefined)}>
      <Wand2 size={12} aria-hidden="true" />
      <span className="cd-skill-chip__name">/{skill.name}</span>
      {skill.builtin && <span className="cd-skill-chip__badge">{t('chatTools.skill.builtin')}</span>}
    </button>
  )
}
