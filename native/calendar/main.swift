/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-calendar: Atelier's read-only Calendar and Reminders helper.
// One command per run, answered in JSON lines on stdout (src/main/calendar.ts
// parses them with zod; unknown lines are ignored):
//
//   status                          {"type":"status","events":P,"reminders":P}
//   request events|reminders        asks macOS, then prints the status line
//   events --from <ms> --to <ms>    {"type":"event",...} per event, then {"type":"end"}
//   reminders                       {"type":"reminder",...} per reminder, then {"type":"end"}
//   watch                           {"type":"changed"} whenever the store changes; runs until stopped
//
// P is not-determined, denied, granted or restricted. Failures print
// {"type":"error","message":...} and exit 1. Nothing here writes to the
// person's calendars or reminders: EventKit is only ever read.

import EventKit
import Foundation

let store = EKEventStore()
/// Events and reminders one run returns at most (CALENDAR_ITEMS_MAX on the TypeScript side).
let itemsMax = 500
/// The widest range one events run reads (CALENDAR_RANGE_MAX_MS).
let rangeMaxMs: Double = 62 * 24 * 60 * 60 * 1000

func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(1)
}

func ms(_ date: Date) -> Double {
  (date.timeIntervalSince1970 * 1000).rounded()
}

func clip(_ text: String?, _ max: Int) -> String {
  guard let text else { return "" }
  return text.count > max ? String(text.prefix(max)) : text
}

// ── Permissions ──

/// Raw values, so the macOS 14 cases (fullAccess 3, writeOnly 4) compile against a macOS 13 target.
func permission(_ type: EKEntityType) -> String {
  switch EKEventStore.authorizationStatus(for: type).rawValue {
  case 0: return "not-determined"
  case 1: return "restricted"
  case 3: return "granted" // authorized on 13, fullAccess on 14
  default: return "denied" // denied, and write-only access (it can't read)
  }
}

func emitStatus() {
  emit(["type": "status", "events": permission(.event), "reminders": permission(.reminder)])
}

/// Waits for an EventKit callback while keeping the main run loop turning, so the system prompt can show.
func wait(_ start: (@escaping () -> Void) -> Void) {
  var done = false
  start { DispatchQueue.main.async { done = true } }
  let deadline = Date().addingTimeInterval(115)
  while !done && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }
}

func request(_ type: EKEntityType) {
  wait { finish in
    if #available(macOS 14.0, *) {
      if type == .event {
        store.requestFullAccessToEvents { _, _ in finish() }
      } else {
        store.requestFullAccessToReminders { _, _ in finish() }
      }
    } else {
      store.requestAccess(to: type) { _, _ in finish() }
    }
  }
  emitStatus()
}

// ── Reading ──

/// The first meeting-looking link in free text (notes often carry the call link).
func firstLink(_ text: String?) -> String? {
  guard let text, let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
  let range = NSRange(text.startIndex..., in: text)
  for match in detector.matches(in: text, options: [], range: range) {
    if let url = match.url, url.scheme == "https" || url.scheme == "http" { return url.absoluteString }
  }
  return nil
}

func number(after flag: String, in args: [String]) -> Double? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return Double(args[i + 1])
}

func events(_ args: [String]) {
  guard permission(.event) == "granted" else { fail("Calendar access hasn’t been granted.") }
  guard let from = number(after: "--from", in: args), let to = number(after: "--to", in: args), to >= from else {
    fail("events needs --from and --to in milliseconds.")
  }
  guard to - from <= rangeMaxMs else { fail("Ask for at most two months at a time.") }
  let start = Date(timeIntervalSince1970: from / 1000)
  let end = Date(timeIntervalSince1970: to / 1000)
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  let found = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(itemsMax)
  for event in found {
    var line: [String: Any] = [
      "type": "event",
      "id": clip(event.calendarItemIdentifier, 512),
      "title": clip(event.title, 1000),
      "startsAt": ms(event.startDate),
      "endsAt": ms(event.endDate),
      "allDay": event.isAllDay,
      "calendar": clip(event.calendar?.title, 500),
    ]
    line["location"] = event.location.map { clip($0, 2000) as Any } ?? NSNull()
    line["url"] = (event.url?.absoluteString ?? firstLink(event.notes)).map { clip($0, 4000) as Any } ?? NSNull()
    if (line["id"] as? String)?.isEmpty == false { emit(line) }
  }
  emit(["type": "end"])
}

func reminders() {
  guard permission(.reminder) == "granted" else { fail("Reminders access hasn’t been granted.") }
  var found: [EKReminder] = []
  let open = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
  // Recently completed ones too, so "what did I finish this week" can be answered.
  let recent = store.predicateForCompletedReminders(withCompletionDateStarting: Date().addingTimeInterval(-14 * 86_400), ending: Date(), calendars: nil)
  for predicate in [open, recent] {
    wait { finish in
      store.fetchReminders(matching: predicate) { items in
        found.append(contentsOf: items ?? [])
        finish()
      }
    }
  }
  let calendar = Calendar.current
  for reminder in found.prefix(itemsMax) {
    let due = reminder.dueDateComponents.flatMap { calendar.date(from: $0) }
    let id = clip(reminder.calendarItemIdentifier, 512)
    if id.isEmpty { continue }
    emit([
      "type": "reminder",
      "id": id,
      "title": clip(reminder.title, 1000),
      "dueAt": due.map { ms($0) as Any } ?? NSNull(),
      "list": clip(reminder.calendar?.title, 500),
      "completed": reminder.isCompleted,
    ])
  }
  emit(["type": "end"])
}

func watch() -> Never {
  NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in
    emit(["type": "changed"])
  }
  // Atelier stops this run by ending the process; a closed pipe ends it too.
  signal(SIGPIPE, SIG_DFL)
  RunLoop.main.run()
  exit(0)
}

// ── Entry ──

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "status":
  emitStatus()
case "request":
  switch args.dropFirst().first {
  case "events": request(.event)
  case "reminders": request(.reminder)
  default: fail("request needs events or reminders.")
  }
case "events":
  events(args)
case "reminders":
  reminders()
case "watch":
  watch()
default:
  fail("Unknown command. Use status, request, events, reminders or watch.")
}
exit(0)
