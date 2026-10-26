import type { ReviewChanges, ReviewFinding, ReviewReport, ReviewSnapshot } from '../src/review.ts'
import type { AgentProvider, AgentRequest, EventEnvelope, JsonValue, PublicationEffect, RunRecord, TaskContext, TaskType, Usage } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { adversarialReviewPreset, conversationPreset, createReviewTaskTypes, findingFingerprint, parseReviewReport, verifyReviewFindings } from '../src/review.ts'

const headSha = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
const snapshot = {
  headSha,
  baseSha,
  title: 'Handle a missing account',
  body: '',
  files: [{ path: 'src/account.ts', status: 'modified', truncated: false, patch: '@@ -1,2 +1,2 @@\n export function name(account) {\n-return account?.name\n+return account.name\n' }],
}
const candidate = { path: 'src/account.ts', side: 'RIGHT', line: 2, title: 'Handle missing accounts', body: 'A missing account now throws before the fallback can run.', evidence: 'return account.name', severity: 'high', confidence: 94 } as const
const event: EventEnvelope = {
  id: 'event',
  semanticKey: 'event',
  source: 'manual',
  name: 'pull_request',
  action: 'opened',
  repository: { id: 1, fullName: 'test/project', installationId: 2 },
  actor: { id: 3, login: 'maintainer', kind: 'User' },
  target: { _tag: 'PullRequest', number: 4, headSha, baseSha },
  occurredAt: '2026-10-21T00:00:00Z',
  receivedAt: '2026-10-21T00:00:00Z',
  data: {},
}

function harness(responses: (string | { error: true })[], previousFingerprints: string[] = [], snapshotValue: ReviewSnapshot = snapshot, options: { inputTokenOverhead?: number, usage?: Usage, previous?: ReviewReport, changes?: ReviewChanges, targetHead?: string } = {}) {
  const effects: PublicationEffect[] = []
  const turns: string[] = []
  const requests: AgentRequest[] = []
  const reservations: Usage[] = []
  const settlements: Usage[] = []
  const provider: AgentProvider = {
    id: 'fixture',
    ...(options.inputTokenOverhead !== undefined ? { inputTokenOverhead: options.inputTokenOverhead } : {}),
    async generate(request) {
      requests.push(request)
      turns.push(request.messages.map(message => message.content).join('\n'))
      const response = responses.shift()
      if (response === undefined)
        throw new Error('Unexpected paid turn')
      return typeof response === 'string'
        ? { _tag: 'Ok', value: { text: response, usage: options.usage ?? { inputTokens: 20, outputTokens: 10, costUsd: null } } }
        : { _tag: 'Err', error: { _tag: 'Authorization', message: 'Fixture credentials rejected.' } }
    },
  }
  const types = createReviewTaskTypes({
    provider,
    snapshots: { read: async () => ({ _tag: 'Ok', value: snapshotValue }), changes: async () => ({ _tag: 'Ok', value: options.changes ?? { _tag: 'Changed', paths: ['src/account.ts'] } }) },
    previousReview: async () => options.previous ?? (previousFingerprints.length ? priorReport([{ ...candidate, id: 'previous', fingerprint: previousFingerprints[0]!, evidenceKind: 'static' }]) : null),
  })
  const definition = adversarialReviewPreset()
  const run: RunRecord = {
    id: 'run',
    event: { ...event, target: { _tag: 'PullRequest', number: 4, headSha: options.targetHead ?? headSha, baseSha } },
    definition,
    definitionDigest: 'digest',
    configuration: { source: 'fixture', sha: baseSha, digest: 'digest' },
    policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review'], maxConcurrency: 1 },
    state: { _tag: 'Running' },
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: event.receivedAt,
    updatedAt: event.receivedAt,
    startedAt: event.receivedAt,
    finishedAt: null,
  }
  const context: TaskContext = {
    run,
    event: run.event,
    outputs: {},
    signal: new AbortController().signal,
    task: { id: 'task', definition: definition.tasks[0]!, typeVersion: '1', state: { _tag: 'Running', leaseUntil: event.receivedAt }, attempts: 1, failures: 0, fence: 1, output: null, usage: run.usage, unreservedUsage: run.usage, usageReservations: [], startedAt: event.receivedAt, finishedAt: null },
    reserveUsage: async (usage) => {
      reservations.push(usage)
      return { _tag: 'Ok', value: crypto.randomUUID() }
    },
    settleUsage: async (_id, usage) => {
      settlements.push(usage)
      return { _tag: 'Ok', value: undefined }
    },
    publish: async (_key, effect) => {
      effects.push(effect)
      return { _tag: 'Ok', value: `publication-${effects.length}` }
    },
  }
  const execute = async (id: string, input: JsonValue) => {
    const task = types.find(task => task.id === id)!
    const parsed = task.input(input)
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.message)
    return task.execute(context, parsed.value)
  }
  return { execute, context, effects, turns, types, requests, reservations, settlements }
}

function priorReport(findings: ReviewFinding[] = []): ReviewReport {
  return { headSha: 'c'.repeat(40), baseSha, scope: { _tag: 'Full', reason: 'initial' }, coverage: 'complete', outcome: findings.length ? 'actionable' : 'clean', findings, fingerprints: findings.map(finding => finding.fingerprint), repeated: 0, rejected: 0, omittedFiles: 0, omittedFindings: 0, previousFingerprints: [] }
}

async function successful(task: ReturnType<ReturnType<typeof harness>['execute']>): Promise<JsonValue> {
  const result = await task
  expect(result._tag).toBe('Succeeded')
  if (result._tag !== 'Succeeded')
    throw new Error(JSON.stringify(result))
  return result.output
}

describe('adversarial review preset', () => {
  it('reviews only files changed since the last complete review before applying file limits', async () => {
    const other = { path: 'src/untouched.ts', status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-before\n+untouched' }
    const h = harness(['{"findings":[]}', '{"findings":[]}'], [], { ...snapshot, files: [other, ...snapshot.files] }, { previous: priorReport(), changes: { _tag: 'Changed', paths: ['src/account.ts'] } })
    const selected = await successful(h.execute('review.snapshot', { maxFiles: 1 }))
    expect(selected).toMatchObject({ scope: { _tag: 'Incremental', sinceHeadSha: 'c'.repeat(40) }, coverage: 'complete', omittedFiles: 0, files: [{ path: 'src/account.ts' }] })
    await successful(h.execute('review.adversarial', { snapshot: selected }))
    expect(h.requests.map(request => JSON.parse(request.messages[1]!.content).files.map((file: { path: string }) => file.path))).toEqual([['src/account.ts'], ['src/account.ts']])
  })

  it('carries untouched actionable findings without another model turn or duplicate review', async () => {
    const fingerprint = findingFingerprint(candidate)
    const h = harness([], [], snapshot, { previous: priorReport([{ ...candidate, id: 'previous', fingerprint, evidenceKind: 'static' }]), changes: { _tag: 'Changed', paths: [] } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report }))
    expect(report).toMatchObject({ outcome: 'actionable', repeated: 1, findings: [{ fingerprint }], fingerprints: [fingerprint] })
    expect(h.turns).toEqual([])
    expect(h.effects).toMatchObject([{ _tag: 'Comment', body: expect.stringContaining('already reported') }])
    expect(h.effects).toHaveLength(1)
  })

  it('retires findings when their file is reverted out of the current pull request', async () => {
    const fingerprint = findingFingerprint(candidate)
    const h = harness([], [], { ...snapshot, files: [] }, { previous: priorReport([{ ...candidate, id: 'previous', fingerprint, evidenceKind: 'static' }]), changes: { _tag: 'Changed', paths: ['src/account.ts'] } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    expect(report).toMatchObject({ outcome: 'clean', findings: [], fingerprints: [] })
    expect(h.turns).toEqual([])
  })

  it.each<[string, ReviewReport, ReviewChanges]>([
    ['base movement', { ...priorReport(), baseSha: 'd'.repeat(40) }, { _tag: 'Changed', paths: [] }],
    ['incomplete previous coverage', { ...priorReport(), coverage: 'incomplete', outcome: 'incomplete', omittedFiles: 1 }, { _tag: 'Changed', paths: [] }],
    ['rewritten history', priorReport(), { _tag: 'Full', reason: 'history-diverged' }],
    ['incomplete comparison', priorReport(), { _tag: 'Full', reason: 'comparison-incomplete' }],
  ])('falls back to the full pull request after %s', async (_reason, previous, changes) => {
    const h = harness([], [], snapshot, { previous, changes })
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(selected).toMatchObject({ scope: { _tag: 'Full' }, files: [{ path: 'src/account.ts' }], previous: null })
  })

  it('honours an explicit full review despite a complete incremental baseline', async () => {
    const h = harness([], [], snapshot, { previous: priorReport(), changes: { _tag: 'Changed', paths: [] } })
    h.context.event = { ...h.context.event, data: { full: true } }
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(selected).toMatchObject({ scope: { _tag: 'Full', reason: 'requested' }, files: [{ path: 'src/account.ts' }], previous: null })
  })

  it('keeps an untouched finding, retires its fix, and reports its return across successive heads', async () => {
    const fingerprint = findingFingerprint(candidate)
    const original = priorReport([{ ...candidate, id: 'previous', fingerprint, evidenceKind: 'static' }])
    const unrelated = { path: 'src/other.ts', status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-old\n+new' }
    const review = async (h: ReturnType<typeof harness>) => {
      const selected = await successful(h.execute('review.snapshot', {}))
      const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
      const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
      await successful(h.execute('review.publish', { report }))
      return report as unknown as ReviewReport
    }
    const unrelatedHead = '1'.repeat(40)
    const b = harness(['{"findings":[]}', '{"findings":[]}'], [], { ...snapshot, headSha: unrelatedHead, files: [...snapshot.files, unrelated] }, { previous: original, changes: { _tag: 'Changed', paths: [unrelated.path] }, targetHead: unrelatedHead })
    const bReport = await review(b)
    expect(bReport).toMatchObject({ outcome: 'actionable', fingerprints: [fingerprint], repeated: 1 })
    expect(b.effects.filter(effect => effect._tag === 'Review')).toEqual([])
    const fixedHead = '2'.repeat(40)
    const c = harness([], [], { ...snapshot, headSha: fixedHead, files: [unrelated] }, { previous: bReport, changes: { _tag: 'Changed', paths: [candidate.path] }, targetHead: fixedHead })
    const cReport = await review(c)
    expect(cReport).toMatchObject({ outcome: 'clean', findings: [], fingerprints: [] })
    const returnedHead = '3'.repeat(40)
    const d = harness([JSON.stringify({ findings: [candidate] }), '{"findings":[]}', '{"accepted":["correctness-0"]}'], [], { ...snapshot, headSha: returnedHead, files: [...snapshot.files, unrelated] }, { previous: cReport, changes: { _tag: 'Changed', paths: [candidate.path] }, targetHead: returnedHead })
    const dReport = await review(d)
    expect(dReport).toMatchObject({ outcome: 'actionable', fingerprints: [fingerprint], repeated: 0 })
    expect(d.effects.filter(effect => effect._tag === 'Review')).toMatchObject([{ headSha: returnedHead, comments: [{ fingerprint, path: candidate.path }] }])
  })

  it('marks inherited findings beyond the active finding limit as incomplete', async () => {
    const carried = Array.from({ length: 49 }, (_, index) => {
      const finding = { ...candidate, id: `old-${index}`, path: `src/old-${index}.ts` }
      return { ...finding, fingerprint: findingFingerprint(finding), evidenceKind: 'static' as const }
    })
    const added = Array.from({ length: 2 }, (_, index) => ({ ...candidate, id: `new-${index}`, path: `src/new-${index}.ts` }))
    const fixture = { ...snapshot, files: added.map(finding => ({ ...snapshot.files[0]!, path: finding.path })) }
    const h = harness([JSON.stringify({ accepted: added.map(finding => finding.id) })], [], fixture, { previous: priorReport(carried), changes: { _tag: 'Changed', paths: added.map(finding => finding.path) } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: { candidates: added, reviewers: 2 } })) as unknown as ReviewReport
    expect(report.coverage).toBe('incomplete')
    expect(report.omittedFindings).toBe(1)
    expect(report.findings).toHaveLength(50)
    expect(report.fingerprints).toHaveLength(50)
  })

  it('retains uncertain findings when their changed patch exceeds review limits', async () => {
    const finding = { ...candidate, id: 'previous', fingerprint: findingFingerprint(candidate), evidenceKind: 'static' as const }
    const h = harness([], [], { ...snapshot, files: [{ ...snapshot.files[0]!, patch: null, truncated: true }] }, { previous: priorReport([finding]), changes: { _tag: 'Changed', paths: [candidate.path] } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    expect(report).toMatchObject({ coverage: 'incomplete', outcome: 'actionable', fingerprints: [finding.fingerprint], repeated: 1 })
  })

  it('retires the previous path when a renamed file is reviewed without that defect', async () => {
    const finding = { ...candidate, id: 'previous', fingerprint: findingFingerprint(candidate), evidenceKind: 'static' as const }
    const h = harness(['{"findings":[]}', '{"findings":[]}'], [], { ...snapshot, files: [{ ...snapshot.files[0]!, path: 'src/renamed.ts', previousPath: candidate.path }] }, { previous: priorReport([finding]), changes: { _tag: 'Changed', paths: [candidate.path, 'src/renamed.ts'] } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    expect(report).toMatchObject({ coverage: 'complete', outcome: 'clean', findings: [], fingerprints: [] })
  })

  it('does not send inherited finding bodies to reviewer turns', async () => {
    const privateBody = 'This previous finding body is irrelevant to the changed file.'
    const finding = { ...candidate, id: 'previous', body: privateBody, fingerprint: findingFingerprint(candidate), evidenceKind: 'static' as const }
    const other = { path: 'src/other.ts', status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-old\n+new' }
    const h = harness(['{"findings":[]}', '{"findings":[]}'], [], { ...snapshot, files: [...snapshot.files, other] }, { previous: priorReport([finding]), changes: { _tag: 'Changed', paths: [other.path] } })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    expect(h.turns.every(turn => !turn.includes(privateBody))).toBe(true)
    expect(report).toMatchObject({ findings: [{ body: privateBody }] })
  })

  it.each([
    { ...priorReport(), outcome: 'actionable' },
    { ...priorReport(), coverage: 'complete', omittedFiles: 1 },
    { ...priorReport(), coverage: 'complete', omittedFindings: 1 },
    { ...priorReport(), coverage: 'incomplete', outcome: 'clean' },
    { ...priorReport(), repeated: 1 },
  ])('rejects persisted review evidence that contradicts its findings or coverage', (report) => {
    expect(parseReviewReport(report)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })
  it('reviews, independently checks, deduplicates, and publishes one anchored finding', async () => {
    const h = harness([
      JSON.stringify({ findings: [candidate, { ...candidate, evidence: 'invented evidence' }] }),
      JSON.stringify({ findings: [{ ...candidate, title: 'Reject null accounts', confidence: 90 }] }),
      JSON.stringify({ accepted: ['correctness-0'] }),
    ])
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(h.effects).toMatchObject([
      { _tag: 'Comment', body: expect.stringContaining('1 actionable finding') },
      { _tag: 'Review', headSha, comments: [{ path: 'src/account.ts', line: 2, side: 'RIGHT', body: expect.stringContaining('Handle missing accounts') }] },
    ])
    expect(h.effects.filter(effect => effect._tag === 'Review').flatMap(effect => effect.comments)).toHaveLength(1)
    expect(h.turns).toHaveLength(3)
    expect(verified).toMatchObject({ outcome: 'actionable', coverage: 'complete', rejected: 1 })
  })

  it('fails the task when a reviewer fails, without publishing a clean result', async () => {
    const h = harness([JSON.stringify({ findings: [] }), { error: true }])
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(await h.execute('review.adversarial', { snapshot: selected })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
    expect(h.effects).toEqual([])
  })

  it('reports incomplete coverage when a patch is unavailable without spending model capacity', async () => {
    const h = harness([], [], { ...snapshot, files: [{ path: 'image.png', status: 'modified', patch: null, truncated: true }] })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(verified).toMatchObject({ outcome: 'incomplete', coverage: 'incomplete', findings: [] })
    expect(h.effects).toMatchObject([{ _tag: 'Comment', body: expect.stringContaining('scope is incomplete') }])
    expect(h.turns).toEqual([])
  })

  it('rejects a snapshot from another head before any agent turn', async () => {
    const h = harness([], [], { ...snapshot, headSha: 'd'.repeat(40) })
    expect(await h.execute('review.snapshot', {})).toMatchObject({ _tag: 'Failed', error: { _tag: 'Permanent' } })
    expect(h.turns).toEqual([])
  })

  it('reserves the whole parallel batch before spending tokens', async () => {
    const h = harness([])
    h.context.run.definition.limits.maxTokens = 1000
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(await h.execute('review.adversarial', { snapshot: selected })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration', message: expect.stringContaining('token budget') } })
    expect(h.turns).toEqual([])
  })

  it('rejects a turn whose provider framing cannot fit its token budget', async () => {
    const h = harness(['A summary.'], [], snapshot, { inputTokenOverhead: 4096 })
    h.context.run.definition.limits.maxTokens = 4096
    const changes = await successful(h.execute('changes.classify', {}))
    expect(await h.execute('changes.summarize', { changes })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration', message: expect.stringContaining('token budget') } })
    expect(h.turns).toEqual([])
  })

  it('accounts for provider framing across every reviewer in a parallel batch', async () => {
    const h = harness(['{"findings":[]}', '{"findings":[]}'], [], snapshot, { inputTokenOverhead: 4096 })
    h.context.run.definition.limits.maxTokens = 8192
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(await h.execute('review.adversarial', { snapshot: selected })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration' } })
    expect(h.turns).toEqual([])
  })

  it('reserves provider framing before a turn and settles the reported prompt usage', async () => {
    const usage = { inputTokens: 4000, outputTokens: 10, costUsd: null }
    const h = harness(['A summary.'], [], snapshot, { inputTokenOverhead: 4096, usage })
    const changes = await successful(h.execute('changes.classify', {}))
    await successful(h.execute('changes.summarize', { changes }))
    const messageBytes = h.requests[0]!.messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0)
    expect(h.reservations[0]!.inputTokens).toBeGreaterThanOrEqual(4096 + messageBytes)
    expect(h.settlements).toEqual([usage])
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 65_537])('rejects invalid provider framing %s before invocation', async (inputTokenOverhead) => {
    const h = harness(['A summary.'], [], snapshot, { inputTokenOverhead })
    const changes = await successful(h.execute('changes.classify', {}))
    expect(await h.execute('changes.summarize', { changes })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration', message: expect.stringContaining('overhead') } })
    expect(h.turns).toEqual([])
  })

  it('refuses a currency budget without price estimates before any provider call', async () => {
    const h = harness([])
    h.context.run.definition.limits.maxCostUsd = 1
    const changes = await successful(h.execute('changes.classify', {}))
    expect(await h.execute('changes.summarize', { changes })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration', message: expect.stringContaining('currency budget') } })
    expect(h.turns).toEqual([])
  })

  it('runs reviewer roles within the configured parallel limit', async () => {
    const h = harness([])
    let active = 0
    let maximum = 0
    let turns = 0
    const types = createReviewTaskTypes({
      snapshots: { read: async () => ({ _tag: 'Ok', value: snapshot }) },
      provider: {
        id: 'concurrency-fixture',
        async generate() {
          active++
          turns++
          maximum = Math.max(maximum, active)
          await new Promise(resolve => setTimeout(resolve, 1))
          active--
          return { _tag: 'Ok', value: { text: '{"findings":[]}', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } } }
        },
      },
    })
    const selected = await successful(h.execute('review.snapshot', {}))
    const task = types.find(type => type.id === 'review.adversarial')!
    await successful(Promise.resolve(task.execute(h.context, { snapshot: selected, roles: ['correctness', 'security', 'regression'], maxParallelReviewers: 1 })))
    expect(maximum).toBe(1)
    expect(turns).toBe(3)
  })

  it('caps grouped findings and records incomplete scope when findings exceed the publication limit', async () => {
    const count = 51
    const patch = `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, index) => `+return value${index}`).join('\n')}`
    const fixture = { ...snapshot, files: [{ path: 'src/account.ts', status: 'modified', truncated: false, patch }] }
    const candidates = Array.from({ length: count }, (_, index) => ({ ...candidate, id: `candidate-${index}`, line: index + 1, evidence: `return value${index}` }))
    const h = harness([JSON.stringify({ accepted: candidates.slice(0, 50).map(finding => finding.id) })], [], fixture)
    const selected = await successful(h.execute('review.snapshot', {}))
    const report = await successful(h.execute('review.verify', { snapshot: selected, review: { candidates, reviewers: 2 } }))
    await successful(h.execute('review.publish', { report }))
    expect(report).toMatchObject({ coverage: 'incomplete', omittedFindings: 1, rejected: 0 })
    expect(h.effects.filter(effect => effect._tag === 'Review').flatMap(effect => effect.comments)).toHaveLength(50)
  })

  it('suppresses unchanged findings on an incremental review and retains their result', async () => {
    const fingerprint = findingFingerprint(candidate)
    const h = harness([JSON.stringify({ findings: [candidate] }), JSON.stringify({ findings: [] }), JSON.stringify({ accepted: ['correctness-0'] })], [fingerprint])
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(verified).toMatchObject({ outcome: 'actionable', repeated: 1, findings: [{ fingerprint }] })
    expect(h.effects).toHaveLength(1)
    expect(h.effects[0]).toMatchObject({ _tag: 'Comment', body: expect.stringContaining('already reported') })
  })

  it('rejects invented evidence and keeps a fingerprint stable after line movement', () => {
    const findings = verifyReviewFindings(snapshot, [
      { ...candidate, id: 'real' },
      { ...candidate, id: 'invented', evidence: 'not in the patch' },
      { ...candidate, id: 'outside', line: 500 },
    ])
    expect(findings.findings).toMatchObject([{ id: 'real', evidenceKind: 'static' }])
    expect(findings.rejected).toBe(2)
    const moved = { ...candidate, line: 42 }
    expect(findingFingerprint(moved)).toBe(findingFingerprint(candidate))
  })

  it('answers a finding question in its existing thread without starting another review', async () => {
    const h = harness(['The missing account throws when this line reads its name. Add the optional access again.'])
    await successful(h.execute('review.conversation', { conversation: { commentId: 52, question: 'Why does this fail?', reviewedHeadSha: headSha, finding: candidate, history: [] } }))
    expect(h.effects).toMatchObject([{ _tag: 'Reply', commentId: 52, body: expect.stringContaining('missing account') }])
    expect(h.turns).toHaveLength(1)
  })

  it('fits a focused finding conversation within its default budget on a large pull request', async () => {
    const focusedPath = 'src/focused.ts'
    const files = Array.from({ length: 70 }, (_, index) => ({ path: `src/unrelated-${index}.ts`, status: 'modified', truncated: false, patch: `@@ -1 +1 @@\n-old\n+${'unrelated source '.repeat(400)}` }))
    files.push({ path: focusedPath, status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-old\n+return account.name' })
    const h = harness(['A missing account makes this property access throw.'], [], { ...snapshot, files }, { inputTokenOverhead: 4096 })
    h.context.run.definition = conversationPreset()
    const finding = { ...candidate, path: focusedPath }
    const question = 'Why does this account access throw?'
    const history = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `${index}: ${'🦊'.repeat(1900)}` }))
    await successful(h.execute('review.conversation', { conversation: { commentId: 52, question, finding, history, reviewedHeadSha: headSha } }))
    const request = h.requests[0]!
    const payload = JSON.parse(request.messages[1]!.content)
    expect(payload.question).toBe(question)
    expect(payload.finding).toEqual(finding)
    expect(payload.current.files).toContainEqual(expect.objectContaining({ path: focusedPath, patch: expect.stringContaining('return account.name') }))
    expect(payload.current.coverage).toBe('incomplete')
    expect(payload.current.omittedFiles).toBeGreaterThan(0)
    expect(payload.omittedHistoryMessages).toBeGreaterThan(0)
    expect(Buffer.byteLength(request.messages.map(message => message.content).join(''), 'utf8') + request.maxOutputTokens).toBeLessThan(50_000)
    expect(h.reservations[0]!.inputTokens + h.reservations[0]!.outputTokens).toBeLessThanOrEqual(50_000)
    expect(h.reservations[0]!.inputTokens).toBeGreaterThanOrEqual(4096 + Buffer.byteLength(request.messages.map(message => message.content).join(''), 'utf8'))
    expect(h.effects).toMatchObject([{ _tag: 'Reply', commentId: 52 }])
    expect(h.turns).toHaveLength(1)
  })

  it('preserves an oversized question and finding by refusing before provider spending', async () => {
    const h = harness([])
    h.context.run.definition = conversationPreset()
    const result = await h.execute('review.conversation', { conversation: { commentId: 52, question: '🦊'.repeat(4000), finding: { path: 'src/account.ts', body: '界'.repeat(11500) } } })
    expect(result).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration', message: expect.stringContaining('question and finding') } })
    expect(h.turns).toEqual([])
  })
})

describe('custom change summary chain', () => {
  it.each(['x', '界'])('fits a large classified diff within the remaining summary budget: %s', async (character) => {
    const files = [
      { path: 'src/small.ts', status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/large.ts', status: 'modified', truncated: false, patch: `@@ -1 +1 @@\n-old\n+${character.repeat(100_000)}` },
    ]
    const h = harness(['Update the input handling.'], [], { ...snapshot, files }, { inputTokenOverhead: 2048 })
    const changes = await successful(h.execute('changes.classify', {}))
    await successful(h.execute('changes.summarize', { changes }))
    const request = h.requests[0]!
    const payload = JSON.parse(request.messages[1]!.content)
    expect(payload.files.map((file: { path: string }) => file.path)).toEqual(['src/small.ts', 'src/large.ts'])
    expect(payload.files[0].patch).toBe(files[0]!.patch)
    expect(payload.files[1].patch.length).toBeLessThan(99_000)
    expect(payload.coverage).toBe('incomplete')
    expect(payload.truncatedFiles).toContain('src/large.ts')
    expect(payload.files[1].patch).not.toContain('\uFFFD')
    expect(request.maxOutputTokens).toBe(1024)
    expect(h.reservations[0]!.inputTokens + h.reservations[0]!.outputTokens).toBeLessThanOrEqual(100_000)
    expect(h.turns).toHaveLength(1)
  })

  it('reports omitted file metadata when prior usage leaves a small summary budget', async () => {
    const h = harness(['Some changes could not fit this summary.'], [], snapshot, { inputTokenOverhead: 2048 })
    h.context.run.usage.inputTokens = 90_000
    const files = Array.from({ length: 200 }, (_, index) => ({ path: `src/${index}-${'x'.repeat(900)}.ts`, category: 'source', patch: null }))
    await successful(h.execute('changes.summarize', { changes: { headSha, coverage: 'complete', files } }))
    const payload = JSON.parse(h.requests[0]!.messages[1]!.content)
    expect(payload.files.length).toBeGreaterThan(0)
    expect(payload.files[0]).toEqual(files[0])
    expect(payload.omittedFiles).toBe(200 - payload.files.length)
    expect(payload.coverage).toBe('incomplete')
    expect(h.reservations[0]!.inputTokens + h.reservations[0]!.outputTokens).toBeLessThanOrEqual(10_000)
    expect(h.turns).toHaveLength(1)
  })

  it('classifies files, generates a summary, and publishes a comment without review state', async () => {
    const h = harness(['Handle account names directly.'])
    const changes = await successful(h.execute('changes.classify', {}))
    const summary = await successful(h.execute('changes.summarize', { changes }))
    await successful(h.execute('changes.comment', { summary }))
    expect(changes).toMatchObject({ files: [{ path: 'src/account.ts', category: 'source' }] })
    expect(h.effects).toMatchObject([{ _tag: 'Comment', namespace: 'change-summary', body: 'Handle account names directly.' }])
  })

  it('refuses malformed task inputs before requesting an agent turn', () => {
    const h = harness([])
    const type = h.types.find(type => type.id === 'review.conversation') as TaskType
    expect(type.input({ conversation: { commentId: -1, question: '' } })).toMatchObject({ _tag: 'Err' })
    expect(h.turns).toEqual([])
  })
})
