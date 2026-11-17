/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Audio in: the chosen microphone through AVCaptureSession, and system audio
// (the other side of a call) through ScreenCaptureKit. Both are turned into
// one canonical format, 48 kHz mono float, before anything else sees them.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let canonicalFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!

/// Frames per millisecond in the canonical format.
let framesPerMs = canonicalFormat.sampleRate / 1000

/// A sample buffer's PCM as an AVAudioPCMBuffer in its own format.
func pcmBuffer(from sample: CMSampleBuffer) -> AVAudioPCMBuffer? {
  guard let description = CMSampleBufferGetFormatDescription(sample),
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
        let format = AVAudioFormat(streamDescription: asbd) else { return nil }
  let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
  buffer.frameLength = frames
  let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
  return status == noErr ? buffer : nil
}

/// Converts any PCM into the canonical format, keeping converter state between buffers.
final class Canonicalizer {
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?

  func convert(_ sample: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let input = pcmBuffer(from: sample) else { return nil }
    return convert(input)
  }

  func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if input.format.isEqual(canonicalFormat) { return input }
    if converter == nil || inputFormat?.isEqual(input.format) != true {
      converter = AVAudioConverter(from: input.format, to: canonicalFormat)
      inputFormat = input.format
    }
    guard let converter else { return nil }
    let ratio = canonicalFormat.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if fed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      inputStatus.pointee = .haveData
      return input
    }
    guard status != .error, output.frameLength > 0 else { return nil }
    return output
  }
}

/// The microphone, on the device Atelier chose.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  private let session = AVCaptureSession()
  private let output = AVCaptureAudioDataOutput()
  private let queue = DispatchQueue(label: "com.sennechin.atelier.speech.mic")
  private let onBuffer: (CMSampleBuffer) -> Void
  private let onInterrupted: (Bool) -> Void
  private var observers: [NSObjectProtocol] = []

  /// onInterrupted(true) when the microphone drops out, (false) when it is back.
  init(onBuffer: @escaping (CMSampleBuffer) -> Void, onInterrupted: @escaping (Bool) -> Void) {
    self.onBuffer = onBuffer
    self.onInterrupted = onInterrupted
  }

  func start(device: AVCaptureDevice) throws {
    let input = try AVCaptureDeviceInput(device: device)
    session.beginConfiguration()
    guard session.canAddInput(input) else {
      session.commitConfiguration()
      throw NSError(domain: "atelier-speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "The microphone can't be used."])
    }
    session.addInput(input)
    output.audioSettings = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMIsFloatKey: true,
      AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsNonInterleaved: true,
      AVSampleRateKey: canonicalFormat.sampleRate,
      AVNumberOfChannelsKey: 1,
    ]
    output.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      throw NSError(domain: "atelier-speech", code: 3, userInfo: [NSLocalizedDescriptionKey: "The microphone can't be read."])
    }
    session.addOutput(output)
    session.commitConfiguration()
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil) { [weak self] _ in self?.onInterrupted(true) },
      center.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: session, queue: nil) { [weak self] _ in self?.onInterrupted(false) },
      center.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: device, queue: nil) { [weak self] _ in self?.onInterrupted(true) },
    ]
    session.startRunning()
    guard session.isRunning else {
      stop()
      throw NSError(domain: "atelier-speech", code: 4, userInfo: [NSLocalizedDescriptionKey: "The microphone is in use or unavailable."])
    }
  }

  func stop() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if session.isRunning { session.stopRunning() }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    onBuffer(sampleBuffer)
  }
}

/// System audio (everything but this helper) for meetings. Needs Screen Recording.
///
/// A desktop call passes its app's bundle ids: the filter then includes only
/// that app's SCRunningApplications, and ScreenCaptureKit hands over only
/// their sound (their helper processes' included). This needs the same Screen
/// Recording grant as before, where a Core Audio process tap would ask for a
/// second, separate permission. If the app has gone, the Mac's sound is used.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let apps: [String]
  private let onBuffer: (CMSampleBuffer) -> Void
  private let onStopped: (Error) -> Void
  private let queue = DispatchQueue(label: "com.sennechin.atelier.speech.system-audio")

  init(apps: [String] = [], onBuffer: @escaping (CMSampleBuffer) -> Void, onStopped: @escaping (Error) -> Void) {
    self.apps = apps
    self.onBuffer = onBuffer
    self.onStopped = onStopped
  }

  private func matches(_ id: String) -> Bool {
    apps.contains { id == $0 || id.hasPrefix($0 + ".") }
  }

  func start() async throws {
    // An app's windows may be minimised or on another Space, so all of them count when filtering by app.
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: apps.isEmpty)
    guard let display = content.displays.first else {
      throw NSError(domain: "atelier-speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display is available for audio capture."])
    }
    let included = content.applications.filter { matches($0.bundleIdentifier) }
    let filter = included.isEmpty
      ? SCContentFilter(display: display, excludingWindows: [])
      : SCContentFilter(display: display, including: included, exceptingWindows: [])
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = Int(canonicalFormat.sampleRate)
    config.channelCount = 1
    // Video is never used; keep it as small and slow as it goes.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await stream.startCapture()
    self.stream = stream
  }

  func stop() async {
    let stream = self.stream
    self.stream = nil
    try? await stream?.stopCapture()
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid else { return }
    onBuffer(sampleBuffer)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    guard self.stream != nil else { return }
    self.stream = nil
    onStopped(error)
  }
}
