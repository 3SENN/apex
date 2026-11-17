/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier haptics: the platform seam between the Node-API surface (addon.cc)
// and the system call (haptics.mm on macOS, haptics_noop.cc elsewhere).
#pragma once

namespace atelier_haptics {

enum class Pattern {
  kAlignment,
  kLevelChange,
  kGeneric,
};

// Hands one feedback pattern to the system. Returns true when the pattern
// was passed on to the platform, false when this platform has no haptics.
bool Play(Pattern pattern);

}  // namespace atelier_haptics
