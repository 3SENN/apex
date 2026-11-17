/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { ElementDescription } from '@shared/ipc'
import { consequentialReason } from '../src/main/agent/guard'

const el = (overrides: Partial<ElementDescription>): ElementDescription => ({
  role: 'button',
  name: '',
  tag: 'button',
  inputType: null,
  isPassword: false,
  isPaymentField: false,
  formSubmitName: null,
  inForm: false,
  formHasPaymentFields: false,
  ...overrides,
})

describe('consequentialReason', () => {
  it('flags purchases, messages, deletions and account changes', () => {
    for (const name of ['Place order', 'Buy now', 'Send', 'Post', 'Delete repository', 'Confirm transfer', 'Cancel subscription', 'Sign up', 'I agree']) {
      expect(consequentialReason({ kind: 'click', element: el({ name }) }), name).not.toBeNull()
    }
  })

  it('ignores ordinary navigation and UI clicks', () => {
    for (const name of ['Next', 'Show more', 'Cancel', 'Close', 'Search', 'Pricing', 'Sender details', 'Postal code']) {
      expect(consequentialReason({ kind: 'click', element: el({ name }) }), name).toBeNull()
    }
    expect(consequentialReason({ kind: 'click', element: el({ role: 'heading', name: 'Delete' }) })).toBeNull()
    expect(consequentialReason({ kind: 'click', element: null })).toBeNull()
  })

  it('flags submitting a form that holds payment fields', () => {
    expect(consequentialReason({ kind: 'click', element: el({ name: 'Continue', formHasPaymentFields: true, inForm: true }) })).toMatch(/payment/)
  })

  it('flags Enter in a form whose submit button is consequential', () => {
    const field = el({ role: 'textbox', tag: 'input', inputType: 'text', inForm: true, formSubmitName: 'Send message' })
    expect(consequentialReason({ kind: 'enter', element: field })).toMatch(/Send message/)
  })

  it('lets Enter through in search boxes and textareas', () => {
    expect(consequentialReason({ kind: 'enter', element: el({ role: 'searchbox', tag: 'input', inForm: true, formSubmitName: 'Search' }) })).toBeNull()
    expect(consequentialReason({ kind: 'enter', element: el({ role: 'textbox', tag: 'textarea', inForm: true, formSubmitName: 'Post' }) })).toBeNull()
    expect(consequentialReason({ kind: 'enter', element: el({ role: 'textbox', tag: 'input', inForm: false }) })).toBeNull()
  })
})
