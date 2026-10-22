import { expect, it } from 'vitest'
import { parseCliArguments } from '../src/cli-arguments.ts'
import { parseConfig, resolveSecrets } from '../src/config.ts'

const input = (provider: unknown) => ({ version: 1, github: { appId: '123', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'HOOK_KEY' }, provider, repositories: [{ id: 7, fullName: 'team/example', installationId: 8 }] })
const context = { configDir: '/tmp/octorun-config', home: '/tmp/operator', env: {} }

it('selects Claude without HTTP credentials and resolves only App authority', () => {
  const result = parseConfig(input({ _tag: 'Claude' }), context)
  expect(result).toMatchObject({ _tag: 'Ok', value: { provider: { _tag: 'Claude', model: 'claude-opus-5-5', command: 'claude' } } })
  if (result._tag === 'Err')
    throw new Error(result.error.message)
  expect(resolveSecrets(result.value, { APP_KEY: 'synthetic-key' })).toEqual({ _tag: 'Ok', value: { privateKey: 'synthetic-key', webhookSecret: null, apiKey: null } })
})

it('requires an explicit provider selection in stored configuration', () => {
  expect(parseConfig(input({ baseUrl: 'https://example.test/v1', model: 'model', apiKeyEnv: 'MODEL_KEY' }), context)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', message: expect.stringContaining('_tag') } })
})

it.each([
  { _tag: 'Claude', apiKeyEnv: 'UNUSED_KEY' },
  { _tag: 'Claude', baseUrl: 'https://unused.test' },
  { _tag: 'Claude', command: 'claude\0secret' },
  { _tag: 'Claude', command: './claude' },
  { _tag: 'Claude', model: '--unsafe' },
  { _tag: 'Claude', maxInputBytes: 0 },
  { _tag: 'Unknown' },
  { _tag: { toString: null } },
])('rejects mixed or invalid provider settings: %s', (provider) => {
  expect(parseConfig(input(provider), context)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})

it('selects Claude during init without an HTTP model or endpoint', () => {
  expect(parseCliArguments(['init', '--repository', 'team/example', '--repository-id', '7', '--installation-id', '8', '--app-id', '123', '--provider', 'claude'])).toMatchObject({ _tag: 'Ok', value: { _tag: 'Init', provider: { _tag: 'Claude', model: 'claude-opus-5-5' } } })
})

it('rejects an HTTP endpoint when init selects Claude', () => {
  expect(parseCliArguments(['init', '--repository', 'team/example', '--repository-id', '7', '--installation-id', '8', '--app-id', '123', '--provider', 'claude', '--base-url', 'https://unused.test'])).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})
