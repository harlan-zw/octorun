import { execFile } from 'node:child_process'
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const roots: string[] = []
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'octorun-claude-cli-'))
  roots.push(root)
  const home = join(root, 'operator')
  await mkdir(home)
  const command = join(home, 'claude.ts')
  await copyFile(new URL('./fixtures/claude-package.ts', import.meta.url), command)
  await chmod(command, 0o700)
  const path = join(root, 'config.json')
  const stateDir = join(root, 'state')
  await writeFile(path, JSON.stringify({ version: 1, stateDir, github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'HOOK_KEY' }, provider: { _tag: 'Claude', command }, repositories: [{ id: 10, fullName: 'acme/project', installationId: 20 }] }))
  const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, APP_KEY: 'synthetic-key' }
  return { root, path, stateDir, command, env }
}

it('checks Claude login without an API key, a paid turn, or state creation', async () => {
  const fixture = await setup()
  const result = await execute(process.execPath, [cli, '--config', fixture.path, '--json', 'doctor'], { env: fixture.env, cwd: fixture.root })
  expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, scope: 'local', provider: { kind: 'Claude', authenticated: true, authentication: 'authenticated' } })
  expect(result.stdout).not.toContain('private@example.test')
  await expect(access(fixture.stateDir)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('returns a failing exit status and a login remedy when Claude is signed out', async () => {
  const fixture = await setup()
  const result = await execute(process.execPath, [cli, '--config', fixture.path, '--json', 'doctor'], { env: { ...fixture.env, OCTORUN_AUTH_SCENARIO: 'logout' }, cwd: fixture.root }).then(value => ({ ...value, code: 0 }), error => ({ stdout: String(error.stdout), code: error.code }))
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ ready: false, provider: { authenticated: false, error: expect.stringContaining('claude auth login') } })
})

it('creates a Claude configuration with no unused HTTP secret reference', async () => {
  const fixture = await setup()
  const output = join(fixture.root, 'new.yaml')
  await execute(process.execPath, [cli, 'init', '--output', output, '--repository', 'acme/project', '--repository-id', '10', '--installation-id', '20', '--app-id', '7', '--provider', 'claude'], { env: fixture.env })
  const validated = await execute(process.execPath, [cli, '--config', output, '--json', 'config'], { env: fixture.env })
  expect(JSON.parse(validated.stdout).provider).toEqual({ _tag: 'Claude', command: 'claude', model: 'claude-opus-5-5', timeoutMs: 180000, maxResponseBytes: 2097152, maxInputBytes: 262144 })
})
