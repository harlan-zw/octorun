import { writeFileSync } from 'node:fs'

writeFileSync(process.argv[2]!, JSON.stringify({ env: process.env, cwd: process.cwd() }))
if (process.argv.includes('auth')) {
  process.stdout.write(JSON.stringify({ loggedIn: true }))
}
else {
  for await (const _chunk of process.stdin) { /* Consume the test turn. */ }
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'A bounded answer.',
    usage: { input_tokens: 5, output_tokens: 7 },
  }))
}
