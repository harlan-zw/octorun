import type { OperatorConfig } from '../src/config.ts'
import type { GitHubClient, PullRequestSnapshot } from '../src/github.ts'
import type { OctorunService } from '../src/service.ts'
import type { AgentProvider, AgentRequest } from '../src/types.ts'
import { createHmac } from 'node:crypto'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adversarialReviewPreset, changeSummaryPreset } from '../src/review.ts'
import { createOctorun, parseRepositoryWorkflows } from '../src/service.ts'
import { ok } from '../src/types.ts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const secret = 'a-long-webhook-secret-for-tests'
const now = new Date('2026-10-21T00:00:00Z')
const repo = { id: 10, fullName: 'acme/project', installationId: 20 }
const actor = { id: 30, login: 'alice', kind: 'User' as const }
const bot = { id: 90, login: 'octorun[bot]', kind: 'Bot' as const }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map(close => close()))
})

async function setup(options: { failProvider?: boolean, sourceText?: string, omitProviderKey?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-service-'))
  const config: OperatorConfig = { version: 1, stateDir, host: '127.0.0.1', port: 0, handle: 'octorun', github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'WEBHOOK_SECRET', apiUrl: 'https://api.github.com' }, provider: { _tag: 'OpenAICompatible', baseUrl: 'https://provider.example/v1', model: 'test-model', apiKeyEnv: 'API_KEY', timeoutMs: 1000, maxResponseBytes: 1024, maxInputCharacters: 100000 }, repositories: [{ ...repo, policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check'], maxConcurrency: 2 }, workflowSource: options.sourceText ? { _tag: 'Repository', path: '.github/octorun.yml' } : { _tag: 'Presets', presets: ['adversarial-review'] } }], pollIntervalMs: 0, limits: { bodyBytes: 1024 * 1024, requestsPerMinute: 100, concurrency: 2 } }
  let currentHead = head
  let draft = false
  let clockMs = now.getTime()
  let updatedAt = now.toISOString()
  let reads = 0
  let providerCalls = 0
  const providerRequests: AgentRequest[] = []
  let nextId = 100
  let permission: 'read' | 'write' = 'write'
  let permissionChecks = 0
  const comments: Record<string, unknown>[] = []
  const reviews: Record<string, unknown>[] = []
  const checkRuns: Record<string, unknown>[] = []
  const inputComments: Record<string, unknown>[] = []
  const snapshot = (): PullRequestSnapshot => ({ repository: repo, number: 1, headSha: currentHead, baseSha: base, title: 'Change input parser', body: '', author: actor, draft, state: 'open', changedFiles: 1, updatedAt, labels: [], headRepository: 'outside/fork' })
  const client: GitHubClient = {
    auth: { appId: 7, token: async () => ok({ token: 'fixture', expiresAt: new Date(now.getTime() + 3600000).toISOString(), installationId: 20 }), identity: async () => ok({ id: 7, slug: 'octorun' }), invalidate: () => {} },
    repository: async () => {
      reads++
      return ok({ ref: repo, defaultBranch: 'main', private: false, archived: false })
    },
    snapshot: async () => {
      reads++
      return ok(snapshot())
    },
    files: async () => ok([{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new', status: 'modified', truncated: false, additions: 1, deletions: 1 }]),
    permission: async () => {
      permissionChecks++
      return ok(permission)
    },
    readFile: async () => ok(null),
    readWorkflow: async () => ok({ sha: base, text: options.sourceText ?? null }),
    botIdentity: async () => ok(bot),
    async paginate(_repository, path) {
      if (path.includes('/pulls?'))
        return ok([{ number: 1 }])
      if (path.includes('/issues/comments?'))
        return ok(inputComments)
      if (path.includes('/issues/1/comments'))
        return ok(comments)
      if (path.includes('/pulls/1/reviews'))
        return ok(reviews)
      return ok([])
    },
    async request(_repository, pathAccess, path, request = {}) {
      const body = request.body as Record<string, unknown>
      if (path.includes('/check-runs?'))
        return ok({ check_runs: checkRuns })
      if (path.endsWith('/check-runs') && request.method === 'POST') {
        const value = { ...body, id: nextId++, app: { id: 7 } }
        checkRuns.push(value)
        return ok(value)
      }
      if (path.includes('/check-runs/') && request.method === 'PATCH') {
        const value = checkRuns.find(check => check.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return ok(value)
      }
      if (path.endsWith('/issues/1/comments') && request.method === 'POST') {
        const value = { id: nextId++, user: { id: bot.id }, body: body.body }
        comments.push(value)
        return ok(value)
      }
      if (path.includes('/issues/comments/') && request.method === 'PATCH') {
        const value = comments.find(comment => comment.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return ok(value)
      }
      if (path.endsWith('/pulls/1/reviews') && request.method === 'POST') {
        const value = { ...body, id: nextId++, user: { id: bot.id } }
        reviews.push(value)
        return ok(value)
      }
      return { _tag: 'Err', error: { _tag: 'Permanent', message: `Unexpected fixture route: ${pathAccess} ${path}.` } }
    },
  }
  const provider: AgentProvider = { id: 'test-provider', inputTokenOverhead: 256, async generate(request) {
    providerCalls++
    providerRequests.push(request)
    if (options.failProvider)
      return { _tag: 'Err', error: { _tag: 'Permanent', message: 'The provider rejected this request.' } }
    return ok({ text: request.messages[0]!.content.includes('release') ? 'Update the input parser.' : '{"findings":[]}', usage: { inputTokens: 5, outputTokens: 5, costUsd: null } })
  } }
  const create = async (): Promise<OctorunService> => {
    const created = await createOctorun({ config, env: { APP_KEY: 'fixture-private-key', ...(!options.omitProviderKey ? { API_KEY: 'fixture-api-key' } : {}), WEBHOOK_SECRET: secret }, now: () => new Date(clockMs), client, provider })
    if (created._tag === 'Err')
      throw new Error(created.error.message)
    return created.value
  }
  let service = await create()
  cleanup.push(async () => {
    await service.close()
    await rm(stateDir, { recursive: true, force: true })
  })
  const webhook = async (event: string, payload: unknown, deliveryId = 'delivery-1') => {
    const body = JSON.stringify(payload)
    return service.handleWebhook({ deliveryId, event, body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` })
  }
  return { config, client, comments, reviews, checkRuns, inputComments, snapshot, webhook, providerRequests, service: () => service, reads: () => reads, providerCalls: () => providerCalls, permissionChecks: () => permissionChecks, setDraft: (value: boolean, advanceMs = 1000) => {
    draft = value
    clockMs += advanceMs
    updatedAt = new Date(clockMs).toISOString()
  }, pullRequestWebhook: (action: string, deliveryId: string) => webhook('pull_request', { action, repository: { id: 10, full_name: repo.fullName }, installation: { id: 20 }, sender: { ...actor, type: 'User' }, pull_request: { number: 1, head: { sha: currentHead }, base: { sha: base }, updated_at: updatedAt } }, deliveryId), moveHead: (sha: string) => {
    currentHead = sha
  }, setPermission: (value: 'read' | 'write') => {
    permission = value
  }, setProviderInputTokenOverhead: (value: number) => {
    provider.inputTokenOverhead = value
  }, restart: async () => {
    await service.close()
    service = await create()
  } }
}

const issueComment = (body: string, id = 1) => ({ action: 'created', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, sender: { ...actor, type: 'User' }, issue: { number: 1, pull_request: {} }, comment: { id, body, user: { ...actor, type: 'User' }, created_at: now.toISOString(), updated_at: now.toISOString() } })

it('reports injected provider readiness without checking an unused Claude executable', async () => {
  const test = await setup({ omitProviderKey: true })
  test.config.provider = { _tag: 'Claude', command: '/missing/claude', model: 'test-model', timeoutMs: 1000, maxResponseBytes: 1024, maxInputBytes: 1024 }
  await test.restart()
  expect(await test.service().command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: true, provider: { kind: 'Injected', authentication: 'not-checked' } } })
  expect(test.providerCalls()).toBe(0)
})

it('keeps Claude readiness on the login environment selected when the controller starts', async () => {
  const test = await setup()
  const command = join(test.config.stateDir, 'claude.ts')
  await copyFile(new URL('./fixtures/claude-package.ts', import.meta.url), command)
  await chmod(command, 0o700)
  const env = { APP_KEY: 'synthetic-key', HOME: test.config.stateDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }
  const created = await createOctorun({ config: { ...test.config, stateDir: join(test.config.stateDir, 'builtin'), provider: { _tag: 'Claude', command, model: 'test-model', timeoutMs: 1000, maxResponseBytes: 1024, maxInputBytes: 1024 } }, env, client: test.client })
  if (created._tag === 'Err')
    throw new Error(created.error.message)
  cleanup.push(() => created.value.close())
  env.HOME = '/missing/controller/home'
  expect(await created.value.command('doctor', {})).toMatchObject({ _tag: 'Ok', value: { ready: true, provider: { authenticated: true } } })
})

const checkAction = (check: Record<string, unknown>, identifier: string) => ({ action: 'requested_action', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, sender: { ...actor, type: 'User' }, check_run: check, requested_action: { identifier } })

describe('trusted repository workflows', () => {
  it('rejects aliases and duplicate workflow IDs before admission', () => {
    expect(parseRepositoryWorkflows('version: 1\nworkflows: &tasks []\nother: *tasks')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    const workflow = { version: 1, id: 'custom', name: 'Custom', on: [], tasks: [{ id: 'one', uses: 'changes.classify', with: {} }], concurrency: { mode: 'replace', group: 'target' }, limits: { maxAttempts: 1, timeoutMs: 1000, maxTokens: 100, maxCostUsd: null, maxDurationMs: 1000 } }
    expect(parseRepositoryWorkflows(JSON.stringify({ version: 1, workflows: [workflow, workflow] }))).toMatchObject({ _tag: 'Err', error: { message: 'Repository workflow ID is repeated: custom.' } })
  })
})

describe('reactive service composition', () => {
  it('uses an injected provider without requiring the unused HTTP provider key', async () => {
    const test = await setup({ omitProviderKey: true })
    const result = await test.service().run({ repository: repo.fullName, number: 1, requestId: 'injected-provider' })
    expect(result._tag).toBe('Ok')
    await test.service().settle()
    expect(test.service().runner.runs()[0]?.state._tag).toBe('Succeeded')
    expect(test.providerCalls()).toBeGreaterThan(0)
  })

  it('requires the HTTP provider key when no provider is injected', async () => {
    const test = await setup()
    const result = await createOctorun({ config: test.config, env: { APP_KEY: 'fixture-private-key' }, client: test.client })
    expect(result).toEqual({ _tag: 'Err', error: { _tag: 'Configuration', message: 'Set API_KEY before starting Octorun.' } })
  })

  it('previews a selected workflow against its live pinned target without executing tasks or publishing', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['adversarial-review', 'change-summary'] }
    const planned = await test.service().command('plan', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    expect(planned).toMatchObject({ _tag: 'Ok', value: {
      target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base },
      workflow: { id: 'change-summary' },
      tasks: [{ id: 'classify', uses: 'changes.classify' }, { id: 'summarize', uses: 'changes.summarize' }, { id: 'comment', uses: 'changes.comment' }],
      selection: { _tag: 'Manual' },
      policy: { enabled: true },
      limits: { maxCostUsd: null },
    } })
    expect(test.service().runner.runs()).toEqual([])
    expect(test.providerCalls()).toBe(0)
    expect(test.comments).toEqual([])
    expect(test.reviews).toEqual([])
    expect(test.checkRuns).toEqual([])
  })

  it('rejects an unavailable workflow, missing pull request, or denied task capability during preview', async () => {
    const test = await setup()
    expect(await test.service().command('plan', { repository: repo.fullName, number: 1, workflow: 'missing' })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    test.config.repositories[0]!.policy.capabilities = ['repository:read']
    expect(await test.service().command('plan', { repository: repo.fullName, number: 1 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    test.client.snapshot = async () => ({ _tag: 'Err', error: { _tag: 'Permanent', message: 'The pull request does not exist.' } })
    expect(await test.service().command('plan', { repository: repo.fullName, number: 404 })).toMatchObject({ _tag: 'Err', error: { message: 'The pull request does not exist.' } })
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs()).toEqual([])
  })

  it('resumes queued work after a drain persists through restart', async () => {
    const test = await setup()
    expect(await test.service().command('drain', {})).toMatchObject({ _tag: 'Ok' })
    const queued = await test.service().run({ repository: repo.fullName, number: 1, requestId: 'paused-run' })
    expect(queued).toMatchObject({ _tag: 'Ok', value: { state: 'Queued' } })
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().store.operatorPaused()).toBe(true)
    await test.service().command('resume', { repository: repo.fullName })
    expect(test.service().store.operatorPaused()).toBe(true)
    expect(test.providerCalls()).toBe(0)
    expect(await test.service().command('resume', {})).toMatchObject({ _tag: 'Ok', value: { scope: 'controller', paused: false } })
    expect(test.service().store.operatorPaused()).toBe(false)
    expect(test.service().runner.runs().find(run => run.definition.id === 'adversarial-review')?.state._tag).toBe('Succeeded')
    expect(test.providerCalls()).toBe(2)
  })

  it('persists a signed webhook before network reads and resumes it after restart', async () => {
    const test = await setup()
    expect(await test.webhook('issue_comment', issueComment('@octorun status'))).toMatchObject({ _tag: 'Ok', value: { accepted: true } })
    expect(test.reads()).toBe(0)
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs().map(run => run.state)).toEqual([{ _tag: 'Succeeded' }])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No workflow run exists')])
    expect(test.service().store.pendingDeliveries()).toEqual([])
  })

  it('runs the full review and closes its native check after manual ingress', async () => {
    const test = await setup()
    const result = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    expect(result).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded', targetKey: '10:pull_request:1' } })
    expect(test.providerCalls()).toBe(2)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No actionable findings')])
    expect(test.checkRuns.map(check => ({ status: check.status, conclusion: check.conclusion }))).toEqual([{ status: 'completed', conclusion: 'success' }])
  })

  it('reuses persisted complete coverage for a custom workflow after restart', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Inline', definitions: [{ ...adversarialReviewPreset(), id: 'custom-review' }] }
    const files = [
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new', status: 'modified', truncated: false, additions: 1, deletions: 1 },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n-before\n+after', status: 'modified', truncated: false, additions: 1, deletions: 1 },
    ]
    test.client.files = async () => ok(files)
    const request = test.client.request
    test.client.request = async (repository, access, path, options) => path.includes('/compare/')
      ? ok({ status: 'ahead', base_commit: { sha: head }, merge_base_commit: { sha: head }, files: [{ filename: 'src/b.ts', status: 'modified' }] })
      : request(repository, access, path, options)
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'custom-review', requestId: 'complete-before-restart' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    await test.restart()
    test.moveHead('c'.repeat(40))
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'custom-review', requestId: 'incremental-after-restart' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    expect(test.providerRequests.slice(2).map(request => JSON.parse(request.messages[1]!.content).files.map((file: { path: string }) => file.path))).toEqual([['src/b.ts'], ['src/b.ts']])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining(`Incremental review of 1 changed path since \`${head.slice(0, 12)}\``)])
  })

  it('does not reuse coverage after the provider binding changes', async () => {
    const test = await setup()
    await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'old-provider-binding' })
    test.config.provider.model = 'different-model'
    await test.restart()
    test.moveHead('c'.repeat(40))
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'new-provider-binding' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    expect(test.providerRequests.slice(2).map(request => JSON.parse(request.messages[1]!.content).scope)).toEqual([{ _tag: 'Full', reason: 'initial' }, { _tag: 'Full', reason: 'initial' }])
  })

  it('falls back to a full review after the newest review has incomplete coverage', async () => {
    const test = await setup()
    const request = test.client.request
    let comparisonBase = head
    test.client.request = async (repository, access, path, options) => path.includes('/compare/')
      ? ok({ status: 'ahead', base_commit: { sha: comparisonBase }, merge_base_commit: { sha: comparisonBase }, files: [{ filename: 'src/a.ts', status: 'modified' }] })
      : request(repository, access, path, options)
    await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'first-complete' })
    const files = test.client.files
    test.client.files = async () => ok([{ path: 'src/a.ts', patch: null, status: 'modified', truncated: true, additions: 1, deletions: 1 }])
    test.moveHead('c'.repeat(40))
    await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'second-incomplete' })
    comparisonBase = 'c'.repeat(40)
    test.client.files = files
    test.moveHead('d'.repeat(40))
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'third-must-be-full' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    expect(test.providerRequests.slice(2).map(request => JSON.parse(request.messages[1]!.content).scope)).toEqual([{ _tag: 'Full', reason: 'incomplete-previous-review' }, { _tag: 'Full', reason: 'incomplete-previous-review' }])
  })

  it('binds a manual request ID to its first accepted head', async () => {
    const test = await setup()
    const first = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    test.moveHead('c'.repeat(40))
    const repeated = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    expect(repeated).toEqual(first)
    expect(test.providerCalls()).toBe(2)
  })

  it('refuses a changed provider configuration when recovering accepted work', async () => {
    const test = await setup()
    expect(await test.service().run({ repository: repo.fullName, number: 1, requestId: 'pinned-provider' })).toMatchObject({ _tag: 'Ok', value: { state: 'Queued' } })
    test.config.provider.model = 'different-model'
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs()).toMatchObject([{ state: { _tag: 'Failed', error: { _tag: 'Configuration' } } }])
  })

  it('refuses a changed provider token allowance when recovering accepted work', async () => {
    const test = await setup()
    expect(await test.service().run({ repository: repo.fullName, number: 1, requestId: 'pinned-provider-overhead' })).toMatchObject({ _tag: 'Ok', value: { state: 'Queued' } })
    test.setProviderInputTokenOverhead(2048)
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs()).toMatchObject([{ state: { _tag: 'Failed', error: { _tag: 'Configuration' } } }])
  })

  it('keeps provider failure separate from a clean review', async () => {
    const test = await setup({ failProvider: true })
    expect(await test.service().command('run', { repository: repo.fullName, number: 1 })).toMatchObject({ _tag: 'Ok', value: { state: 'Failed' } })
    expect(test.comments.some(comment => String(comment.body).includes('No actionable findings'))).toBe(false)
    expect(test.checkRuns.map(check => check.conclusion)).toEqual(['failure'])
  })

  it('runs the change-summary chain without a review task', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    expect(test.providerCalls()).toBe(1)
    expect(test.reviews).toEqual([])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Update the input parser.')])
  })

  it('routes help and unknown commands without an agent turn', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun help'), 'help-one')
    await test.webhook('issue_comment', issueComment('@octorun repair everything now', 2), 'unknown-two')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual(expect.arrayContaining([expect.stringContaining('Use @octorun help'), expect.stringContaining('Unknown command')]))
  })

  it('denies model spending by a reader and allows information commands', async () => {
    const test = await setup()
    test.setPermission('read')
    await test.webhook('issue_comment', issueComment('@octorun review'), 'denied-review')
    await test.webhook('issue_comment', issueComment('@octorun status', 2), 'allowed-status')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No workflow run exists')])
  })

  it('acknowledges pause and still runs an explicit review request', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun pause'), 'pause-one')
    await test.service().settle()
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Automatic workflow runs are paused')])
    await test.webhook('issue_comment', issueComment('@octorun review', 2), 'review-two')
    await test.service().settle()
    expect(test.providerCalls()).toBe(2)
    expect(test.service().runner.runs().filter(run => run.definition.id === 'adversarial-review').map(run => run.state._tag)).toEqual(['Succeeded'])
  })

  it('revokes paid execution when the command actor loses write access', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun review'), 'revoked-one')
    await test.service().tick()
    test.setPermission('read')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs().map(run => run.state)).toEqual([{ _tag: 'Failed', error: { _tag: 'Authorization', message: 'Repository policy does not permit this user to start paid work.' } }])
    expect(test.checkRuns.map(check => check.conclusion)).toEqual(['action_required'])
  })

  it('processes explicit poll backfill and never repeats the same observed head', async () => {
    const test = await setup()
    expect(await test.service().command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok', value: { accepted: 1 } })
    expect(test.providerCalls()).toBe(2)
    expect(await test.service().command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok', value: { accepted: 0 } })
    expect(test.providerCalls()).toBe(2)
  })

  it('advances polling after ready, draft, and ready without blocking later comments', async () => {
    const test = await setup()
    expect(await test.service().command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok' })
    test.setDraft(true)
    expect(await test.service().command('poll', {})).toMatchObject({ _tag: 'Ok' })
    test.setDraft(false)
    test.inputComments.push({ id: 999, body: '@octorun status', user: { ...actor, type: 'User' }, issue_url: 'https://api.github.com/repos/acme/project/issues/1', created_at: test.snapshot().updatedAt, updated_at: test.snapshot().updatedAt })
    expect(await test.service().command('poll', {})).toMatchObject({ _tag: 'Ok', value: { accepted: 2 } })
    expect(await test.service().command('poll', {})).toMatchObject({ _tag: 'Ok', value: { accepted: 0 } })
    expect(test.service().runner.runs().find(run => run.definition.id === 'command-response')?.state._tag).toBe('Succeeded')
  })

  it.each(['poll-first', 'webhook-first'])('resumes a held review once after restart and coalesces %s observations', async (order) => {
    const test = await setup()
    expect(await test.service().poll({ backfill: true })).toMatchObject({ _tag: 'Ok' })
    test.setDraft(true, 0)
    expect(await test.service().poll()).toMatchObject({ _tag: 'Ok' })
    expect(test.service().runner.runs().map(run => run.state._tag)).toEqual(['Cancelled'])
    await test.restart()
    test.setDraft(false, 0)
    if (order === 'poll-first') {
      expect(await test.service().poll()).toMatchObject({ _tag: 'Ok' })
      await test.pullRequestWebhook('ready_for_review', 'ready-webhook')
      await test.service().settle()
    }
    else {
      await test.pullRequestWebhook('ready_for_review', 'ready-webhook')
      await test.service().settle()
      expect(await test.service().poll()).toMatchObject({ _tag: 'Ok' })
      await test.service().settle()
    }
    expect(test.service().runner.runs().map(run => run.state._tag)).toEqual(['Cancelled', 'Succeeded'])
    expect(test.providerCalls()).toBe(2)
  })

  it('reruns the recorded custom workflow once for one native action delivery', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Inline', definitions: [{ ...changeSummaryPreset(), id: 'custom-summary', name: 'Custom summary' }] }
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'custom-summary' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    const payload = checkAction(test.checkRuns[0]!, 'rerun')
    await test.webhook('check_run', payload, 'rerun-one')
    await test.webhook('check_run', payload, 'rerun-one')
    await test.service().settle()
    expect(test.service().runner.runs().map(run => ({ workflow: run.definition.id, state: run.state._tag }))).toEqual([{ workflow: 'custom-summary', state: 'Succeeded' }, { workflow: 'custom-summary', state: 'Succeeded' }])
    expect(test.providerCalls()).toBe(2)
  })

  it('cancels only the workflow run recorded by the native check', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['adversarial-review', 'change-summary'] }
    const review = await test.service().run({ repository: repo.fullName, number: 1, workflow: 'adversarial-review' })
    const summary = await test.service().run({ repository: repo.fullName, number: 1, workflow: 'change-summary' })
    if (review._tag !== 'Ok' || summary._tag !== 'Ok')
      throw new Error('Expected both workflows to be accepted.')
    await test.service().tick()
    const runId = (review.value as { runId: string }).runId
    const check = test.checkRuns.find(value => value.external_id === `octorun:${runId}`)!
    await test.webhook('check_run', checkAction(check, 'cancel'), 'cancel-one')
    await test.service().settle()
    expect(test.service().runner.inspect(runId)?.state._tag).toBe('Cancelled')
    expect(test.service().runner.inspect((summary.value as { runId: string }).runId)?.state._tag).toBe('Succeeded')
    expect(test.providerCalls()).toBe(1)
  })

  it('denies native actions after the actor loses repository write access', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    test.setPermission('read')
    await test.webhook('check_run', checkAction(test.checkRuns[0]!, 'rerun'), 'denied-rerun')
    await test.service().settle()
    expect(test.providerCalls()).toBe(1)
    expect(test.service().runner.runs().map(run => run.definition.id)).toEqual(['change-summary'])
    expect(test.permissionChecks()).toBe(1)
  })

  it('ignores foreign App checks and rejects an unrecorded check ID', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    const check = test.checkRuns[0]!
    await test.webhook('check_run', checkAction({ ...check, app: { id: 8 } }, 'rerun'), 'foreign-app')
    await test.webhook('check_run', checkAction({ ...check, id: 999999 }, 'rerun'), 'unrecorded-id')
    await test.service().settle()
    expect(test.providerCalls()).toBe(1)
    expect(test.service().runner.runs().map(run => run.definition.id)).toEqual(['change-summary'])
    expect(test.permissionChecks()).toBe(0)
  })
})
