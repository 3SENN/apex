/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex haptics on macOS: hands a pattern to AppKit's default haptic
// performer, which plays it on a Force Touch trackpad and does nothing on
// hardware without one.
#import <AppKit/AppKit.h>

#include "haptics.h"

namespace apex_haptics {

namespace {

NSHapticFeedbackPattern ToAppKit(Pattern pattern) {
  switch (pattern) {
    case Pattern::kAlignment:
      return NSHapticFeedbackPatternAlignment;
    case Pattern::kLevelChange:
      return NSHapticFeedbackPatternLevelChange;
    case Pattern::kGeneric:
      return NSHapticFeedbackPatternGeneric;
  }
  return NSHapticFeedbackPatternGeneric;
}

void PerformNow(NSHapticFeedbackPattern pattern) {
  @autoreleasepool {
    id<NSHapticFeedbackPerformer> performer =
        [NSHapticFeedbackManager defaultPerformer];
    [performer performFeedbackPattern:pattern
                      performanceTime:NSHapticFeedbackPerformanceTimeNow];
  }
}

}  // namespace

bool Play(Pattern pattern) {
  NSHapticFeedbackPattern appkit = ToAppKit(pattern);
  if ([NSThread isMainThread]) {
    PerformNow(appkit);
  } else {
    // AppKit belongs to the main thread. Electron's main process runs JS
    // there already; a worker thread hands the call over instead.
    dispatch_async(dispatch_get_main_queue(), ^{
      PerformNow(appkit);
    });
  }
  return true;
}

}  // namespace apex_haptics
