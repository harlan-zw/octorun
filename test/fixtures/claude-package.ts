#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const login = fileURLToPath(new URL('./claude-login', import.meta.url))

if (process.argv[2] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: !existsSync(login) || readFileSync(login, 'utf8') !== 'logout', email: 'private@example.test' }))
}
else {
  for await (const _chunk of process.stdin) { /* Consume supplied repository text without running it. */ }
  const path = process.argv[process.argv.indexOf('--system-prompt-file') + 1]!
  const system = readFileSync(path, 'utf8')
  const candidate = { path: 'src/account.ts', side: 'RIGHT', line: 2, title: 'Handle missing accounts', body: 'A missing account throws when its name is read.', evidence: 'return account.name', severity: 'high', confidence: 94 }
  const result = system.includes('Answer only the question')
    ? 'The finding concerns a missing account. This answer does not change repository code.'
    : system.includes('Independently challenge') ? JSON.stringify({ accepted: ['correctness-0'] }) : JSON.stringify({ findings: [candidate] })
  appendFileSync(new URL('./claude-calls', import.meta.url), '.\n')
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result, usage: { input_tokens: 10, output_tokens: 20 } }))
}
