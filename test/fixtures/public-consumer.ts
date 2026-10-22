import type { AgentProvider, WorkflowDefinition } from '@harlan-zw/octorun'
import type { OperatorConfig } from '@harlan-zw/octorun/config'
import type { GitHubClient } from '@harlan-zw/octorun/github'
import type { OpenAICompatibleConfiguration } from '@harlan-zw/octorun/providers'
import type { SnapshotReader } from '@harlan-zw/octorun/review'
import type { ServerOptions } from '@harlan-zw/octorun/server'
import { adversarialReviewPreset, createOctorun, ok } from '@harlan-zw/octorun'
import { createGitHubClient } from '@harlan-zw/octorun/github'
import { createOpenAICompatibleProvider } from '@harlan-zw/octorun/providers'
import { createReviewTaskTypes } from '@harlan-zw/octorun/review'
import { startServer } from '@harlan-zw/octorun/server'

const provider: AgentProvider = {
  id: 'public-type-consumer',
  inputTokenOverhead: 2048,
  generate: async request => ok({ text: String(request.maxOutputTokens), usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }),
}

// @ts-expect-error Provider IDs require strings.
const invalidProvider: AgentProvider = { ...provider, id: 123 }

export function reviewTasks(snapshots: SnapshotReader) {
  const workflow: WorkflowDefinition = adversarialReviewPreset()
  return { workflow, taskTypes: createReviewTaskTypes({ snapshots, provider }) }
}

export function host(config: OperatorConfig) {
  return createOctorun({ config, provider })
}

export function github(auth: GitHubClient['auth']) {
  return createGitHubClient({ auth })
}

export function httpProvider(config: OpenAICompatibleConfiguration) {
  return createOpenAICompatibleProvider(config)
}

export function webhook(options: ServerOptions) {
  return startServer(options)
}

void invalidProvider
