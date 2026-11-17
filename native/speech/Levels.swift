/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Gains and levels. The sensitivity from Settings is applied to every buffer
// before it reaches recognition or the recording, and the meter reports what
// was actually captured: RMS and peak per source, at most 15 times a second.

import Accelerate
import AVFoundation
import Foundation

enum Levels {
  /// Multiplies one canonical buffer by `gain` in place, clipped to full scale.
  static func applyGain(_ buffer: AVAudioPCMBuffer, _ gain: Float) {
    guard gain != 1, let data = buffer.floatChannelData?[0] else { return }
    let count = vDSP_Length(buffer.frameLength)
    var g = gain
    vDSP_vsmul(data, 1, &g, data, 1, count)
    var low: Float = -1
    var high: Float = 1
    vDSP_vclip(data, 1, &low, &high, data, 1, count)
  }

  /// RMS and peak of one canonical buffer, 0 to 1.
  static func measure(_ buffer: AVAudioPCMBuffer) -> (rms: Float, peak: Float) {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return (0, 0) }
    let count = vDSP_Length(buffer.frameLength)
    var rms: Float = 0
    var peak: Float = 0
    vDSP_rmsqv(data, 1, &rms, count)
    vDSP_maxmgv(data, 1, &peak, count)
    return (min(1, rms), min(1, peak))
  }
}

/// Averages one source's levels and reports them at most 15 times a second.
final class LevelMeter {
  private let session: String
  private let source: String
  private let lock = NSLock()
  private var sumSquares: Double = 0
  private var frames: Double = 0
  private var peak: Float = 0
  private var last: UInt64 = 0
  private static let interval: UInt64 = 1_000_000_000 / 15

  init(session: String, source: String) {
    self.session = session
    self.source = source
  }

  func add(rms: Float, peak: Float, frames count: AVAudioFrameCount) {
    lock.lock()
    defer { lock.unlock() }
    sumSquares += Double(rms * rms) * Double(count)
    frames += Double(count)
    self.peak = max(self.peak, peak)
    let now = DispatchTime.now().uptimeNanoseconds
    guard now - last >= LevelMeter.interval, frames > 0 else { return }
    let level = min(1, (sumSquares / frames).squareRoot())
    emit(["type": "level", "session": session, "source": source, "rms": level, "peak": Double(self.peak)])
    last = now
    sumSquares = 0
    frames = 0
    self.peak = 0
  }
}
