import { generateKeyPairSync } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initConfig, readConfig } from '../src/config.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'octorun-discovery-'))
  roots.push(root)
  const path = join(root, 'config.yaml')
  const requests: { path: string, method: string, body: unknown }[] = []
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const route = new URL(String(input)).pathname
    requests.push({ path: route, method: options?.method ?? 'GET', body: typeof options?.body === 'string' ? JSON.parse(options.body) as unknown : null })
    const result = route === '/app'
      ? { id: 123, slug: 'example-agent' }
      : route === '/repos/team/example/installation'
        ? { id: 8 }
        : route === '/app/installations/8/access_tokens'
          ? { token: 'synthetic-token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', checks: 'read' }, repositories: [{ id: 7, full_name: 'team/example' }] }
          : route === '/repos/team/example'
            ? { id: 7, full_name: 'team/example', default_branch: 'main', archived: false, private: false }
            : null
    return new Response(JSON.stringify(result ?? { message: 'Unexpected route' }), { status: result ? 200 : 404 })
  }
  const options = { path, repository: 'team/example', identity: { _tag: 'Discover' as const }, appId: '123', provider: { _tag: 'Claude' as const, model: 'claude-opus-5-5' } }
  return { root, path, requests, fetch, options }
}

it('creates private configuration using authenticated repository and installation IDs', async () => {
  const fixture = await setup()
  expect(await initConfig(fixture.options, { env: { OCTORUN_GITHUB_PRIVATE_KEY: privateKey }, fetch: fixture.fetch })).toEqual({ _tag: 'Ok', value: { path: fixture.path } })
  const loaded = await readConfig({ path: fixture.path, home: fixture.root, env: {} })
  expect(loaded).toMatchObject({ _tag: 'Ok', value: { repositories: [{ id: 7, fullName: 'team/example', installationId: 8 }] } })
  expect(fixture.requests).toEqual([
    { path: '/app', method: 'GET', body: null },
    { path: '/repos/team/example/installation', method: 'GET', body: null },
    { path: '/app/installations/8/access_tokens', method: 'POST', body: { repositories: ['example'], permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', checks: 'read' } } },
    { path: '/repos/team/example', method: 'GET', body: null },
  ])
  expect(await readFile(fixture.path, 'utf8')).not.toContain(privateKey)
})

it('explains missing App authentication before making a request or creating a configuration', async () => {
  const fixture = await setup()
  expect(await initConfig(fixture.options, { env: {}, fetch: fixture.fetch })).toEqual({ _tag: 'Err', error: { _tag: 'Configuration', message: 'Set OCTORUN_GITHUB_PRIVATE_KEY before discovering repository IDs. For offline setup, provide both numeric IDs.' } })
  expect(fixture.requests).toEqual([])
  await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves GitHub access failures and does not write guessed repository IDs', async () => {
  const fixture = await setup()
  const denied: typeof globalThis.fetch = async () => new Response('{"message":"denied"}', { status: 403 })
  expect(await initConfig(fixture.options, { env: { OCTORUN_GITHUB_PRIVATE_KEY: privateKey }, fetch: denied })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization', message: 'GitHub returned HTTP 403.' } })
  await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses to replace an existing configuration before discovery', async () => {
  const fixture = await setup()
  await writeFile(fixture.path, 'existing configuration')
  expect(await initConfig(fixture.options, { env: {}, fetch: fixture.fetch })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', message: 'Configuration already exists. Choose another --output path.' } })
  expect(fixture.requests).toEqual([])
  expect(await readFile(fixture.path, 'utf8')).toBe('existing configuration')
})

it('rejects an invalid private key without exposing its value', async () => {
  const fixture = await setup()
  const result = await initConfig(fixture.options, { env: { OCTORUN_GITHUB_PRIVATE_KEY: 'invalid-private-secret' }, fetch: fixture.fetch })
  expect(result).toEqual({ _tag: 'Err', error: { _tag: 'Configuration', message: 'GitHub App authentication failed. Check --app-id and OCTORUN_GITHUB_PRIVATE_KEY.' } })
  expect(fixture.requests).toEqual([])
  await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a mismatched App identity before requesting repository access', async () => {
  const fixture = await setup()
  const fetch: typeof globalThis.fetch = async input => new Response(JSON.stringify(new URL(String(input)).pathname === '/app' ? { id: 456, slug: 'another-app' } : {}))
  expect(await initConfig(fixture.options, { env: { OCTORUN_GITHUB_PRIVATE_KEY: privateKey }, fetch })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization', message: 'GitHub App identity does not match the configured App.' } })
  await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects malformed setup before requesting repository access', async () => {
  const fixture = await setup()
  expect(await initConfig({ ...fixture.options, repository: '../another-repo' }, { env: { OCTORUN_GITHUB_PRIVATE_KEY: privateKey }, fetch: fixture.fetch })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  expect(fixture.requests).toEqual([])
  await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
