import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 } as const
const output = execFileSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../test/fixtures/public-consumer.ts', import.meta.url))], options)
if (output.trim())
  throw new Error('Importing the public API must not run the CLI.')

const help = execFileSync(process.execPath, [fileURLToPath(new URL('../dist/cli.mjs', import.meta.url)), 'help'], options)
if (!help.includes('serve') || !help.includes('run'))
  throw new Error('The packaged CLI did not list its run and serve commands.')
