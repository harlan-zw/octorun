import type { OctorunService, OperatorConfig } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHubClient, createOctorun, ok } from '../src/index.ts'

const cleanup: (() => Promise<void>)[] = []
const intervalMs = 60_000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse())
    await close()
  vi.useRealTimers()
})

async function setup(options: { respond: (attempt: number) => Response | Promise<Response>, pollIntervalMs?: number }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-polling-'))
  const requests: number[] = []
  const repository = { id: 10, fullName: 'acme/project', installationId: 20 }
  const config: OperatorConfig = {
    version: 1,
    stateDir,
    host: '127.0.0.1',
    port: 0,
    handle: 'octorun',
    github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'WEBHOOK_SECRET', apiUrl: 'https://api.github.com' },
    provider: { _tag: 'OpenAICompatible', baseUrl: 'https://provider.invalid/v1', model: 'fixture', apiKeyEnv: 'API_KEY', timeoutMs: 1000, maxResponseBytes: 1024, maxInputCharacters: 10000 },
    repositories: [{ ...repository, policy: { enabled: true, capabilities: ['repository:read'], maxConcurrency: 1 }, workflowSource: { _tag: 'Presets', presets: ['change-summary'] } }],
    pollIntervalMs: options.pollIntervalMs ?? intervalMs,
    limits: { bodyBytes: 1024, requestsPerMinute: 100, concurrency: 1 },
  }
  const client = createGitHubClient({
    auth: {
      appId: 7,
      token: async () => ok({ token: 'fixture', expiresAt: new Date(Date.now() + 3600000).toISOString(), installationId: 20 }),
      identity: async () => ok({ id: 7, slug: 'octorun' }),
      invalidate: () => {},
    },
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/repos/acme/project') {
        requests.push(Date.now())
        return options.respond(requests.length)
      }
      if (url.pathname.startsWith('/users/'))
        return Response.json({ id: 90, login: 'octorun[bot]', type: 'Bot' })
      return Response.json([])
    },
  })
  const created = await createOctorun({
    config,
    client,
    now: () => new Date(),
    env: { APP_KEY: 'fixture' },
    provider: { id: 'fixture', generate: async () => { throw new Error('Polling must not invoke the agent provider.') } },
  })
  if (created._tag === 'Err')
    throw new Error(created.error.message)
  const service: OctorunService = created.value
  cleanup.push(async () => {
    const closing = service.close()
    await vi.runOnlyPendingTimersAsync()
    await closing
    await rm(stateDir, { recursive: true, force: true })
  })
  return { service, requests }
}

const unavailable = () => new Response(null, { status: 503 })
const available = () => Response.json({ id: 10, full_name: 'acme/project', default_branch: 'main' })

describe('scheduled GitHub polling', () => {
  it('waits for the configured interval after a failed poll, then recovers', async () => {
    const test = await setup({ respond: attempt => attempt === 1 ? unavailable() : available() })
    await test.service.start()
    await vi.advanceTimersByTimeAsync(intervalMs - 1)
    expect(test.requests).toEqual([Date.parse('2026-10-24T00:00:00Z')])
    await vi.advanceTimersByTimeAsync(1)
    expect(test.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(intervalMs - 1)
    expect(test.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.requests).toHaveLength(3)
  })

  it('honors GitHub retry-after when it exceeds the configured interval', async () => {
    const test = await setup({ respond: () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) })
    await test.service.start()
    await vi.advanceTimersByTimeAsync(120_000 - 1)
    expect(test.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.requests).toHaveLength(2)
  })

  it('allows an immediate manual poll and schedules the next automatic attempt from it', async () => {
    const test = await setup({ respond: unavailable })
    await test.service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await test.service.poll()).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
    expect(test.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(intervalMs - 1)
    expect(test.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.requests).toHaveLength(3)
  })

  it('starts the failure interval after the request finishes', async () => {
    const test = await setup({ respond: async () => {
      await new Promise(resolve => setTimeout(resolve, 5000))
      return unavailable()
    } })
    await test.service.start()
    await vi.advanceTimersByTimeAsync(5000 + intervalMs - 1)
    expect(test.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
  })

  it('keeps automatic polling disabled while allowing manual polls', async () => {
    const test = await setup({ respond: available, pollIntervalMs: 0 })
    await test.service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(test.requests).toEqual([])
    expect(await test.service.poll()).toEqual(ok({ accepted: 0 }))
    expect(test.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(test.requests).toHaveLength(1)
  })
})
