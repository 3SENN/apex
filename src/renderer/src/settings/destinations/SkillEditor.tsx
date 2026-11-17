/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The skill editor is a page of its own (apex://skills/<id>,
// SK-03, in skills/SkillEditorPage.tsx). This module keeps the old import
// path working.
export { SkillEditorPage as SkillEditor, type SkillEditorPageProps as SkillEditorProps } from '../../skills/SkillEditorPage'
export type { SkillForm as SkillDraft } from '../../companion-card/logic/skills'
