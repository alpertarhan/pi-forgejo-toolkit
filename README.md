# pi-forgejo-toolkit

[![npm version](https://img.shields.io/npm/v/pi-forgejo-toolkit.svg)](https://www.npmjs.com/package/pi-forgejo-toolkit)
[![CI](https://github.com/alpertarhan/pi-forgejo-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/alpertarhan/pi-forgejo-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-forgejo-toolkit.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6b5cff)](https://pi.dev/packages/pi-forgejo-toolkit)

A multi-server [Forgejo](https://forgejo.org/) integration for [Pi](https://pi.dev/): repository context resolution, an attention dashboard, issue and pull-request workflows, evidence-backed reviews, notifications, search, and Forgejo Actions operations.

`pi-forgejo-toolkit` is designed for teams that use Forgejo instead of GitHub, especially when the same developer works across multiple Forgejo instances.

## Why this package

A bare `owner/repo#123` is not enough when two servers can contain the same owner, repository, or issue number. This package keeps server identity attached to every resource and resolves the active repository from local Git remotes when that resolution is unambiguous.

It also gives Pi a single, safety-oriented interface for:

- Multiple Forgejo servers with separate credentials
- Issues, pull requests, comments, planning metadata, and subscriptions
- Pull-request diffs, checks, reviews, readiness, and guarded merges
- Forgejo Actions runs, jobs, bounded logs, dispatches, cancellation, reruns, and artifacts
- A compact TUI attention queue across all configured servers
- Session-scoped incremental timeline updates that avoid rereading an entire discussion
- Cross-server search that never drops the source server identity

## Installation

Install the latest npm release:

```bash
pi install npm:pi-forgejo-toolkit
```

Restart Pi or run `/reload`, then create a configuration:

```text
/fj-setup
```

`/fj-setup` discovers instances already authenticated in [`fgj`](https://codeberg.org/forgejo-contrib/forgejo-cli), lets you review the generated JSON, and asks before writing it. It is optional: API-token users can create the configuration below and never install or invoke `fgj`.

Alternative package sources:

```bash
# Install directly from GitHub
pi install git:github.com/alpertarhan/pi-forgejo-toolkit

# Pin an exact npm version
pi install npm:pi-forgejo-toolkit@0.2.2
```

Update an unpinned install with:

```bash
pi update npm:pi-forgejo-toolkit
```

## Requirements and compatibility

- A current Pi installation
- One or more reachable Forgejo instances
- Either an authenticated `fgj` profile or one token environment variable per server
- Forgejo API permissions appropriate for the operations you want to use

The package is tested against Forgejo 16.0.2. Actions support is discovered per route from the instance's same-origin Swagger document; unsupported operations fail closed instead of assuming that every Forgejo release exposes the same endpoints.

### Flexible Pi versions

Published Pi core dependencies use the official package contract's `"*"` peer ranges:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

This intentionally avoids pinning the extension to one Pi release. Normal Pi updates do not require a matching `pi-forgejo-toolkit` release. Development dependencies are locked with Bun only to keep this repository's CI reproducible.

## Quick start

1. Authenticate each Forgejo instance with `fgj`, or export token variables.
2. Install the package with `pi install npm:pi-forgejo-toolkit`.
3. Run `/fj-setup global` for `fgj`-backed configuration, or create the JSON manually.
4. Open a repository whose Git remote points at a configured server.
5. Run `/fj-context` and `/fj-health`.
6. Open `/fj` for the interactive attention dashboard.

Example prompts:

```text
Show my review requests and failed Actions runs across every Forgejo server.

Read work:platform/api#123, summarize new timeline updates, and tell me what remains.

Review community:tools/runner!45. Build the review draft, but do not submit it.

List the latest failed Actions runs for work:platform/api and inspect the failed job log.
```

## Configuration

Configuration is loaded from two locations:

- Global: `~/.pi/agent/forgejo.json`
- Project: `<project>/.pi/forgejo.json`

Set `PI_FORGEJO_CONFIG=/absolute/path/to/forgejo.json` to override the global path. Project configuration can add or replace server aliases and override dashboard fields.

Inline plaintext token fields are rejected. Use the CLI-independent `env` provider with `tokenEnv`, or use the optional `fgj` provider.

### Optional: `fgj` credential store

```json
{
  "servers": {
    "work": {
      "hostname": "git.work.example",
      "credentialProvider": "fgj",
      "remoteHosts": ["forgejo-work"]
    },
    "community": {
      "hostname": "code.community.example",
      "credentialProvider": "fgj",
      "remoteHosts": ["forgejo-community"]
    }
  },
  "dashboard": {
    "enabled": true,
    "scope": "all",
    "refreshSeconds": 90,
    "previewLimit": 3,
    "notifications": "important",
    "privacy": "full"
  }
}
```

Use `fgjConfig` when the CLI configuration is not at its default path:

```json
{
  "hostname": "git.work.example",
  "credentialProvider": "fgj",
  "fgjConfig": "/absolute/path/to/fgj/config.yaml"
}
```

### API token credentials (no CLI required)

```json
{
  "servers": {
    "work": {
      "baseUrl": "https://git.work.example",
      "hostname": "git.work.example",
      "credentialProvider": "env",
      "tokenEnv": "FORGEJO_WORK_TOKEN",
      "remoteHosts": ["forgejo-work"]
    }
  }
}
```

```bash
export FORGEJO_WORK_TOKEN='...'
pi
```

Use a separate, least-privilege Forgejo API token for every server. The environment provider reads only the named variable and never invokes `fgj` or another CLI. Required scopes depend on the enabled operations: repository and issue reads for normal inspection; write scopes for comments and metadata; notification scopes for inbox updates; and repository permissions for Actions or merge operations.

### Server fields

| Field | Required | Description |
| --- | --- | --- |
| `baseUrl` | One of `baseUrl` or `hostname` | Absolute HTTP(S) Forgejo URL. Subpath installations are supported. |
| `hostname` | One of `baseUrl` or `hostname` | Hostname, optionally with a port, used by `fgj` and remote matching. |
| `credentialProvider` | No | `env` or `fgj`; defaults to `env`. |
| `tokenEnv` | For `env` | Environment variable containing the Forgejo API token. |
| `fgjConfig` | No | Optional absolute or relative path passed to `fgj --config`. |
| `remoteHosts` | No | Extra Git/SSH hostnames or SSH aliases that identify this server. |

### Dashboard fields

| Field | Default | Values |
| --- | --- | --- |
| `enabled` | `true` | Show the compact TUI widget at startup. |
| `scope` | `all` | `all` or `current`. |
| `refreshSeconds` | `90` | Integer from 30 to 3600. |
| `previewLimit` | `3` | Integer from 1 to 20. |
| `notifications` | `important` | `off`, `important`, or `all`. |
| `privacy` | `full` | `full` or `counts-only`; counts-only hides resource previews and active repository identity in the widget. |

See [`examples/forgejo.json`](examples/forgejo.json) for a complete configuration.

## Resource identity and repository resolution

Human-readable references:

```text
work:platform/api              repository
work:platform/api#123          issue
work:platform/api!45           pull request
```

Canonical references are also accepted:

```text
fj://work/platform/api/issues/123
fj://work/platform/api/pulls/45
```

For tool calls, an explicit qualified `ref` wins. Otherwise `server`, `owner`, and `repo` must be supplied together. If neither is supplied, the package uses the repository selected from local Git remotes or `/fj-server`.

The remote resolver understands HTTPS, `ssh://`, SCP-style SSH URLs, ports, `.git` suffixes, Forgejo subpaths, and SSH host aliases. If multiple configured repositories match, it stops and requires an explicit choice.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/fj-setup [global\|project]` | Discover authenticated `fgj` instances, review config, and write it after confirmation. |
| `/fj-context` | Show the active server and repository. |
| `/fj-server [alias]` | Select a server for the current session. |
| `/fj-health` | Authenticate and report every configured server's Forgejo version. |
| `/fj-refresh` | Refresh capabilities and the dashboard immediately. |
| `/fj-widget [on\|off\|all\|current]` | Show, hide, or scope the compact widget. |
| `/fj-open [qualified-ref]` | Open the active repository or exact issue/PR in the browser. |
| `/fj` | Open the interactive attention dashboard and paste a selected reference into the editor. |

## Pi tools

The package registers nine model-callable tools. Users normally describe the desired operation instead of constructing JSON manually.

By default, only `forgejo_context` and the compact `forgejo_tools` loader are active. The loader activates at most four requested issue, pull, review, Actions, notification, search, or dashboard domains per call, additively for the current session; a new session returns to the compact set. There is deliberately no "load everything" option. The bundled skills request only their required domains. This keeps seven larger schemas out of Pi's initial context and avoids rebuilding the system prompt when a domain is activated, without delaying slash commands or the TUI dashboard.

| Tool | Actions |
| --- | --- |
| `forgejo_context` | `current`, `servers`, `select`, `whoami`, `health`, `capabilities`, `resolve_ref` |
| `forgejo_tools` | Activate one to four Forgejo tool domains for the current session |
| `forgejo_dashboard` | `get`, `refresh`, `get_attention_items`, `get_assigned_issues`, `get_authored_pulls`, `get_review_requests`, `get_failed_runs` |
| `forgejo_search` | `issues`, `pulls`, `repositories`, `users` |
| `forgejo_notifications` | `list`, `get`, `mark_read`, `mark_unread`, `mark_all_read` |
| `forgejo_issue` | `list`, `get`, `timeline`, `updates`, `create`, `update`, `comment`, `get_comment`, `edit_comment`, `delete_comment`, `subscription`, `subscribe`, `unsubscribe`, `set_labels`, `set_assignees`, `set_milestone`, `clear_milestone`, `set_due_date`, `clear_due_date`, `close`, `reopen` |
| `forgejo_pull` | `list`, `get`, `timeline`, `updates`, `comment`, `get_comment`, `edit_comment`, `delete_comment`, `subscription`, `subscribe`, `unsubscribe`, `files`, `diff`, `commits`, `checks`, `create`, `update`, `set_labels`, `set_assignees`, `set_milestone`, `clear_milestone`, `set_due_date`, `clear_due_date`, `set_maintainer_edit`, `close`, `reopen`, `mark_draft`, `mark_ready`, `request_reviewers`, `remove_reviewers`, `readiness`, `merge` |
| `forgejo_review` | `list`, `get`, `get_comments`, `create_draft`, `add_inline_comment`, `preview`, `submit`, `discard` |
| `forgejo_actions` | `list`, `get`, `jobs`, `job_log`, `dispatch`, `cancel`, `rerun`, `artifacts`, `artifact`, `download_artifact` |

Model-visible metadata and discussion output defaults to 32 KB. Pull-request diffs and Actions job logs default to 64 KB. `max_bytes` can lower either budget but is hard-capped at 128 KB; truncated timeline results retain pagination and recovery metadata. Cross-server search includes a bounded, single-line body preview; use the qualified result with `forgejo_issue` or `forgejo_pull` when the complete body is needed. Oversized hidden tool details are compacted before Pi persists them, retaining small identifiers and recovery fields rather than duplicating full remote payloads in session history. Artifact downloads use the separate `max_download_bytes` limit and write ZIP bytes to a deliberate workspace path instead of returning the archive to the model.

## Dashboard

The dashboard aggregates, per server:

- Assigned open issues
- Authored open pull requests
- Pull requests awaiting your review
- Unread notification threads
- Latest failed Forgejo Actions runs for the active repository

`My Open PRs` is the complete count of authored pull requests that Forgejo currently reports as open in the selected dashboard scope; it is not a lifetime total. Item lists remain bounded by `previewLimit`.

One server failing does not erase healthy servers' data. A failed server's cached issues, pull requests, notifications, and CI runs are cleared immediately rather than displayed as stale; its error remains visible. Notification popups can be disabled or limited to important items.

Background polling runs only while the widget is visible or notification popups are enabled. With both disabled, Forgejo mutations do not trigger an otherwise unused dashboard fetch; `/fj-refresh`, `/fj`, and explicit dashboard tool reads still fetch on demand. Hiding the widget clears its status line immediately. The status line reports `syncing` during refresh and then the current attention count; `counts-only` privacy also hides the active repository there.

The interactive `/fj` overlay supports filtering and action shortcuts; selecting an item pastes its fully qualified reference into the Pi editor.

## Incremental conversations

Issue and pull-request `updates` calls keep a lightweight cursor in the current Pi session:

- The first call initializes a baseline without downloading historical timeline pages unless `since` is provided.
- Later calls fetch only the relevant time window and deduplicate events by stable event versions.
- Issue state/title changes and pull-request head SHA changes are reported with timeline events.
- A truncated or incomplete pagination scan does not advance the cursor.
- Cursors are intentionally in-memory and disappear when the Pi session ends.

This reduces model context without persisting potentially sensitive issue bodies to disk.

## Pull-request reviews and merges

Review drafts stay in memory until discarded or submitted. Inline comments are previewed with file and line positions. Submission always shows the complete draft and requires interactive confirmation.

Merge operations:

1. Fetch current pull-request metadata, checks, and reviews.
2. Reject failed checks, missing approvals, conflicts, or a changed head.
3. Show the server, repository, strategy, and expected head SHA.
4. Ask for interactive confirmation.
5. Re-fetch readiness and submit the guarded merge request.

The toolkit does not push local branches through the Forgejo API. Local Git remains the source of truth for branch creation, commits, rebases, and pushes.

## Forgejo Actions

Read operations support runs, jobs, bounded job logs, and artifacts. Mutations support workflow dispatch, cancellation, and reruns when the instance advertises the corresponding API route.

Safety properties:

- Dispatch, cancel, and rerun require a capability check and interactive confirmation.
- Dispatch input values are visible only in the local confirmation dialog; model-facing results contain input names, not values.
- Finished runs are not cancelled and running runs are not rerun.
- Job logs are byte-bounded and report truncation.
- Artifact downloads default to a 100 MB maximum and can never exceed the caller's configured bound.
- Artifact destinations must remain inside the current workspace.
- Downloads use atomic writes and never overwrite an existing file without `overwrite: true` plus confirmation.

## Included skills

### `forgejo-issue-to-pr`

An issue-to-draft-PR workflow that reads the full conversation, preserves acceptance criteria, uses local Git for code changes, verifies the work, pushes to the resolved Forgejo remote, checks Actions, and opens a linked draft pull request.

### `forgejo-pr-review`

An evidence-first review workflow that combines Forgejo metadata, timeline updates, diffs, checks, existing reviews, and local code. It builds one review draft, previews it, and submits only when the user explicitly requests publication.

Skills can be enabled or disabled independently with `pi config`.

## Security model

Pi packages execute with the same operating-system permissions as Pi. Review packages before installation.

`pi-forgejo-toolkit` enforces these boundaries:

- No plaintext token configuration
- Separate credential providers and cached credentials per server
- Authorization headers are never forwarded across redirects
- Same-origin Swagger capability discovery without credentials
- Token redaction in HTTP errors
- No automatic retry of mutations
- Exact server/repository identity for every mutation
- Comment ownership checks before edit/delete
- Interactive confirmation for destructive, publication, merge, workflow, and overwrite operations
- Bounded UTF-8 model output, logs, diffs, timelines, and downloads

See [SECURITY.md](SECURITY.md) for private reporting and deployment guidance.

## Development

This repository uses Bun for dependency management and scripts.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run check
```

`bun run check` is the required local and CI gate. The npm package ships TypeScript source because Pi loads extension modules directly; there is no generated build directory.

Project layout:

```text
extensions/forgejo/       Pi extension entry point
skills/                   Issue-to-PR and PR-review workflows
src/client.ts             Authenticated Forgejo HTTP client
src/remote-resolver.ts    Multi-remote repository resolution
src/dashboard/            Store, query, notifier, widget, and overlay
src/tools/                Model-callable Forgejo tools
src/actions.ts            Forgejo Actions request helpers
test/                     Deterministic Vitest contracts
examples/forgejo.json     Multi-server configuration example
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, tests, and the pull-request checklist.

## Release and provenance

- Versions follow [Semantic Versioning](https://semver.org/).
- Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
- GitHub Actions verifies every push and pull request with Bun.
- GitHub releases publish to npm through npm trusted publishing with provenance.
- The `pi-package` keyword and `pi` manifest make releases discoverable in the [Pi package gallery](https://pi.dev/packages/pi-forgejo-toolkit).

## License

[MIT](LICENSE) © 2026 Alper Tarhan
