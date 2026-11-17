/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One session at a time (dictation, a meeting, the level test), named by the
// id Atelier gives it. Every source runs through the same pipeline: canonical
// format, gain, levels, recognition and the recording part. Pausing drops
// audio, so segment times and the recording's length leave the pause out.

import AVFoundation
import Foundation
import Speech

/// Session audio time: milliseconds since start, pauses excluded.
final class AudioClock {
  private let lock = NSLock()
  private var startedAt: UInt64?
  private var pausedAt: UInt64?
  private var pausedTotal: UInt64 = 0

  private func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

  func start() {
    lock.lock()
    defer { lock.unlock() }
    if startedAt == nil { startedAt = now() }
  }

  func pause() {
    lock.lock()
    defer { lock.unlock() }
    if startedAt != nil, pausedAt == nil { pausedAt = now() }
  }

  func resume() {
    lock.lock()
    defer { lock.unlock() }
    if let pausedAt {
      pausedTotal += now() - pausedAt
      self.pausedAt = nil
    }
  }

  func nowMs() -> Double {
    lock.lock()
    defer { lock.unlock() }
    guard let startedAt else { return 0 }
    let end = pausedAt ?? now()
    return Double(end - startedAt - pausedTotal) / 1_000_000
  }
}

/// One source from capture to recognition and recording.
final class SourcePipeline {
  let source: String
  let recognizer: SourceRecognizer?
  private let gain: Float
  private let clock: AudioClock
  private let meter: LevelMeter?
  private let canonical = Canonicalizer()
  /// The recording this source's part goes into (the part is written beside it).
  private let recordTarget: URL?
  private let lock = NSLock()
  private var paused = false
  private var closed = false
  private var firstMs: Double?
  /// Frames on this source's timeline, silence fill included.
  private var frames: Double = 0
  private(set) var writer: PartWriter?
  private let onRecordingFailed: (Error) -> Void

  init(source: String, session: String, gain: Float, clock: AudioClock, levels: Bool, recognizer: SourceRecognizer?, recordTarget: URL?, onRecordingFailed: @escaping (Error) -> Void) {
    self.source = source
    self.gain = gain
    self.clock = clock
    meter = levels ? LevelMeter(session: session, source: source) : nil
    self.recognizer = recognizer
    self.recordTarget = recordTarget
    self.onRecordingFailed = onRecordingFailed
  }

  func process(_ sample: CMSampleBuffer) {
    guard let buffer = canonical.convert(sample) else { return }
    process(buffer)
  }

  func process(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard !paused, !closed, buffer.frameLength > 0 else { return }
    let lengthMs = Double(buffer.frameLength) / framesPerMs
    let now = clock.nowMs()
    if firstMs == nil {
      let start = max(0, now - lengthMs)
      firstMs = start
      if let recordTarget {
        do {
          writer = try PartWriter(target: recordTarget, source: source, startMs: start)
        } catch {
          onRecordingFailed(error)
        }
      }
    }
    let first = firstMs ?? 0
    // A source that dropped out is padded with silence so the recording stays in step.
    let gapMs = now - (first + frames / framesPerMs + lengthMs)
    if gapMs > 250 {
      let fill = min(gapMs, 10_000) * framesPerMs
      write { try $0.writeSilence(frames: AVAudioFrameCount(fill)) }
      frames += fill
    }
    let atMs = first + frames / framesPerMs
    Levels.applyGain(buffer, gain)
    let level = Levels.measure(buffer)
    meter?.add(rms: level.rms, peak: level.peak, frames: buffer.frameLength)
    recognizer?.append(buffer, atMs: atMs, rms: level.rms)
    write { try $0.write(buffer) }
    frames += Double(buffer.frameLength)
  }

  private func write(_ body: (PartWriter) throws -> Void) {
    guard let writer else { return }
    do {
      try body(writer)
    } catch {
      writer.discard()
      self.writer = nil
      onRecordingFailed(error)
    }
  }

  func setPaused(_ value: Bool) {
    lock.lock()
    paused = value
    lock.unlock()
    if value { recognizer?.cut() }
  }

  func close() {
    lock.lock()
    closed = true
    lock.unlock()
  }
}

final class CaptureSession {
  let options: StartOptions
  private let queue: DispatchQueue
  private let clock = AudioClock()
  private var pipelines: [SourcePipeline] = []
  private var mic: MicCapture?
  private var system: SystemAudioCapture?
  private var micDevice: AVCaptureDevice?
  private var recordingFailed = false
  /// The second language when both listen (bilingual).
  private var listeningSecond: String?
  private(set) var paused = false
  private(set) var stopping = false

  init(options: StartOptions, queue: DispatchQueue) {
    self.options = options
    self.queue = queue
  }

  private func fail(_ code: HelperError, _ message: String, source: String? = nil) {
    emitError(session: options.session, source: source, code, message, fatal: true)
  }

  /// The recording to write parts beside, its folder made.
  private func recordTarget() -> URL? {
    guard let path = options.recordPath else { return nil }
    let target = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    return target
  }

  private func pipeline(_ source: String, gain: Float, recognizer: SourceRecognizer?) -> SourcePipeline {
    let pipeline = SourcePipeline(source: source, session: options.session, gain: gain, clock: clock, levels: options.levels, recognizer: recognizer, recordTarget: recordTarget()) { [weak self] error in
      self?.queue.async {
        guard let self, !self.recordingFailed else { return }
        self.recordingFailed = true
        emitError(session: self.options.session, source: source, .recordingFailed, "Recording stopped: \(error.localizedDescription)", fatal: false)
      }
    }
    pipelines.append(pipeline)
    return pipeline
  }

  /// Starts capture without ever prompting; calls back on the control queue (false after a fatal error line).
  func start(_ completion: @escaping (Bool) -> Void) {
    let o = options
    guard Permissions.microphone() == "granted" else {
      fail(.micDenied, "Microphone access is not allowed.", source: "mic")
      return completion(false)
    }
    guard o.transcribe else { return listen(mic: nil, system: nil, engine: nil, completion) }
    guard Permissions.speech() == "granted" else {
      fail(.speechDenied, "Speech recognition is not allowed.")
      return completion(false)
    }
    // Each source gets its own recognizer, on the newer engine where it is ready (Engine.swift).
    let sources = o.meeting && Permissions.screen() == "granted" ? ["mic", "system"] : ["mic"]
    Engines.make(session: o.session, locale: o.locale, contextualStrings: o.contextualStrings, sources: sources, dictation: !o.meeting, queue: queue) { [self] made, engine in
      guard let mic = made["mic"] else {
        for recognizer in made.values { recognizer.finish {} }
        fail(.localeUnsupported, "Speech recognition is not available for \(o.locale).")
        return completion(false)
      }
      guard let second = o.secondaryLocale else { return listen(mic: mic, system: made["system"], engine: engine, completion) }
      // Bilingual: the second language hears the same audio; Atelier keeps what fits for each stretch.
      Engines.make(session: o.session, locale: second, contextualStrings: o.contextualStrings, sources: sources, dictation: !o.meeting, queue: queue) { [self] other, _ in
        let both = { (source: String, first: SourceRecognizer?) -> SourceRecognizer? in
          guard let first else { return nil }
          guard let extra = other[source] else { return first }
          return PairRecognizer(first, extra)
        }
        if other["mic"] != nil { listeningSecond = second }
        listen(mic: both("mic", mic), system: both("system", made["system"]), engine: engine, completion)
      }
    }
  }

  /// Starts the microphone, then system audio for a meeting, and prints `started`.
  private func listen(mic micRecognizer: SourceRecognizer?, system systemRecognizer: SourceRecognizer?, engine: SpeechEngine?, _ completion: @escaping (Bool) -> Void) {
    let o = options
    let release = {
      micRecognizer?.finish {}
      systemRecognizer?.finish {}
    }
    let picked = Devices.pick(o.deviceId)
    guard let device = picked.device else {
      release()
      fail(.deviceMissing, "No microphone is connected.", source: "mic")
      return completion(false)
    }
    micDevice = device
    let micPipeline = pipeline("mic", gain: o.micGain, recognizer: micRecognizer)
    clock.start()
    let capture = MicCapture(onBuffer: { [weak micPipeline] in micPipeline?.process($0) }, onInterrupted: { [weak self] lost in
      self?.queue.async { self?.micInterrupted(lost) }
    })
    do {
      try capture.start(device: device)
    } catch {
      release()
      fail(.micBusy, error.localizedDescription, source: "mic")
      return completion(false)
    }
    mic = capture
    let started: (Bool) -> Void = { [self] systemAudio in
      var line: [String: Any] = [
        "type": "started", "session": o.session, "mode": o.meeting ? "meeting" : "dictation",
        "onDevice": micRecognizer?.onDevice ?? false, "systemAudio": systemAudio,
        "deviceId": device.uniqueID, "locale": bcp47(o.locale), "fallbackDevice": picked.fallback,
      ]
      if let engine { line["engine"] = engine.rawValue }
      if let second = listeningSecond { line["secondaryLocale"] = bcp47(second) }
      emit(line)
      completion(true)
      _ = self
    }
    guard o.meeting else { return started(false) }
    // The other side of a call needs Screen Recording; without it the microphone carries on alone.
    guard Permissions.screen() == "granted" else {
      systemRecognizer?.finish {}
      emitError(session: o.session, source: "system", .screenDenied, "Screen Recording is not allowed, so only the microphone is captured.", fatal: false)
      return started(false)
    }
    let systemPipeline = pipeline("system", gain: o.systemGain, recognizer: systemRecognizer)
    let systemCapture = SystemAudioCapture(apps: o.apps, onBuffer: { [weak systemPipeline] in systemPipeline?.process($0) }, onStopped: { [weak self] error in
      self?.queue.async { self?.systemStopped(error) }
    })
    Task {
      do {
        try await systemCapture.start()
        queue.async { [self] in
          system = systemCapture
          started(true)
        }
      } catch {
        queue.async {
          emitError(session: o.session, source: "system", .screenDenied, "System audio can't be captured: \(error.localizedDescription)", fatal: false)
          started(false)
        }
      }
    }
  }

  /// The microphone dropped out (unplugged, or taken): report it and carry on with the default device.
  private func micInterrupted(_ lost: Bool) {
    guard !stopping else { return }
    emit(["type": lost ? "interrupted" : "restored", "session": options.session, "source": "mic"])
    guard lost, let mic, let current = micDevice, !current.isConnected, let fallback = AVCaptureDevice.default(for: .audio), fallback.uniqueID != current.uniqueID else { return }
    mic.stop()
    do {
      try mic.start(device: fallback)
      micDevice = fallback
      emit(["type": "restored", "session": options.session, "source": "mic"])
    } catch {
      emitError(session: options.session, source: "mic", .deviceMissing, "The microphone was disconnected.", fatal: false)
    }
  }

  /// System audio stopped (permission withdrawn, display gone): try once more, then go on without it.
  private func systemStopped(_ error: Error) {
    guard !stopping, let capture = system else { return }
    emit(["type": "interrupted", "session": options.session, "source": "system"])
    Task {
      do {
        try await capture.start()
        emit(["type": "restored", "session": options.session, "source": "system"])
      } catch {
        queue.async { [self] in
          system = nil
          emitError(session: options.session, source: "system", .screenDenied, "System audio stopped: \(error.localizedDescription)", fatal: false)
        }
      }
    }
  }

  func pause() {
    guard !paused, !stopping else { return }
    paused = true
    clock.pause()
    for pipeline in pipelines { pipeline.setPaused(true) }
    emit(["type": "paused", "session": options.session])
  }

  func resume() {
    guard paused, !stopping else { return }
    paused = false
    clock.resume()
    for pipeline in pipelines { pipeline.setPaused(false) }
    emit(["type": "resumed", "session": options.session])
  }

  /// Stops capture, lets recognition finish, merges the recording, prints `stopped`.
  func stop(_ completion: @escaping () -> Void) {
    guard !stopping else { return }
    stopping = true
    let durationMs = clock.nowMs()
    mic?.stop()
    mic = nil
    let systemCapture = system
    system = nil
    for pipeline in pipelines { pipeline.close() }
    Task {
      await systemCapture?.stop()
      queue.async { [self] in
        let group = DispatchGroup()
        for recognizer in pipelines.compactMap(\.recognizer) {
          group.enter()
          recognizer.finish { group.leave() }
        }
        group.notify(queue: queue) { [self] in
          if options.transcribe, !pipelines.contains(where: { $0.recognizer?.heardText == true }) {
            emitError(session: options.session, .noSpeech, "No speech was heard.", fatal: false)
          }
          finishRecording(durationMs: durationMs, completion)
        }
      }
    }
  }

  private func finishRecording(durationMs: Double, _ completion: @escaping () -> Void) {
    let stopped: (Any) -> Void = { [self] audio in
      emit(["type": "stopped", "session": options.session, "durationMs": ms(durationMs), "audio": audio])
      completion()
    }
    guard let path = options.recordPath else { return stopped(NSNull()) }
    let parts = pipelines.compactMap(\.writer)
    let target = URL(fileURLWithPath: path)
    Merger.merge(parts, into: target) { [self] result in
      queue.async { [self] in
        switch result {
        case .success(let bytes):
          stopped(["path": path, "bytes": bytes])
        case .failure(let error):
          if !recordingFailed {
            emitError(session: options.session, .recordingFailed, "The recording could not be saved: \(error.localizedDescription)", fatal: false)
          }
          stopped(NSNull())
        }
      }
    }
  }
}

/// Runs commands one at a time and holds the one session.
final class Controller {
  let queue = DispatchQueue(label: "com.sennechin.atelier.speech.control")
  private var session: CaptureSession?
  private var starting = false
  private var stopAfterStart = false
  private var transcriber: FileTranscriber?

  func handle(line: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let cmd = json["cmd"] as? String else {
      emitError(.invalid, "Unreadable command.", fatal: false)
      return
    }
    queue.async { self.run(cmd, json) }
  }

  private func run(_ cmd: String, _ json: [String: Any]) {
    switch cmd {
    case "hello":
      emit(["type": "ready", "version": protocolVersion])
    case "permissions":
      emit(Permissions.report())
    case "request":
      Permissions.request((json["what"] as? String) ?? "") { emit(Permissions.report()) }
    case "devices":
      emit(Devices.report())
    case "locales":
      Locales.send()
    case "prepare":
      prepareSpeech(json)
    case "start":
      start(json)
    case "pause":
      guard let session, !starting else { return idle() }
      session.pause()
    case "resume":
      guard let session, !starting else { return idle() }
      session.resume()
    case "stop":
      stop()
    case "transcribe":
      transcribe(json)
    case "recover":
      recover(json)
    case "authenticate":
      Auth.authenticate(id: (json["id"] as? String) ?? "", reason: (json["reason"] as? String) ?? "")
    case "frontmost":
      emit(Apps.frontmost())
    case "activate":
      if let pid = (json["pid"] as? NSNumber)?.int32Value { Apps.activate(pid) }
    case "watch-calls":
      CallWatchCommand.run(json)
    default:
      emitError(.invalid, "Unknown command \(cmd).", fatal: false)
    }
  }

  private func idle() {
    emitError(.invalid, "Nothing is recording.", fatal: false)
  }

  private func start(_ json: [String: Any]) {
    guard let options = StartOptions(json) else {
      emitError(session: json["session"] as? String, .invalid, "The start command is incomplete.", fatal: true)
      return
    }
    guard session == nil, transcriber == nil else {
      emitError(session: options.session, .busy, "Another session is running.", fatal: true)
      return
    }
    let next = CaptureSession(options: options, queue: queue)
    session = next
    starting = true
    stopAfterStart = false
    next.start { [self] ok in
      starting = false
      guard ok else {
        if session === next { session = nil }
        return
      }
      if stopAfterStart { stop() }
    }
  }

  private func stop() {
    if let transcriber {
      transcriber.cancel()
      return
    }
    guard let current = session else { return idle() }
    if starting {
      stopAfterStart = true
      return
    }
    current.stop { [self] in
      if session === current { session = nil }
    }
  }

  private func transcribe(_ json: [String: Any]) {
    guard let id = json["session"] as? String, let path = json["path"] as? String, let locale = json["locale"] as? String else {
      emitError(session: json["session"] as? String, .invalid, "The transcribe command is incomplete.", fatal: true)
      return
    }
    guard session == nil, transcriber == nil else {
      emitError(session: id, .busy, "Another session is running.", fatal: true)
      return
    }
    let strings = Array(((json["contextualStrings"] as? [String]) ?? []).prefix(100))
    // Bilingual: the file is heard once per language, and Atelier keeps what fits for each stretch.
    let second = (json["secondaryLocale"] as? String).flatMap { $0.isEmpty || $0 == locale ? nil : $0 }
    let url = URL(fileURLWithPath: path)
    let job = FileTranscriber(session: id, url: url, locale: locale, contextualStrings: strings, queue: queue, share: (0, second == nil ? 1 : 0.5), last: second == nil)
    transcriber = job
    job.run { [self] in
      guard transcriber === job else { return }
      guard let second, job.succeeded else {
        transcriber = nil
        return
      }
      let next = FileTranscriber(session: id, url: url, locale: second, contextualStrings: strings, queue: queue, share: (0.5, 1), last: true, quiet: true)
      transcriber = next
      next.run { [self] in
        if transcriber === next { transcriber = nil }
      }
    }
  }

  /// A recording a session never finished (Atelier crashed or was force quit,
  /// or its merge failed): merges the parts left beside `path` into it.
  /// Runs beside any session; the parts belong to no running one.
  private func recover(_ json: [String: Any]) {
    guard let id = json["id"] as? String, let path = json["path"] as? String else {
      emitError(.invalid, "The recover command is incomplete.", fatal: false)
      return
    }
    let target = URL(fileURLWithPath: path)
    let reply: (Any, String?) -> Void = { audio, error in
      var line: [String: Any] = ["type": "recovered", "id": id, "audio": audio, "durationMs": audio is NSNull ? 0 : ms(Merger.durationMs(of: target))]
      if let error { line["error"] = error }
      emit(line)
    }
    let found = Parts.leftBehind(target: target)
    let parts = found.filter { Parts.hasAudio($0.url) }
    // Parts with nothing in them (it stopped before the first frame) have nothing to give.
    for part in found where !parts.contains(where: { $0.url == part.url }) { try? FileManager.default.removeItem(at: part.url) }
    guard !parts.isEmpty else { return reply(NSNull(), nil) }
    Merger.merge(parts, into: target) { [self] result in
      queue.async {
        switch result {
        case .success(let bytes):
          reply(["path": path, "bytes": bytes], nil)
        case .failure(let error):
          reply(NSNull(), error.localizedDescription)
        }
      }
    }
  }

  /// Atelier went away: finish what is running (briefly), then exit.
  func shutdown(_ done: @escaping () -> Void) {
    queue.async { [self] in
      var finished = false
      let once = {
        guard !finished else { return }
        finished = true
        done()
      }
      queue.asyncAfter(deadline: .now() + 3, execute: once)
      transcriber?.cancel()
      if let session, !starting {
        session.stop { once() }
      } else {
        once()
      }
    }
  }
}
