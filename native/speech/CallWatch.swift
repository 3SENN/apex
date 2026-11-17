/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Calls in other apps: which processes have audio
// running, from Core Audio's process objects (macOS 14.4+), and which of the
// apps Apex asked about are open (NSWorkspace). Reading either needs no
// permission and shows no prompt, and nothing is captured: this only tells
// Apex that, say, Zoom has the microphone open. Apex decides what counts as
// a call (src/main/meetings/capture/desktopCalls.ts).
//
// `{"cmd":"watch-calls","apps":[prefixes]}` starts it (and prints a snapshot
// at once); `"apps":null` stops it. Each change prints one full snapshot:
//   {"type":"calls","supported":true,
//    "audio":[{"pid","bundleId","exe","appPid","appBundleId","input","output"}],
//    "apps":[{"pid","bundleId","name"}]}
// `audio` lists every process with the microphone open, and processes
// playing sound only when they belong to a watched app; this helper's own
// process is left out (Apex's own recordings).

import AppKit
import CoreAudio
import Darwin
import Foundation

final class CallWatch {
  static let shared = CallWatch()

  private var prefixes: [String] = []
  private var watching = false
  private var observers: [NSObjectProtocol] = []
  private var listened: Set<AudioObjectID> = []
  private var pending: DispatchWorkItem?
  private var lastLine = ""
  private let ownPid = getpid()

  private lazy var listChanged: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.schedule() }
  private lazy var processChanged: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.schedule() }

  /// Per-app microphone use is read from process objects, which macOS 14.4 completed.
  static var supported: Bool {
    if #available(macOS 14.4, *) { return true }
    return false
  }

  /// Starts (or retargets) the watch. Called on the main queue.
  func start(apps: [String]) {
    prefixes = Array(apps.prefix(256))
    lastLine = ""
    if !watching {
      watching = true
      let center = NSWorkspace.shared.notificationCenter
      for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
        observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.schedule() })
      }
      if CallWatch.supported {
        var address = CallWatch.address(kAudioHardwarePropertyProcessObjectList)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listChanged)
      }
    }
    report()
  }

  func stop() {
    guard watching else { return }
    watching = false
    pending?.cancel()
    pending = nil
    for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    observers = []
    if CallWatch.supported {
      var address = CallWatch.address(kAudioHardwarePropertyProcessObjectList)
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listChanged)
      for id in listened { unlisten(id) }
    }
    listened = []
  }

  /// Changes come in bursts (an app opening its input and output): one snapshot after they settle.
  private func schedule() {
    guard watching else { return }
    pending?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.report() }
    pending = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
  }

  private func report() {
    guard watching else { return }
    let audio = CallWatch.supported ? audioProcesses() : []
    let apps: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { app in
      guard app.activationPolicy == .regular, let id = app.bundleIdentifier, watched(id) else { return nil }
      return ["pid": Int(app.processIdentifier), "bundleId": id, "name": app.localizedName ?? id]
    }
    let line: [String: Any] = ["type": "calls", "supported": CallWatch.supported, "audio": audio, "apps": apps]
    // Only what changed is worth a line.
    guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
          let key = String(data: data, encoding: .utf8), key != lastLine else { return }
    lastLine = key
    emit(line)
  }

  private func watched(_ id: String?) -> Bool {
    guard let id else { return false }
    return prefixes.contains { prefix in
      prefix.hasSuffix(".") ? id.hasPrefix(prefix) : (id == prefix || id.hasPrefix(prefix + "."))
    }
  }

  // ── Core Audio ──

  private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }

  private func processObjects() -> [AudioObjectID] {
    var address = CallWatch.address(kAudioHardwarePropertyProcessObjectList)
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
  }

  private func flag(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
    var address = CallWatch.address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr && value != 0
  }

  private func pid(_ id: AudioObjectID) -> pid_t? {
    var address = CallWatch.address(kAudioProcessPropertyPID)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr && value > 0 ? value : nil
  }

  private func bundleId(_ id: AudioObjectID) -> String? {
    var address = CallWatch.address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let string = value?.takeRetainedValue() as String?, !string.isEmpty else { return nil }
    return string
  }

  private func listen(_ id: AudioObjectID) {
    for selector in [kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyIsRunningOutput] {
      var address = CallWatch.address(selector)
      AudioObjectAddPropertyListenerBlock(id, &address, .main, processChanged)
    }
  }

  private func unlisten(_ id: AudioObjectID) {
    for selector in [kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyIsRunningOutput] {
      var address = CallWatch.address(selector)
      AudioObjectRemovePropertyListenerBlock(id, &address, .main, processChanged)
    }
  }

  private func audioProcesses() -> [[String: Any]] {
    let ids = processObjects()
    // Listen to each process object's input and output, and let go of the ones that went.
    let current = Set(ids)
    for id in current.subtracting(listened) { listen(id) }
    for id in listened.subtracting(current) { unlisten(id) }
    listened = current

    var out: [[String: Any]] = []
    for id in ids {
      guard let pid = pid(id), pid != ownPid else { continue }
      let input = flag(id, kAudioProcessPropertyIsRunningInput)
      let output = flag(id, kAudioProcessPropertyIsRunningOutput)
      guard input || output else { continue }
      let bundle = bundleId(id)
      let owner = CallWatch.owner(of: pid)
      // Sound alone is reported only for the apps Apex asked about (a call muted on this side).
      guard input || watched(bundle) || watched(owner?.bundleIdentifier) else { continue }
      out.append([
        "pid": Int(pid), "bundleId": orNull(bundle), "exe": orNull(CallWatch.executable(pid)),
        "appPid": orNull(owner.map { Int($0.processIdentifier) }), "appBundleId": orNull(owner?.bundleIdentifier),
        "input": input, "output": output,
      ])
      if out.count >= 200 { break }
    }
    return out
  }

  // ── processes ──

  /// The app a process belongs to: itself, or the nearest regular app among its parents (Electron and Chromium helpers).
  private static func owner(of pid: pid_t) -> NSRunningApplication? {
    var current = pid
    for _ in 0..<8 {
      if let app = NSRunningApplication(processIdentifier: current), app.bundleIdentifier != nil, app.activationPolicy == .regular { return app }
      guard let next = parent(of: current), next > 1, next != current else { return nil }
      current = next
    }
    return nil
  }

  private static func parent(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
  }

  /// The executable's name, for system services without a bundle (FaceTime's avconferenced).
  private static func executable(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 256)
    let length = proc_name(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return String(cString: buffer)
  }
}

enum CallWatchCommand {
  /// `watch-calls`: apps is the list of bundle prefixes, or null to stop.
  static func run(_ json: [String: Any]) {
    let apps = json["apps"] as? [String]
    DispatchQueue.main.async {
      if let apps { CallWatch.shared.start(apps: apps) } else { CallWatch.shared.stop() }
    }
  }
}
