/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Device-owner authentication (Touch ID or the login password), for the
// Passwords page when Electron's own Touch ID prompt isn't available.

import Foundation
import LocalAuthentication

enum Auth {
  static func authenticate(id: String, reason: String) {
    let context = LAContext()
    var error: NSError?
    guard !reason.isEmpty, context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      emit(["type": "auth", "id": id, "result": "unavailable"])
      return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, failure in
      var result = ok ? "ok" : "unavailable"
      if !ok, let code = (failure as? LAError)?.code, [.userCancel, .appCancel, .systemCancel, .userFallback].contains(code) {
        result = "cancelled"
      }
      emit(["type": "auth", "id": id, "result": result])
    }
  }
}
