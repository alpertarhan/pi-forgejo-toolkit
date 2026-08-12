# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/releases/tag/v0.1.0
