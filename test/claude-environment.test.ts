import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { checkClaudeAuthentication, createClaudeProvider } from '../src/providers.ts'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/claude-environment.ts', import.meta.url))
const controllerVariables = [
  'OCTORUN_GITHUB_PRIVATE_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'APP_KEY',
  'OCTORUN_API_KEY',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'LC_CONTROLLER_SECRET',
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'octorun-claude-env-'))
  roots.push(root)
  const record = join(root, 'environment.json')
  const env = {
    HOME: root,
    PATH: '/usr/bin:/bin',
    CLAUDE_CONFIG_DIR: join(root, 'claude-profile'),
    XDG_CONFIG_HOME: join(root, 'configuration'),
    LANG: 'en_AU.UTF-8',
    LC_CTYPE: 'en_AU.UTF-8',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
    no_proxy: 'localhost',
    NODE_EXTRA_CA_CERTS: '',
    ...Object.fromEntries(controllerVariables.map(key => [key, `synthetic-${key}`])),
    // These inert values keep the red test safe before environment isolation exists.
    NODE_OPTIONS: '--no-warnings',
    LD_PRELOAD: '',
  }
  return { root, record, env }
}

it('keeps controller credentials and backend overrides out of Claude turns', async () => {
  const test = await setup()
  const provider = createClaudeProvider({ stateDir: join(test.root, 'state'), command: process.execPath, args: [fixture, test.record], env: test.env })
  const result = await provider.generate({ messages: [{ role: 'user', content: 'Answer the question.' }], maxOutputTokens: 16, signal: new AbortController().signal })
  expect(result).toMatchObject({ _tag: 'Ok', value: { text: 'A bounded answer.' } })
  const boundary = JSON.parse(await readFile(test.record, 'utf8'))
  expect(boundary.env).toMatchObject({ HOME: test.root, PATH: test.env.PATH, CLAUDE_CONFIG_DIR: test.env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: test.env.XDG_CONFIG_HOME, LANG: test.env.LANG, LC_CTYPE: test.env.LC_CTYPE, HTTPS_PROXY: test.env.HTTPS_PROXY, no_proxy: 'localhost' })
  for (const key of controllerVariables)
    expect(boundary.env[key], key).toBeUndefined()
})

it('checks stored Claude login with the same isolated environment', async () => {
  const test = await setup()
  expect(await checkClaudeAuthentication({ command: process.execPath, args: [fixture, test.record], env: test.env })).toEqual({ _tag: 'Ok', value: { authenticated: true } })
  const boundary = JSON.parse(await readFile(test.record, 'utf8'))
  expect(boundary.cwd).toBe(test.root)
  expect(boundary.env).toMatchObject({ HOME: test.root, CLAUDE_CONFIG_DIR: test.env.CLAUDE_CONFIG_DIR, HTTPS_PROXY: test.env.HTTPS_PROXY })
  for (const key of controllerVariables)
    expect(boundary.env[key], key).toBeUndefined()
})

it('pins the selected login environment before later controller mutation', async () => {
  const test = await setup()
  const options = { stateDir: join(test.root, 'state'), command: process.execPath, args: [fixture, test.record], env: test.env }
  const provider = createClaudeProvider(options)
  const original = provider.id
  test.env.HOME = '/changed/controller/home'
  test.env.HTTPS_PROXY = 'http://changed.example.test:8080'
  const changed = createClaudeProvider(options)
  expect(changed.id).not.toBe(original)
  expect(await provider.generate({ messages: [{ role: 'user', content: 'Answer the question.' }], maxOutputTokens: 16, signal: new AbortController().signal })).toMatchObject({ _tag: 'Ok' })
  const boundary = JSON.parse(await readFile(test.record, 'utf8'))
  expect(boundary.env.HOME).toBe(test.root)
  expect(boundary.env.HTTPS_PROXY).toBe('http://proxy.example.test:8080')
})
