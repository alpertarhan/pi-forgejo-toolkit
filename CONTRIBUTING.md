# Contributing

Contributions to `pi-forgejo-toolkit` are welcome. Focused bug fixes, Forgejo compatibility improvements, tests, documentation, and workflow refinements are especially useful.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a GitHub Discussion for usage questions and an issue for reproducible defects.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Never include access tokens, private repository names, internal hostnames, or unredacted API responses.

For a substantial behavior or API change, open a proposal issue first. This avoids incompatible implementations and duplicated work.

## Development setup

Requirements:

- [Bun](https://bun.sh/) 1.3.14 or newer
- Node.js 20 or newer, because Pi runs extensions in its Node.js environment
- A current [Pi](https://pi.dev/) installation
- Optional: [`fgj`](https://codeberg.org/forgejo-contrib/forgejo-cli) and a disposable Forgejo test instance for integration work

```bash
git clone https://github.com/alpertarhan/pi-forgejo-toolkit.git
cd pi-forgejo-toolkit
bun install --frozen-lockfile
bun run check
```

Load the working tree directly in Pi while developing:

```bash
PI_FORGEJO_CONFIG=/path/to/forgejo.json \
  pi --no-extensions --no-skills \
  -e ./extensions/forgejo/index.ts \
  --skill ./skills
```

Use only test accounts and repositories for mutation smoke tests.

## Project conventions

- TypeScript is strict; preserve `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` correctness.
- Reuse the existing client, reference resolver, pagination, confirmation, and output-bounding helpers.
- Keep every resource server-qualified. Two Forgejo instances can have the same owner, repository, and issue number.
- Read operations may aggregate across servers. Mutations must target exactly one resolved server and repository.
- Destructive or publication-like operations require an interactive confirmation.
- Tokens must come from an environment variable or `fgj`; never add plaintext token configuration.
- Do not forward authorization headers across redirects or send credentials to Swagger discovery routes.
- Keep model-facing output bounded and UTF-8 safe.
- Use `.example` domains and synthetic users in tests and documentation.

## Tests

Run the complete check before submitting:

```bash
bun run check
```

For focused iteration:

```bash
bun run test -- test/client.test.ts
bun run typecheck
```

Tests should defend observable behavior or a safety invariant. Prefer deterministic request-level fixtures over live network calls. A bug fix should include a regression test that fails without the fix.

## Pull requests

1. Keep the change focused and explain the user-visible result.
2. Add or update tests for changed behavior.
3. Update `README.md` for user-facing configuration or command changes.
4. Add an entry under `Unreleased` in `CHANGELOG.md` for notable changes.
5. Confirm `bun run check` passes.
6. Review the final diff for secrets, real internal hosts, generated archives, and unrelated changes.

Maintainers may request changes when a contribution weakens confirmation gates, server identity, credential isolation, or output bounds.

## Release process

Releases are maintainer-only:

1. Update the version in `package.json` and the release notes in `CHANGELOG.md`.
2. Run `bun install --frozen-lockfile` and `bun run check`.
3. Merge the release commit to `main`.
4. Publish a GitHub release tagged `v<version>`.
5. The trusted `release.yml` workflow validates the tag and publishes that version to npm with provenance.

The initial npm release is created manually so the package can be linked to its GitHub trusted publisher.
