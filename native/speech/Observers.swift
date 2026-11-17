/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Long-lived observers that report on their own, outside any session (the
// clamshell watcher is the first). A new one is a class in its own file that
// adopts HelperObserver: start-up finds every adopter through the
// Objective-C runtime, so adding one never means editing another file.

import Foundation
import ObjectiveC

@objc protocol HelperObserver: AnyObject {
  /// Called once at start-up, on the main queue. Report with emit(_:).
  static func startObserving()
  /// Called when the helper exits.
  @objc optional static func stopObserving()
}

private var observers: [HelperObserver.Type] = []

/// Every class that adopts HelperObserver.
private func adopters() -> [HelperObserver.Type] {
  let expected = objc_getClassList(nil, 0)
  guard expected > 0 else { return [] }
  let buffer = UnsafeMutablePointer<AnyClass>.allocate(capacity: Int(expected))
  defer { buffer.deallocate() }
  let count = objc_getClassList(AutoreleasingUnsafeMutablePointer(buffer), expected)
  var found: [HelperObserver.Type] = []
  for index in 0..<Int(min(count, expected)) {
    let cls: AnyClass = buffer[index]
    // class_conformsToProtocol sends no messages, so walking every class is safe.
    guard class_conformsToProtocol(cls, HelperObserver.self), let observer = cls as? HelperObserver.Type else { continue }
    found.append(observer)
  }
  return found
}

func startObservers() {
  observers = adopters()
  for observer in observers { observer.startObserving() }
}

func stopObservers() {
  for observer in observers { observer.stopObserving?() }
  observers = []
}

/// The clamshell watcher (Lid.swift) is started through the registry with
/// LidObserver.shared.start(emit:); this adopts it on its behalf.
final class LidObserverAdapter: NSObject, HelperObserver {
  static func startObserving() {
    LidObserver.shared.start(emit: emit)
  }

  static func stopObserving() {
    LidObserver.shared.stop()
  }
}
