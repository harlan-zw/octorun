import type { AgentProvider, GitHubClient, OctorunService, OperatorConfig, PullRequestSnapshot, Result, RunRecord, TaskType } from '../src/index.ts'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adversarialReviewPreset, createOctorun, err, findingMarker, ok, publicationMarker } from '../src/index.ts'

const repository = { id: 10, fullName: 'acme/project', installationId: 20 }
const user = { id: 30, login: 'alice', kind: 'User' as const }
const bot = { id: 90, login: 'octorun[bot]', kind: 'Bot' as const }
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const now = new Date('2026-10-22T06:00:00Z')
const secret = 'a-long-webhook-secret-for-tests'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map(close => close()))
})

async function setup(options: { ownsFinding?: boolean, permission?: 'read' | 'write', webhook?: boolean, holdProvider?: boolean, authorizeRun?: (run: RunRecord) => Promise<Result<void>>, execute?: TaskType['execute'] } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-reactivity-'))
  let open = true
  let draft = false
  let archived = false
  let providerCalls = 0
  let abortedCalls = 0
  let clockMs = now.getTime()
  let nextId = 100
  const comments: Record<string, unknown>[] = []
  const replies: Record<string, unknown>[] = []
  const checks: Record<string, unknown>[] = []
  const root = {
    id: 50,
    user: { id: options.ownsFinding === false ? 91 : bot.id },
    commit_id: head,
    path: 'src/a.ts',
    line: 1,
    pull_request_url: 'https://api.github.com/repos/acme/project/pulls/1',
    body: `A concrete finding.\n\n${findingMarker('finding-one')}\n${publicationMarker('publication-one')}`,
  }
  const snapshot = (): PullRequestSnapshot => ({ repository, number: 1, headSha: head, baseSha: base, title: 'Change parser', body: '', author: user, draft, state: open ? 'open' : 'closed', changedFiles: 1, updatedAt: now.toISOString(), labels: [], headRepository: repository.fullName })
  const client: GitHubClient = {
    auth: { appId: 7, token: async () => ok({ token: 'fixture', expiresAt: '2026-10-23T00:00:00Z', installationId: 20 }), identity: async () => ok({ id: 7, slug: 'octorun' }), invalidate: () => {} },
    repository: async () => ok({ ref: repository, defaultBranch: 'main', private: false, archived }),
    snapshot: async () => ok(snapshot()),
    files: async () => ok([{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new', status: 'modified', truncated: false, additions: 1, deletions: 1 }]),
    permission: async () => ok(options.permission ?? 'write'),
    readFile: async () => ok(null),
    readWorkflow: async () => ok({ sha: base, text: null }),
    botIdentity: async () => ok(bot),
    async paginate(_repository, path) {
      if (path.includes('/pulls?'))
        return ok(open ? [{ number: 1 }] : [])
      if (path.includes('/issues/comments?') || path.includes('/pulls/comments?'))
        return ok([])
      if (path.endsWith('/pulls/1/comments'))
        return ok([root, ...replies])
      if (path.endsWith('/issues/1/comments'))
        return ok(comments)
      if (path.endsWith('/pulls/1/reviews'))
        return ok([])
      throw new Error(`Unexpected fixture listing: ${path}.`)
    },
    async request(_repository, _access, path, request = {}) {
      const body = request.body as Record<string, unknown>
      if (path.endsWith('/pulls/comments/50'))
        return ok(root)
      if (path.includes('/check-runs?'))
        return ok({ check_runs: checks })
      if (path.endsWith('/check-runs') && request.method === 'POST') {
        const record = { ...body, id: nextId++, app: { id: 7 } }
        checks.push(record)
        return ok(record)
      }
      if (path.includes('/check-runs/') && request.method === 'PATCH') {
        const record = checks.find(value => value.id === Number(path.split('/').at(-1)))!
        Object.assign(record, body)
        return ok(record)
      }
      if (path.endsWith('/issues/1/comments') && request.method === 'POST') {
        const record = { ...body, id: nextId++, user: { id: bot.id } }
        comments.push(record)
        return ok(record)
      }
      if (path.includes('/issues/comments/') && request.method === 'PATCH') {
        const record = comments.find(value => value.id === Number(path.split('/').at(-1)))!
        Object.assign(record, body)
        return ok(record)
      }
      if (path.endsWith('/pulls/1/comments/50/replies') && request.method === 'POST') {
        const record = { ...body, id: nextId++, user: { id: bot.id }, in_reply_to_id: 50 }
        replies.push(record)
        return ok(record)
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${path}.`)
    },
  }
  const config: OperatorConfig = {
    version: 1,
    stateDir,
    host: '127.0.0.1',
    port: 0,
    handle: 'octorun',
    github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'WEBHOOK_SECRET', apiUrl: 'https://api.github.com' },
    provider: { _tag: 'OpenAICompatible', baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKeyEnv: 'API_KEY', timeoutMs: 1000, maxResponseBytes: 10000, maxInputCharacters: 100000 },
    repositories: [{ ...repository, policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check'], maxConcurrency: 2 }, workflowSource: { _tag: 'Presets', presets: ['adversarial-review'] } }],
    pollIntervalMs: 0,
    limits: { bodyBytes: 1024 * 1024, requestsPerMinute: 100, concurrency: 2 },
  }
  const provider: AgentProvider = {
    id: 'fixture',
    async generate(request) {
      providerCalls++
      if (options.holdProvider) {
        return new Promise((resolve) => {
          request.signal.addEventListener('abort', () => {
            abortedCalls++
            resolve(err({ _tag: 'Permanent', message: 'The provider turn was cancelled.' }))
          }, { once: true })
        })
      }
      return ok({ text: request.messages[0]!.content.includes('Review as a ') ? '{"findings":[]}' : 'The finding applies to the changed parser.', usage: { inputTokens: 5, outputTokens: 5, costUsd: null } })
    },
  }
  if (options.execute) {
    config.repositories[0]!.workflowSource = { _tag: 'Inline', definitions: [{ version: 1, id: 'authority-test', name: 'Authority test', on: [], tasks: [{ id: 'execute', uses: 'fixture.authority', with: {} }], concurrency: { mode: 'queue', group: 'target' }, limits: { maxAttempts: 1, timeoutMs: 1000, maxTokens: 1000, maxCostUsd: null, maxDurationMs: 60000 } }] }
  }
  const create = async (): Promise<OctorunService> => {
    const created = await createOctorun({ config, env: { APP_KEY: 'fixture', ...(options.webhook === false ? {} : { WEBHOOK_SECRET: secret }) }, now: () => new Date(clockMs), client, provider, ...(options.authorizeRun ? { authorizeRun: options.authorizeRun } : {}), ...(options.execute ? { taskTypes: [{ id: 'fixture.authority', version: '1', capabilities: ['agent:invoke', 'github:comment'], input: () => ok(null), output: () => ok(null), execute: options.execute }] } : {}) })
    if (created._tag === 'Err')
      throw new Error(created.error.message)
    return created.value
  }
  let service = await create()
  cleanup.push(async () => {
    await service.close()
    await rm(stateDir, { recursive: true })
  })
  return {
    config,
    comments,
    replies,
    checks,
    calls: () => providerCalls,
    aborted: () => abortedCalls,
    service: () => service,
    closePr: () => { open = false },
    setDraft: () => { draft = true },
    archive: () => { archived = true },
    advanceClock: () => { clockMs += 5000 },
    async restart() {
      await service.close()
      service = await create()
    },
    async comment(body: string, thread = true) {
      const payload = { action: 'created', repository: { id: repository.id, full_name: repository.fullName }, installation: { id: repository.installationId }, sender: { ...user, type: 'User' }, ...(thread ? { pull_request: { number: 1 } } : { issue: { number: 1, pull_request: {} } }), comment: { id: 60, ...(thread ? { in_reply_to_id: 50 } : {}), body, user: { ...user, type: 'User' }, created_at: now.toISOString(), updated_at: now.toISOString() } }
      const text = JSON.stringify(payload)
      return service.handleWebhook({ deliveryId: 'reactivity-delivery', event: thread ? 'pull_request_review_comment' : 'issue_comment', body: text, signature: `sha256=${createHmac('sha256', secret).update(text).digest('hex')}` })
    },
  }
}

function seedHistory(service: OctorunService, count = 1001, prefix = 'history'): RunRecord {
  const run: RunRecord = {
    id: 'history',
    event: { id: 'history', semanticKey: 'history', source: 'manual', name: 'pull_request', action: 'opened', repository, actor: null, target: { _tag: 'PullRequest', number: 2, headSha: head, baseSha: base }, occurredAt: now.toISOString(), receivedAt: now.toISOString(), data: null },
    definition: adversarialReviewPreset(),
    definitionDigest: 'history',
    configuration: { source: 'operator', sha: 'operator', digest: 'history' },
    policy: { enabled: true, capabilities: [], maxConcurrency: 1 },
    state: { _tag: 'Succeeded' },
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
  }
  service.store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = `${prefix}-${index}`
      service.store.createRun({ ...run, id }, { trigger: id, group: id })
    }
  })
  return run
}

describe('controls with retained history', () => {
  it.each(['command', 'closed', 'draft'])('cancels every active target run beyond the history and active page limits: %s', async (trigger) => {
    const test = await setup()
    const history = seedHistory(test.service())
    const activeIds = Array.from({ length: 1001 }, (_, index) => `active-${index}`)
    test.service().store.transaction(() => {
      for (const id of activeIds)
        test.service().store.createRun({ ...history, id, event: { ...history.event, target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base } }, state: { _tag: 'Queued' }, finishedAt: null }, { trigger: id, group: id })
    })
    if (trigger === 'command') {
      await test.comment('@octorun cancel', false)
    }
    else {
      test.service().store.setCursor('poll:10', { version: 1, since: now.toISOString(), pullRequests: { 1: 'previous-observation' }, comments: {} })
      if (trigger === 'closed')
        test.closePr()
      else
        test.setDraft()
      await test.service().poll()
    }
    await test.service().settle()
    expect(activeIds.every(id => test.service().runner.inspect(id)?.state._tag === 'Cancelled')).toBe(true)
    if (trigger === 'command')
      expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Cancelled 1001 active workflow runs')])
  })

  it('reports the latest target run when other targets fill the recent history', async () => {
    const test = await setup()
    const history = seedHistory(test.service())
    const id = 'latest-target-run'
    test.service().store.createRun({ ...history, id, event: { ...history.event, target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base } }, definition: { ...history.definition, name: 'Latest target review' } }, { trigger: id, group: id })
    seedHistory(test.service(), 1001, 'later-history')
    await test.comment('@octorun status', false)
    await test.service().settle()
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Latest target review: Succeeded.')])
  })

  it('uses the newest successful review beyond retained unrelated history', async () => {
    const test = await setup()
    const history = seedHistory(test.service())
    const id = 'newest-target-review'
    const previousHead = 'd'.repeat(40)
    test.service().store.createRun({ ...history, id, event: { ...history.event, target: { _tag: 'PullRequest', number: 1, headSha: previousHead, baseSha: base } }, tasks: [{ id: 'verify', definition: { id: 'verify', uses: 'review.verify', with: {} }, typeVersion: '1', state: { _tag: 'Succeeded' }, attempts: 1, failures: 0, fence: 1, output: { headSha: previousHead, baseSha: base, fingerprints: ['latest-finding'] }, usage: history.usage, unreservedUsage: history.usage, usageReservations: [], startedAt: history.startedAt, finishedAt: history.finishedAt }] }, { trigger: id, group: id })
    const started = await test.service().run({ repository: repository.fullName, number: 1 })
    if (started._tag === 'Err' || typeof started.value !== 'object' || started.value === null || Array.isArray(started.value) || typeof started.value.runId !== 'string')
      throw new Error('The review did not start.')
    await test.service().settle()
    const selection = test.service().runner.inspect(started.value.runId)?.tasks.find(task => task.definition.uses === 'review.snapshot')?.output
    expect(selection).toMatchObject({ previous: { headSha: previousHead, fingerprints: ['latest-finding'] } })
  })

  it('recovers the terminal check beyond the retained history limit', async () => {
    const test = await setup()
    const history = seedHistory(test.service())
    const id = 'unreported-terminal-run'
    test.service().store.createRun({ ...history, id, event: { ...history.event, target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base } }, policy: { ...history.policy, capabilities: ['github:check'] } }, { trigger: id, group: id })
    await test.restart()
    await test.service().settle()
    expect(test.checks).toEqual([expect.objectContaining({ external_id: `octorun:${id}`, status: 'completed', conclusion: 'success' })])
  })
})

describe('finding conversations', () => {
  it.each(['Why does this fail?', '@octorun Why does this fail?'])('answers an authorized finding question: %s', async (question) => {
    const test = await setup()
    expect((await test.comment(question))._tag).toBe('Ok')
    await test.service().settle()
    expect(test.calls()).toBe(1)
    expect(test.replies.map(reply => reply.body)).toEqual([expect.stringContaining('The finding applies')])
    expect(test.comments).toEqual([])
  })

  it('keeps unknown mentions outside owned findings as help commands', async () => {
    const test = await setup({ ownsFinding: false })
    await test.comment('@octorun why does this fail?')
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.replies).toEqual([])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Unknown command')])
  })

  it('keeps unknown top-level mentions as help commands', async () => {
    const test = await setup()
    await test.comment('@octorun why does this fail?', false)
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Unknown command')])
  })

  it('denies paid finding questions from a repository reader', async () => {
    const test = await setup({ permission: 'read' })
    await test.comment('@octorun why does this fail?')
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.comments).toEqual([])
    expect(test.replies).toEqual([])
  })

  it('answers information commands on a draft without starting paid work', async () => {
    const test = await setup()
    test.setDraft()
    await test.comment('@octorun help', false)
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Use @octorun help')])
  })
})

describe('host repository authority', () => {
  const denial = { _tag: 'Authorization' as const, message: 'The host requires current repository approval.' }
  const denied = err(denial)

  it('denies execution before a provider turn and preserves the host reason', async () => {
    const test = await setup({ authorizeRun: async () => denied })
    await test.service().run({ repository: repository.fullName, number: 1 })
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.comments).toEqual([])
    expect(test.service().runner.runs()[0]?.state).toEqual({ _tag: 'Failed', error: denial })
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'action_required', output: expect.objectContaining({ summary: expect.stringContaining(denial.message) }) })])
  })

  it('rechecks host authority before each paid reservation within one task', async () => {
    let allowed = true
    let paidCalls = 0
    const test = await setup({
      authorizeRun: async () => allowed ? ok(undefined) : denied,
      async execute(context) {
        for (let turn = 0; turn < 2; turn++) {
          const reservation = await context.reserveUsage({ inputTokens: 5, outputTokens: 5, costUsd: null })
          if (reservation._tag === 'Err')
            return { _tag: 'Failed', error: reservation.error }
          paidCalls++
          await context.settleUsage(reservation.value, { inputTokens: 5, outputTokens: 5, costUsd: null })
          allowed = false
        }
        return { _tag: 'Succeeded', output: null }
      },
    })
    await test.service().run({ repository: repository.fullName, number: 1, workflow: 'authority-test' })
    await test.service().settle()
    expect(paidCalls).toBe(1)
    expect(test.service().runner.runs()[0]?.state).toEqual({ _tag: 'Failed', error: denial })
  })

  it('withholds queued result publication after host authority is revoked', async () => {
    let allowed = true
    const test = await setup({
      authorizeRun: async () => allowed ? ok(undefined) : denied,
      async execute(context) {
        const publication = await context.publish('result', { _tag: 'Comment', repository: repository.fullName, number: 1, namespace: 'authority-test', body: 'A result.' })
        if (publication._tag === 'Err')
          return { _tag: 'Failed', error: publication.error }
        allowed = false
        return { _tag: 'Succeeded', output: null }
      },
    })
    await test.service().run({ repository: repository.fullName, number: 1, workflow: 'authority-test' })
    await test.service().settle()
    expect(test.comments).toEqual([])
    expect(test.service().runner.runs()[0]?.state).toEqual({ _tag: 'Failed', error: denial })
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'action_required' })])
  })

  it('aborts an active provider turn after host authority is revoked', async () => {
    let allowed = true
    const test = await setup({ holdProvider: true, authorizeRun: async () => allowed ? ok(undefined) : denied })
    await test.service().run({ repository: repository.fullName, number: 1 })
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    expect(test.calls()).toBeGreaterThan(0)
    const dispatched = test.calls()
    allowed = false
    test.advanceClock()
    await test.service().tick()
    await test.service().settle()
    expect(test.aborted()).toBe(dispatched)
    expect(test.calls()).toBe(dispatched)
    expect(test.service().runner.runs()[0]?.state).toEqual({ _tag: 'Failed', error: denial })
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'action_required' })])
  })

  it('does not let host authorization grant a disabled capability', async () => {
    const test = await setup({ authorizeRun: async () => ok(undefined) })
    test.config.repositories[0]!.policy.capabilities = ['repository:read']
    expect(await test.service().run({ repository: repository.fullName, number: 1 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(test.calls()).toBe(0)
  })
})

describe('pull request eligibility', () => {
  it('updates the same overview when a running review is cancelled', async () => {
    const test = await setup({ holdProvider: true })
    await test.service().run({ repository: repository.fullName, number: 1 })
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    expect(test.calls()).toBeGreaterThan(0)
    expect(test.comments).toEqual([expect.objectContaining({ body: expect.stringContaining('Adversarial review: Running.') })])
    const overviewId = test.comments[0]!.id
    const dispatched = test.calls()
    const runId = test.service().runner.runs()[0]!.id

    await test.service().command('cancel', { runId })
    await test.service().settle()
    test.service().runner.publishSystem(runId, 'stale-running-status', { _tag: 'Comment', repository: repository.fullName, number: 1, namespace: 'review', body: 'Adversarial review: Running.' })
    test.service().runner.publishSystem(runId, 'arbitrary-terminal-output', { _tag: 'Comment', repository: repository.fullName, number: 1, namespace: 'review', body: 'A task result after cancellation.' })
    await test.service().settle()

    expect(test.comments).toEqual([expect.objectContaining({ id: overviewId, body: expect.stringContaining('Adversarial review: Cancelled.') })])
    expect(test.comments[0]!.body).toContain('A maintainer cancelled this workflow run.')
    expect(test.comments[0]!.body).toContain('Request another run when you are ready.')
    expect(test.calls()).toBe(dispatched)
    expect(test.aborted()).toBe(dispatched)
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'cancelled' })])
  })

  it('keeps a newer review result when recovering an older cancellation', async () => {
    const options = { holdProvider: true }
    const test = await setup(options)
    await test.service().run({ repository: repository.fullName, number: 1, requestId: 'old-review' })
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    await test.service().command('cancel', { runId: test.service().runner.runs()[0]!.id })
    await test.service().settle()
    options.holdProvider = false
    await test.service().command('run', { repository: repository.fullName, number: 1, requestId: 'new-review' })
    const completed = test.comments.map(comment => ({ id: comment.id, body: comment.body }))
    expect(completed).toEqual([expect.objectContaining({ body: expect.stringContaining('No actionable findings') })])

    await test.restart()
    await test.service().settle()

    expect(test.comments.map(comment => ({ id: comment.id, body: comment.body }))).toEqual(completed)
  })

  it('keeps a cancelled task result blocked even if it looks like a status comment', async () => {
    const test = await setup({
      async execute(context) {
        const result = await context.publish('result', { _tag: 'Comment', repository: repository.fullName, number: 1, namespace: 'review', body: 'Authority test: Cancelled.\nHead: aaaaaaaaaaaa.\nA maintainer cancelled this workflow run.\nRequest another run when you are ready.' })
        if (result._tag === 'Err')
          return { _tag: 'Failed', error: result.error }
        test.service().runner.cancel(context.run.id)
        return { _tag: 'Succeeded', output: null }
      },
    })
    await test.service().run({ repository: repository.fullName, number: 1, workflow: 'authority-test' })
    await test.service().settle()

    expect(test.comments).toEqual([])
    expect(test.calls()).toBe(0)
    expect(test.service().runner.runs()[0]!.state._tag).toBe('Cancelled')
  })

  it('withholds a cancellation overview after host authority is revoked', async () => {
    let allowed = true
    const test = await setup({ holdProvider: true, authorizeRun: async () => allowed ? ok(undefined) : err({ _tag: 'Authorization', message: 'Host authority was revoked.' }) })
    await test.service().run({ repository: repository.fullName, number: 1 })
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    const original = test.comments.map(comment => ({ id: comment.id, body: comment.body }))
    const dispatched = test.calls()
    allowed = false

    await test.service().command('cancel', { runId: test.service().runner.runs()[0]!.id })
    await test.service().settle()

    expect(test.comments.map(comment => ({ id: comment.id, body: comment.body }))).toEqual(original)
    expect(test.calls()).toBe(dispatched)
    expect(test.aborted()).toBe(dispatched)
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'cancelled' })])
  })

  it('rechecks the command actor before publishing a cancellation overview', async () => {
    const options = { holdProvider: true, permission: 'write' as 'read' | 'write' }
    const test = await setup(options)
    await test.comment('@octorun review', false)
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    const original = test.comments.map(comment => ({ id: comment.id, body: comment.body }))
    const dispatched = test.calls()
    options.permission = 'read'

    await test.service().command('cancel', { runId: test.service().runner.runs()[0]!.id })
    await test.service().settle()

    expect(test.comments.map(comment => ({ id: comment.id, body: comment.body }))).toEqual(original)
    expect(test.calls()).toBe(dispatched)
    expect(test.aborted()).toBe(dispatched)
  })

  it('refuses archived repository execution before a paid turn', async () => {
    const test = await setup()
    await test.service().poll({ backfill: true })
    test.archive()
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.service().runner.runs()[0]?.state).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
  })

  it.each(['id', 'installationId'] as const)('rechecks the configured %s when recovering a queued run', async (pin) => {
    const test = await setup()
    await test.service().poll({ backfill: true })
    test.config.repositories[0]![pin]++
    await test.restart()
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.comments).toEqual([])
    expect(test.checks).toEqual([])
    expect(test.service().runner.runs()[0]?.state).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
  })

  it('cancels a queued review when polling observes its pull request close after restart', async () => {
    const test = await setup()
    expect((await test.service().poll({ backfill: true }))._tag).toBe('Ok')
    await test.restart()
    test.closePr()
    expect((await test.service().poll())._tag).toBe('Ok')
    expect(test.service().runner.runs()[0]?.state._tag).toBe('Cancelled')
    expect(await test.service().poll()).toMatchObject({ _tag: 'Ok', value: { accepted: 0 } })
    await test.service().settle()
    expect(test.calls()).toBe(0)
  })

  it.each(['closed', 'draft'])('cancels paid work before dispatch if the pull request becomes %s between polls', async (state) => {
    const test = await setup()
    await test.service().poll({ backfill: true })
    if (state === 'closed')
      test.closePr()
    else
      test.setDraft()
    await test.service().settle()
    expect(test.calls()).toBe(0)
    expect(test.service().runner.runs()[0]?.state._tag).toBe('Cancelled')
  })

  it('aborts active provider turns when the pull request closes between polls', async () => {
    const test = await setup({ holdProvider: true })
    await test.service().poll({ backfill: true })
    for (let pass = 0; pass < 10 && test.calls() === 0; pass++)
      await test.service().tick()
    expect(test.calls()).toBeGreaterThan(0)
    const dispatched = test.calls()
    test.closePr()
    test.advanceClock()
    await test.service().tick()
    await test.service().settle()
    expect(test.aborted()).toBe(dispatched)
    expect(test.calls()).toBe(dispatched)
    expect(test.service().runner.runs()[0]?.state._tag).toBe('Cancelled')
  })
})

describe('native check actions', () => {
  it.each([true, false])('advertises native actions only when webhook delivery is configured: %s', async (webhook) => {
    const test = await setup({ webhook })
    await test.service().run({ repository: repository.fullName, number: 1 })
    await test.service().settle()
    expect(test.checks).toEqual([expect.objectContaining({ status: 'completed', conclusion: 'success', ...(webhook ? { actions: [{ label: 'Run again', description: 'Run this workflow again.', identifier: 'rerun' }] } : {}) })])
    if (!webhook)
      expect(test.checks[0]?.actions).toBeUndefined()
  })
})
