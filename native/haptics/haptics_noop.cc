/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier haptics on Windows and Linux: there is no system haptic performer,
// so every pattern is accepted and nothing happens.
#include "haptics.h"

namespace atelier_haptics {

bool Play(Pattern pattern) {
  (void)pattern;
  return false;
}

}  // namespace atelier_haptics
