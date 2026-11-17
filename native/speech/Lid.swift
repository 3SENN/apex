/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-speech: the lid observer.
//
// While the helper runs it watches IOPMrootDomain for clamshell changes and
// prints {"type":"lid","closed":true|false} on stdout. Apex pauses a meeting
// recording when the lid closes and resumes it on open (src/main/native/lid.ts).
// The line only reports changes: the lid's state at launch is remembered but
// not printed, so a recording started with the lid already shut (clamshell
// mode, on an external display) is left alone.
//
// The helper's observer registry starts it once stdout is ready and stops it
// on exit:
//   LidObserver.shared.start(emit: emit)
//   LidObserver.shared.stop()
// It needs no entitlement and no usage string.

import Foundation
import IOKit
import IOKit.pwr_mgt

final class LidObserver: @unchecked Sendable {
  static let shared = LidObserver()

  /// <IOKit/pwr_mgt/IOPM.h>'s kIOPMMessageClamshellStateChange, which is
  /// iokit_family_msg(sub_iokit_powermanagement, 0x100): a macro Swift can't import.
  static let clamshellStateChange: UInt32 = 0xE003_4100
  /// kClamshellStateBit in the message argument.
  static let clamshellStateBit: UInt = 1 << 0

  private let queue = DispatchQueue(label: "com.sennechin.apex.speech.lid")
  private var port: IONotificationPortRef?
  private var notifier: io_object_t = 0
  private var rootDomain: io_service_t = 0
  private var emit: (([String: Any]) -> Void)?
  private var lastClosed: Bool?

  /// Starts watching; a second call does nothing. Never fails loudly: without
  /// the notification Apex still pauses on sleep through powerMonitor.
  func start(emit: @escaping ([String: Any]) -> Void) {
    queue.sync {
      guard port == nil else { return }
      let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
      guard root != 0 else { return }
      guard let port = IONotificationPortCreate(kIOMainPortDefault) else {
        IOObjectRelease(root)
        return
      }
      IONotificationPortSetDispatchQueue(port, queue)
      var notifier: io_object_t = 0
      let refcon = Unmanaged.passUnretained(self).toOpaque()
      let result = IOServiceAddInterestNotification(port, root, kIOGeneralInterest, lidInterestCallback, refcon, &notifier)
      guard result == KERN_SUCCESS else {
        IONotificationPortDestroy(port)
        IOObjectRelease(root)
        return
      }
      self.port = port
      self.notifier = notifier
      self.rootDomain = root
      self.emit = emit
      self.lastClosed = LidObserver.clamshellClosed(root)
    }
  }

  func stop() {
    queue.sync {
      guard let port else { return }
      IOObjectRelease(notifier)
      IONotificationPortDestroy(port)
      IOObjectRelease(rootDomain)
      self.port = nil
      notifier = 0
      rootDomain = 0
      emit = nil
      lastClosed = nil
    }
  }

  /// Runs on `queue`, where IOKit delivers the notification.
  fileprivate func handle(messageType: UInt32, argument: UnsafeMutableRawPointer?) {
    guard messageType == LidObserver.clamshellStateChange, let emit else { return }
    // The registry's AppleClamshellState is the source of truth; the
    // message argument carries the same bit when the property can't be read.
    let closed = LidObserver.clamshellClosed(rootDomain) ?? ((UInt(bitPattern: argument) & LidObserver.clamshellStateBit) != 0)
    guard closed != lastClosed else { return }
    lastClosed = closed
    emit(["type": "lid", "closed": closed])
  }

  /// IOPMrootDomain's AppleClamshellState, or nil on a Mac without a lid.
  static func clamshellClosed(_ root: io_service_t) -> Bool? {
    guard root != 0,
          let value = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    else { return nil }
    return (value as? NSNumber)?.boolValue
  }
}

/// IOKit's C callback; the refcon is the (immortal) shared observer.
private func lidInterestCallback(refcon: UnsafeMutableRawPointer?, service: io_service_t, messageType: UInt32, argument: UnsafeMutableRawPointer?) {
  guard let refcon else { return }
  Unmanaged<LidObserver>.fromOpaque(refcon).takeUnretainedValue().handle(messageType: messageType, argument: argument)
}
