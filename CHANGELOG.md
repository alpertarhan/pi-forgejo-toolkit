# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-08-19

### Changed

- Dashboard refreshes now coalesce without cancelling active work, `current` scope limits server polling, timeline-only watches avoid redundant resource requests, and cached identity lookup no longer forces Swagger rediscovery.

### Fixed

- Fixed shared credential and capability cancellation leaking between callers, session shutdown leaving discovery work alive, mutation prompts ignoring tool cancellation, and title-prefixed draft pull requests bypassing merge readiness.

## [0.5.0] - 2026-08-17

### Added

- Mutation confirmations now offer `Allow once`, session-wide approval, and an explicitly global `Always allow on all servers and repositories`. Saved approvals use stable action keys in `allowedMutations` in the global config only (never a committed project config), are refreshed by active Pi sessions before each mutation, and also enable approved mutations in headless print mode. Config writes use a cross-process lock so concurrent Pi sessions cannot overwrite each other's approvals.

## [0.4.2] - 2026-08-16

### Fixed

- `forgejo_watch` start no longer fails with `response.data is not iterable`: Forgejo marshals an empty timeline window (Go nil slice) as JSON `null`, which the timeline scan now treats as no events (#6).

## [0.4.1] - 2026-08-15

### Changed

- Repository resolution now reports an explicit reason when Git remotes point at GitHub, GitLab, or Bitbucket instead of a configured Forgejo server, directing agents to the `gh` CLI or plain git instead of leaving the failure generic.
- Server configuration rejects known non-Forgejo hosts up front with a clear configuration error, preventing partially compatible GitHub/GitLab API setups that fail in confusing ways.

## [0.4.0] - 2026-08-14

### Added

- Added the lazy `forgejo_watch` domain for session-scoped one-shot issue and pull-request timeline watches, with start/list/stop controls and metadata-only Pi wake messages.

### Changed

- The dashboard widget, popup notifier, and automatic polling now start only when local Git remotes match a configured Forgejo server; explicit dashboard commands remain available elsewhere.
- Dashboard mutation refreshes are coalesced in the background, capability discovery is cached per server, explicit refreshes bypass that cache, and unsupported Actions polling is skipped.
- Incremental timeline scans now tolerate Forgejo pagination limits and local/server clock skew, cancel failed polls cleanly, deduplicate transition events, and bound watch-list model output.
- Large HTTP responses and artifact downloads are streamed with byte limits and request deadlines; merge readiness and label resolution page through complete decision inputs.
- Issue and pull-request comments, subscriptions, and planning metadata now share one verified mutation path to prevent behavior drift.
- GitHub Actions are pinned to immutable commits, release caches are disabled, Dependabot updates use a seven-day cooldown, and CI compiles/imports the extension under the minimum Node runtime.

### Fixed

- Fixed issue-list and server-clamped metadata pagination, issue-specific label updates, issue state-transition verification, UTF-8/job-log truncation, dashboard abort/repository races and privacy rendering, timeline cursor gaps, malformed reference handling, and remote base-path matching.

### Security

- Project-local Forgejo configuration and Git/SSH discovery are ignored until the project is trusted.
- Authenticated redirects cannot leave the configured API root; external links use validated HTTP(S) URLs and a shell-free Windows launcher.
- Watch notifications exclude remote bodies, titles, diffs, and raw errors; session shutdown closes active watches before runtime teardown.

## [0.3.0] - 2026-08-12

### Added

- `/fj-setup` is now a native four-step guided TUI for configuration scope, multi-server `fgj` or environment-token setup, Git remote aliases, dashboard profiles or custom preferences, final review, and atomic owner-only writes without manual JSON editing.

## [0.2.2] - 2026-08-12

### Changed

- Dashboard labels now identify authored pull-request totals explicitly as open counts.

## [0.2.1] - 2026-08-12

### Fixed

- Dashboard refresh failures now clear the failed server's cached issues, pull requests, notifications, and CI runs instead of presenting stale data.
- Changing repository context immediately clears CI runs belonging to the previous repository.

## [0.2.0] - 2026-08-12

### Changed

- Dashboard issue and pull collections now defensively discard closed results even if a Forgejo server ignores the requested `state=open` filter.
- The existing `env` credential provider is now explicitly documented and tested as the CLI-independent API-token path, including whitespace-token rejection.
- Dashboard polling now pauses when both the widget and notifications are disabled; explicit refreshes remain on demand and the status line reports sync and attention state.
- Dynamic tool loading now accepts at most four explicit domains per call instead of an all-domains shortcut, reducing accidental context growth.
- Cross-server search bodies use bounded previews, and oversized hidden tool details are compacted before session persistence.
- Always-on loader metadata and bundled skill descriptions are shorter without removing mutation safety requirements.

## [0.1.0] - 2026-08-12

### Added

- Multi-server Forgejo context resolution from local Git remotes and explicit qualified references.
- Compact TUI dashboard for assigned issues, authored pull requests, review requests, unread notifications, and failed Actions runs.
- Issue, pull request, notification, search, review, dashboard, context, and Actions tools.
- Paginated timelines and session-scoped incremental conversation cursors.
- Safe pull request readiness and merge checks with interactive confirmation.
- Forgejo Actions run, job, log, dispatch, cancel, rerun, artifact listing, and bounded download support.
- `forgejo-issue-to-pr` and `forgejo-pr-review` workflow skills.
- Environment-variable and `fgj` credential providers with redirect and secret-redaction protections.

[Unreleased]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/releases/tag/v0.1.0
