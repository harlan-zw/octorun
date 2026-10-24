import type { Capability, GitHubAccess, GitHubAppAuth, OperatorConfig, TaskType, WorkflowDefinition } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { adversarialReviewPreset, changeSummaryPreset, createGitHubClient, createOctorun, err, ok, parseJsonValue } from '../src/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map(close => close()))
})

async function setup(options: { denied?: GitHubAccess, credentialInstallationId?: number, capabilities?: Capability[], workflows?: WorkflowDefinition[], taskTypes?: TaskType[] } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-doctor-'))
  const repository = { id: 10, installationId: 20, fullName: 'acme/project' }
  const requested: GitHubAccess[] = []
  let providerCalls = 0
  let remoteRequests = 0
  const auth: GitHubAppAuth = {
    appId: 7,
    identity: async () => ok({ id: 7, slug: 'octorun' }),
    invalidate: () => {},
    async token(_repository, access) {
      requested.push(access)
      return access === options.denied
        ? err({ _tag: 'Authorization', message: `The GitHub App lacks ${access} permission.` })
        : ok({ token: 'fixture', installationId: options.credentialInstallationId ?? repository.installationId, expiresAt: '2100-01-01T00:00:00Z' })
    },
  }
  const client = {
    ...createGitHubClient({ auth, fetch: async () => {
      remoteRequests++
      throw new Error('Doctor must not publish GitHub output.')
    } }),
    repository: async () => ok({ ref: repository, defaultBranch: 'main', private: false, archived: false }),
  }
  const config: OperatorConfig = {
    version: 1,
    stateDir,
    host: '127.0.0.1',
    port: 0,
    handle: 'octorun',
    github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'WEBHOOK_SECRET', apiUrl: 'https://api.github.com' },
    provider: { _tag: 'OpenAICompatible', model: 'fixture', baseUrl: 'https://provider.example/v1', apiKeyEnv: 'API_KEY', timeoutMs: 1000, maxResponseBytes: 1024, maxInputCharacters: 4096 },
    repositories: [{ ...repository, policy: { enabled: true, capabilities: options.capabilities ?? ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check'], maxConcurrency: 1 }, workflowSource: { _tag: 'Inline', definitions: options.workflows ?? [adversarialReviewPreset()] } }],
    pollIntervalMs: 0,
    limits: { bodyBytes: 1048576, requestsPerMinute: 100, concurrency: 1 },
  }
  const created = await createOctorun({ config, env: { APP_KEY: 'fixture' }, client, ...(options.taskTypes ? { taskTypes: options.taskTypes } : {}), provider: { id: 'fixture', generate: async () => {
    providerCalls++
    return err({ _tag: 'Permanent', message: 'Doctor must not start a model turn.' })
  } } })
  if (created._tag === 'Err')
    throw new Error(created.error.message)
  cleanup.push(async () => {
    await created.value.close()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { service: created.value, requested, providerCalls: () => providerCalls, remoteRequests: () => remoteRequests }
}

it.each(['comment', 'review', 'check'] as const)('reports missing %s permission before any paid work', async (denied) => {
  const fixture = await setup({ denied })
  expect(await fixture.service.command('doctor', {})).toMatchObject({
    _tag: 'Ok',
    value: { ready: false, repositories: [{ repository: 'acme/project', ok: false, error: `The GitHub App lacks ${denied} permission.` }] },
  })
  expect(fixture.requested).toContain(denied)
  expect(fixture.providerCalls()).toBe(0)
  expect(fixture.remoteRequests()).toBe(0)
})

it('checks only the publication permissions used by a summary without check runs', async () => {
  const fixture = await setup({ denied: 'review', workflows: [changeSummaryPreset()], capabilities: ['repository:read', 'agent:invoke', 'github:comment'] })
  expect(await fixture.service.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: true } })
  expect(fixture.requested).toEqual(['comment'])
  expect(fixture.providerCalls()).toBe(0)
  expect(fixture.remoteRequests()).toBe(0)
})

it('rejects a write credential from another installation', async () => {
  const fixture = await setup({ credentialInstallationId: 21 })
  expect(await fixture.service.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: false, repositories: [{ ok: false, error: 'The installed repository does not match the operator configuration.' }] } })
  expect(fixture.providerCalls()).toBe(0)
  expect(fixture.remoteRequests()).toBe(0)
})

it('reports unusable workflow capabilities before requesting write tokens', async () => {
  const fixture = await setup({ capabilities: ['repository:read', 'agent:invoke', 'github:comment'] })
  expect(await fixture.service.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: false, repositories: [{ ok: false, error: expect.stringContaining('required capabilities') }] } })
  expect(fixture.requested).toEqual([])
  expect(fixture.providerCalls()).toBe(0)
})

it('reports an unregistered task before requesting write tokens', async () => {
  const workflow = changeSummaryPreset()
  const fixture = await setup({ workflows: [{ ...workflow, tasks: [{ id: 'read', uses: 'missing.read', with: {} }] }] })
  expect(await fixture.service.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: false, repositories: [{ ok: false, error: 'Task type missing.read is not registered.' }] } })
  expect(fixture.requested).toEqual([])
})

it('needs no write grants for a workflow with only repository reads', async () => {
  const read: TaskType = { id: 'fixture.read', version: '1', capabilities: ['repository:read'], input: parseJsonValue, output: parseJsonValue, execute: async () => ({ _tag: 'Succeeded', output: {} }) }
  const workflow = changeSummaryPreset()
  const fixture = await setup({ workflows: [{ ...workflow, tasks: [{ id: 'read', uses: read.id, with: {} }] }], taskTypes: [read], capabilities: ['repository:read'] })
  expect(await fixture.service.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: true } })
  expect(fixture.requested).toEqual([])
  expect(fixture.providerCalls()).toBe(0)
  expect(fixture.remoteRequests()).toBe(0)
})
