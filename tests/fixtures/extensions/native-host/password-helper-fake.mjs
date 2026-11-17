// A stand-in for a password manager's macOS helper, for the smoke check that
// loads Apple's iCloud Passwords extension (src/main/smokeFilesConnectors/applePasswords.ts).
// It is NOT Apple's helper and knows none of its secrets: it answers the
// extension's first handshake the way the extension's own code expects it
// (read from the extension's background script), so the extension reaches
// its pairing step, and logs what it was sent.
//   in  { cmd: 14 }                         (hello)      → { cmd: 14, capabilities }
//   in  { cmd: 2, msg: '{"QID":"m0",…}' }   (challenge)  → { cmd: 2, payload: { QID: 'm0', PAKE } }
//   anything else (tab events, end of operation…) is logged, with no reply.
// The log (one JSON line per message, plus a first line with how it was
// started) goes to APEX_FAKE_HELPER_LOG.
import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const logFile = process.env.APEX_FAKE_HELPER_LOG
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}
log({ started: true, args: process.argv.slice(2), cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null })

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

const CAPABILITIES = {
  shouldUseBase64: true,
  secretSessionVersion: 1,
  canFillOneTimeCodes: true,
  operatingSystem: { name: 'macos', majorVersion: 15, minorVersion: 0 },
  supportsSubURLs: true,
  scanForOTPURI: false,
  canSaveAccountWithEmptyUserName: true,
  canOpenPasswordsAppToNewPasswordSheet: true,
}

function handle(message) {
  const cmd = message && typeof message === 'object' ? message.cmd : undefined
  let qid = null
  if (cmd === 2 && typeof message.msg === 'string') {
    try {
      qid = JSON.parse(message.msg).QID ?? null
    } catch {
      qid = null
    }
  }
  log({ cmd, qid, tid: typeof message?.payload === 'string' ? (JSON.parse(message.payload).TID ?? null) : null })
  if (cmd === 14) process.stdout.write(frame({ cmd: 14, capabilities: CAPABILITIES }))
  // A made-up first PAKE message: the extension only stores it until a code is typed.
  else if (cmd === 2 && qid === 'm0') process.stdout.write(frame({ cmd: 2, payload: { QID: 'm0', PAKE: randomBytes(48).toString('base64') } }))
}

let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4) {
    const size = pending.readUInt32LE(0)
    if (pending.length < 4 + size) break
    const body = pending.subarray(4, 4 + size)
    pending = pending.subarray(4 + size)
    try {
      handle(JSON.parse(body.toString('utf8')))
    } catch (err) {
      log({ error: String(err) })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
