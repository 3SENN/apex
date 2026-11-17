/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Permission status without prompting, and one prompt per kind on request.
// `start` never prompts: it fails fast with an error code instead, so a
// prompt only ever follows a click on Allow in Apex. Location is read only,
// for the sites that ask for it: the helper never requests it.

import AVFoundation
import CoreGraphics
import CoreLocation
import Foundation
import Speech

enum Permissions {
  static func microphone() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "denied"
    }
  }

  static func speech() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "denied"
    }
  }

  /// macOS reads this grant when the process starts; Apex restarts an idle helper to see a new one.
  static func screen() -> String {
    CGPreflightScreenCaptureAccess() ? "granted" : "denied"
  }

  /// Location Services as macOS has it for Apex; off for the whole Mac reads as denied.
  static func location() -> String {
    guard CLLocationManager.locationServicesEnabled() else { return "denied" }
    switch CLLocationManager().authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    // Unknown is no reason to block a site: macOS still decides when the site asks.
    @unknown default: return "not-determined"
    }
  }

  static func report() -> [String: Any] {
    ["type": "permissions", "microphone": microphone(), "speech": speech(), "screen": screen(), "location": location()]
  }

  /// Asks the OS once (it only shows its prompt the first time), then reports.
  static func request(_ what: String, done: @escaping () -> Void) {
    switch what {
    case "microphone":
      AVCaptureDevice.requestAccess(for: .audio) { _ in done() }
    case "speech":
      SFSpeechRecognizer.requestAuthorization { _ in done() }
    case "screen":
      DispatchQueue.main.async {
        _ = CGRequestScreenCaptureAccess()
        done()
      }
    default:
      emitError(.invalid, "Unknown permission \(what).", fatal: false)
      done()
    }
  }
}
