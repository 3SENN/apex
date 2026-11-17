/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The frontmost app, and giving focus back to it: the quick-ask launcher's
// fallback when a click inside it made Apex active.

import AppKit
import Foundation

enum Apps {
  static func frontmost() -> [String: Any] {
    let app = NSWorkspace.shared.frontmostApplication
    return ["type": "frontmost", "pid": orNull(app?.processIdentifier), "bundleId": orNull(app?.bundleIdentifier)]
  }

  static func activate(_ pid: pid_t) {
    DispatchQueue.main.async {
      guard let app = NSRunningApplication(processIdentifier: pid) else { return }
      if #available(macOS 14.0, *) {
        app.activate()
      } else {
        app.activate(options: [.activateIgnoringOtherApps])
      }
    }
  }
}
