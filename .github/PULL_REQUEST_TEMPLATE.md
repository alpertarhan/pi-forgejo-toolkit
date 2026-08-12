## Summary

Describe the user-visible behavior and why this change is needed.

## Verification

List the exact commands or scenarios you ran.

## Checklist

- [ ] The change is focused and contains no unrelated refactor.
- [ ] Tests cover changed behavior or safety invariants.
- [ ] `bun run check` passes.
- [ ] User-facing documentation is updated.
- [ ] `CHANGELOG.md` is updated when the change is notable.
- [ ] Fixtures and logs contain no tokens, private repositories, or internal hostnames.
- [ ] Mutations remain server-qualified and destructive actions retain confirmation gates.
