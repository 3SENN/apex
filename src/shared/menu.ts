/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface MenuItemSpec { id: string; label: string; type?: 'normal' | 'checkbox' | 'radio' | 'separator'; accelerator?: string; enabled?: boolean; checked?: boolean; danger?: boolean; submenu?: MenuItemSpec[] }
