// A fake apex-calendar for tests and smoke: the same
// JSON-lines protocol as native/calendar/main.swift, with no EventKit.
// APEX_CALENDAR_HELPER points at this file; CalendarService runs it under
// Node. The state comes from the environment:
//   APEX_FAKE_CALENDAR_EVENTS     the events permission (default granted)
//   APEX_FAKE_CALENDAR_REMINDERS  the reminders permission (default granted)
//   APEX_FAKE_CALENDAR_GRANT      "1": a request grants; otherwise it denies
//   APEX_FAKE_CALENDAR_FIXTURE    the items file (default items.json next to this one)
//   APEX_FAKE_CALENDAR_FAIL       "1": every command prints an error line
// Times in the fixture are minutes from now (startsInMin, endsInMin, dueInMin).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
const print = (line) => process.stdout.write(JSON.stringify(line) + '\n')
const [command, ...args] = process.argv.slice(2)

if (env.APEX_FAKE_CALENDAR_FAIL === '1') {
  print({ type: 'error', message: 'The fake helper was told to fail.' })
  process.exit(1)
}

let events = env.APEX_FAKE_CALENDAR_EVENTS ?? 'granted'
let reminders = env.APEX_FAKE_CALENDAR_REMINDERS ?? 'granted'
const status = () => print({ type: 'status', events, reminders })
const fixture = JSON.parse(readFileSync(env.APEX_FAKE_CALENDAR_FIXTURE ?? join(dirname(fileURLToPath(import.meta.url)), 'items.json'), 'utf8'))
const at = (min) => Date.now() + min * 60_000
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : NaN
}

switch (command) {
  case 'status':
    status()
    break
  case 'request': {
    const outcome = env.APEX_FAKE_CALENDAR_GRANT === '1' ? 'granted' : 'denied'
    if (args[0] === 'events') events = outcome
    else if (args[0] === 'reminders') reminders = outcome
    else {
      print({ type: 'error', message: 'request needs events or reminders.' })
      process.exit(1)
    }
    status()
    break
  }
  case 'events': {
    if (events !== 'granted') {
      print({ type: 'error', message: 'No access to calendars.' })
      process.exit(1)
    }
    const from = flag('--from')
    const to = flag('--to')
    // A line Apex must ignore, to prove junk never breaks the parse.
    process.stdout.write('not json\n')
    for (const e of fixture.events) {
      const startsAt = e.allDay ? new Date(new Date().toDateString()).getTime() : at(e.startsInMin)
      const endsAt = e.allDay ? startsAt + 86_400_000 : at(e.endsInMin)
      if (endsAt < from || startsAt > to) continue
      print({ type: 'event', id: e.id, title: e.title, startsAt, endsAt, allDay: Boolean(e.allDay), calendar: e.calendar, location: e.location ?? null, url: e.url ?? null })
    }
    print({ type: 'end' })
    break
  }
  case 'reminders':
    if (reminders !== 'granted') {
      print({ type: 'error', message: 'No access to reminders.' })
      process.exit(1)
    }
    for (const r of fixture.reminders) print({ type: 'reminder', id: r.id, title: r.title, dueAt: r.dueInMin === null ? null : at(r.dueInMin), list: r.list, completed: r.completed })
    print({ type: 'end' })
    break
  case 'watch':
    print({ type: 'changed' })
    setInterval(() => undefined, 60_000)
    break
  default:
    print({ type: 'error', message: 'Unknown command.' })
    process.exit(1)
}
