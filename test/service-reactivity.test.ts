import type { AgentProvider, GitHubClient, OctorunService, OperatorConfig, PullRequestSnapshot } from '../src/index.ts'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOctorun, err, findingMarker, ok, publicationMarker } from '../src/index.ts'

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

async function setup(options: { ownsFinding?: boolean, permission?: 'read' | 'write', webhook?: boolean, holdProvider?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-reactivity-'))
  let open = true
  let draft = false
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
    repository: async () => ok({ ref: repository, defaultBranch: 'main', private: false, archived: false }),
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
  const create = async (): Promise<OctorunService> => {
    const created = await createOctorun({ config, env: { APP_KEY: 'fixture', ...(options.webhook === false ? {} : { WEBHOOK_SECRET: secret }) }, now: () => new Date(clockMs), client, provider })
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
    comments,
    replies,
    checks,
    calls: () => providerCalls,
    aborted: () => abortedCalls,
    service: () => service,
    closePr: () => { open = false },
    setDraft: () => { draft = true },
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

describe('pull request eligibility', () => {
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
