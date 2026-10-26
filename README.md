# Octorun

Run reactive GitHub workflows with your own agent provider.
Choose a task chain for each repository's pull requests.
Use GitHub comments, grouped findings, and check runs to follow the result.

## Why Octorun

A pull request can need a review, a change summary, or another task chain.
Octorun gives those tasks one durable runtime and one GitHub interface.
The first preset runs an adversarial review.
A second preset classifies changes, writes a summary, and updates a comment.
Both use the same scheduler and task contract.

## Features

- 🔄 **Reactive workflows:** GitHub webhooks and polling feed the same runtime.
- 💬 **GitHub interactions:** Explicit commands control reviews and keep their result on the pull request.
- 🧩 **Task chains:** Ordered tasks share typed outputs, conditions, retry limits, and usage budgets.
- 🔐 **Repository policy:** Explicit App mappings limit which repositories and capabilities each workflow can use.
- 💾 **Recovery:** SQLite records events, runs, outputs, and GitHub publication identities across restarts.

## Setup

Use Linux with Node.js 24 or newer and pnpm.
Provide a GitHub App installation and an agent provider.
Choose an OpenAI-compatible chat completion endpoint or an existing Claude Code login.
The review preset sends pull request text and diffs to the configured agent provider.
It runs no repository code or shell commands.

From the repository root, build a tarball:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm pack --out /tmp/octorun.tgz
```

From an unrelated directory, install that tarball:

```bash
pnpm add --global /tmp/octorun.tgz
octorun help
```

If pnpm reports a missing global binary directory, run `pnpm setup` and open a new shell before repeating installation.

The tarball contains the CLI, library declarations, preset implementation, examples, and license.
Use a release tarball from your chosen source when installing outside this checkout.

Set `OCTORUN_GITHUB_PRIVATE_KEY` through your service manager or secret manager before creating configuration.
It holds the complete App PEM private key.
Octorun uses your App ID and key to discover the repository and installation IDs:

```bash
octorun init --repository your-org/your-repository --app-id 123 \
  --model your-provider-model
```

For Claude Code, install the CLI and run `claude auth login` on the controller host.
Then select Claude instead of the HTTP provider:

```bash
octorun init --repository your-org/your-repository --app-id 123 \
  --provider claude
```

Claude defaults to `claude-opus-5-5`.
Pass `--model` to select another model.
It uses bounded text turns with tools, repository instructions, and session persistence disabled.
Authentication checks and turns use the same environment allowlist.
It preserves stored-login paths, locale, platform, proxy, and certificate settings.
It excludes controller credentials, injected Node options, API tokens, OAuth tokens, and backend overrides.
Use `claude auth login` with the controller's `HOME` and optional `CLAUDE_CONFIG_DIR`.
See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) for installation and login controls.

For offline setup, provide both `--repository-id ID` and `--installation-id ID` to skip discovery.
The file names environment variables for credentials.
Set those variables through your service manager or secret manager.
The HTTP provider requires `OCTORUN_API_KEY`.
Claude uses its existing login and requires no HTTP API key.
`OCTORUN_WEBHOOK_SECRET` is optional for polling and required for webhook delivery.
Use at least 16 characters for that secret.

```bash
octorun validate
octorun doctor
octorun doctor --online
octorun plan --repository your-org/your-repository --pr 7
octorun run --repository your-org/your-repository --pr 7
```

`plan` shows the selected workflow without starting its tasks.
`run` processes the requested pull request through the selected workflow.
To process future events continuously, run `octorun serve`.
`doctor` checks Claude installation and login without a paid turn.
`doctor --online` also checks GitHub access.
HTTP diagnostics check configuration and referenced credentials, without authenticating against the provider.

Read [first review](docs/guides/first-review.md) for App permissions, credentials, webhooks, and initial polling.

## Guides

| Guide | Task |
| --- | --- |
| [First review](docs/guides/first-review.md) | Configure an App and run a review |
| [Workflows](docs/guides/workflows.md) | Select presets, chain tasks, and load trusted definitions |
| [Operations](docs/guides/operations.md) | Inspect runs, pause admission, back up, restore, and recover |
| [Configuration example](examples/config.yaml) | Copy a complete operator configuration |
| [Extraction design](docs/ideas/architecture.md) | Understand the design and original acceptance criteria |
| [Vocabulary](GLOSSARY.md) | Look up workflow, task, event, and repository policy |

## API

The package exports the runtime, store, workflow parser, task contracts, and service factory.
Task implementations register with `createRunner`.
Their capabilities must fit the repository policy.
Repository configuration cannot register executable JavaScript.

Focused entry points include `@harlan-zw/octorun/config`, `@harlan-zw/octorun/server`, `@harlan-zw/octorun/github`, `@harlan-zw/octorun/review`, and `@harlan-zw/octorun/providers`.
See [workflows](docs/guides/workflows.md) for a custom task example.

## License

[MIT](LICENSE.md).
