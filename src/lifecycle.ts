import type { PublicationEffect, PublicationRecord, RunRecord } from './types.ts'

export function cancelledOverview(run: RunRecord): Extract<PublicationEffect, { _tag: 'Comment' }> | null {
  if (run.state._tag !== 'Cancelled' || run.event.target._tag !== 'PullRequest' || !['adversarial-review', 'change-summary'].includes(run.definition.id))
    return null
  return {
    _tag: 'Comment',
    repository: run.event.repository.fullName,
    number: run.event.target.number,
    namespace: run.definition.id === 'adversarial-review' ? 'review' : 'change-summary',
    body: `${run.definition.name}: Cancelled.\nHead: ${run.event.target.headSha.slice(0, 12)}.\n${run.state.reason}\nRequest another run when you are ready.`,
  }
}
export function isCancelledOverview(publication: PublicationRecord, run: RunRecord): boolean {
  const expected = cancelledOverview(run)
  const effect = publication.effect
  return expected !== null && publication.taskId === '__lifecycle' && effect._tag === 'Comment'
    && effect.repository === expected.repository && effect.number === expected.number
    && effect.namespace === expected.namespace && effect.body === expected.body
}
