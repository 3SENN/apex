// A fake native-messaging host for tests/nativeMessaging.test.ts: Chrome's
// framing (a 4-byte little-endian length, then UTF-8 JSON) on stdin and
// stdout. It echoes each message; a few commands exercise the edges.
//   { cmd: 'split' }  replies in two chunks, split inside the length prefix
//   { cmd: 'two' }    replies twice in one write
//   { cmd: 'big' }    sends a frame over the 1 MB cap
//   { cmd: 'garbage'} sends a frame that isn't JSON
//   { cmd: 'exit' }   replies, then exits at once
//   { cmd: 'whoami' } replies with its arguments, working directory and a few environment variables
let pending = Buffer.alloc(0)

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

function handle(message) {
  const cmd = message && typeof message === 'object' ? message.cmd : undefined
  if (cmd === 'split') {
    const out = frame({ echo: message, split: true })
    process.stdout.write(out.subarray(0, 2))
    setTimeout(() => process.stdout.write(out.subarray(2)), 20)
  } else if (cmd === 'two') {
    process.stdout.write(Buffer.concat([frame({ n: 1 }), frame({ n: 2 })]))
  } else if (cmd === 'big') {
    const head = Buffer.alloc(4)
    head.writeUInt32LE(1024 * 1024 + 1, 0)
    process.stdout.write(head)
  } else if (cmd === 'garbage') {
    const body = Buffer.from('{not json', 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    process.stdout.write(Buffer.concat([head, body]))
  } else if (cmd === 'whoami') {
    process.stdout.write(frame({ args: process.argv.slice(2), cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, home: process.env.HOME ?? null }))
  } else if (cmd === 'exit') {
    process.stdout.write(frame({ bye: true }), () => process.exit(0))
  } else {
    process.stdout.write(frame({ echo: message, origin: process.argv[2] ?? null }))
  }
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4) {
    const size = pending.readUInt32LE(0)
    if (pending.length < 4 + size) break
    const body = pending.subarray(4, 4 + size)
    pending = pending.subarray(4 + size)
    handle(JSON.parse(body.toString('utf8')))
  }
})
process.stdin.on('end', () => process.exit(0))
