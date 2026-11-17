#!/usr/bin/env node
// A tiny MCP server over stdio for Atelier's tests and smoke: JSON-RPC
// lines on stdin/stdout, no dependencies. Tools: echo (read-only), add, and
// create_note (needs a confirm in Atelier); resources: two notes for # search.
// It logs one stderr line that includes FIXTURE_SECRET, so masking is tested.
import { createInterface } from 'node:readline'

const notes = [
  { uri: 'note://welcome', name: 'Welcome note', description: 'How the fixture works', text: 'Hello from the fixture server.' },
  { uri: 'note://plan', name: 'Launch plan', description: 'Steps for the launch', text: 'Step one: test. Step two: ship.' },
]
const tools = [
  { name: 'echo', title: 'Echo', description: 'Returns the text it gets.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  {
    name: 'create_note',
    description: 'Saves a note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title' },
        body: { type: 'string', format: 'textarea' },
        to: { type: 'array', items: { type: 'string', format: 'email' } },
        when: { type: 'string', format: 'date-time' },
        kind: { type: 'string', enum: ['idea', 'task'] },
        pinned: { type: 'boolean' },
      },
      required: ['title'],
    },
    annotations: { title: 'Save note' },
  },
]

process.stderr.write(`fixture starting with secret ${process.env.FIXTURE_SECRET ?? 'none'}\n`)
if (process.argv.includes('--noise')) process.stdout.write('this line is not json\n')
if (process.argv.includes('--crash')) process.exit(3)

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'atelier-fixture', version: '1.0.0' } })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools })
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {}
      if (name === 'echo') return reply({ content: [{ type: 'text', text: String(args.text ?? '') }] })
      if (name === 'add') return reply({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] })
      if (name === 'create_note') return reply({ content: [{ type: 'text', text: `saved ${JSON.stringify(args)}` }] })
      return reply({ content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true })
    }
    case 'resources/list':
      return reply({ resources: notes.map(({ uri, name, description }) => ({ uri, name, description, mimeType: 'text/plain' })) })
    case 'resources/read': {
      const note = notes.find((n) => n.uri === msg.params?.uri)
      return note ? reply({ contents: [{ uri: note.uri, mimeType: 'text/plain', text: note.text }] }) : fail(-32002, 'not found')
    }
    default:
      return fail(-32601, 'method not found')
  }
})
