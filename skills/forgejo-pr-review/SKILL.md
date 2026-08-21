---
name: forgejo-pr-review
description: "Review a Forgejo pull request using metadata, diff, checks, reviews, and local code; draft inline findings and submit only on explicit request."
---

# Forgejo Pull Request Review

## Review contract

- Review the exact server-qualified pull request and head commit.
- Prioritize correctness, regressions, security, concurrency, data loss, error handling, and missing behavioral coverage. Avoid style-only comments unless they hide a defect.
- Every finding must identify an observable failure mode and point to the relevant changed line or file.
- Do not publish comments during analysis. Build one local review draft, preview it, then submit through the confirmation gate.
- Review is read-only until the final review submission. Never dispatch, cancel, or rerun Actions while gathering evidence.

## Workflow

1. Call `forgejo_tools` with `domains: ["pull", "review", "actions"]` so only the Forgejo capabilities required by this workflow are activated.
2. Resolve the target with `forgejo_context` when necessary. Never use an unqualified number when the local repository context is ambiguous.
3. Call `forgejo_pull` with `get` and record the returned head SHA. Call `timeline`, `files`, and `commits` from page 1 with explicit limits; follow `Next page` until `Has more: no`. Call `diff` and `readiness` for the same pull request. If any result reports truncation, repeat with a smaller page limit or narrower timeline bounds rather than reviewing partial context.
4. Treat the pull timeline as the canonical conversation and update stream. Read normal discussion comments, pushes, review requests, state changes, and target-branch changes before evaluating the diff.
5. Call `forgejo_review` with `list`. Read each review body. For each relevant review with inline comments, call `get` using its `review_id` so the file path, diff hunk, commit, resolver, and body are visible. Keep stale or dismissed reviews as historical context, but do not count them as current approval or blockers.
6. Call `forgejo_actions` with `list`, the recorded `head_sha`, and an explicit limit. For each relevant failed run, call `jobs`, then fetch only failed job logs using `job_log` with a bounded `max_bytes`. If an artifact is material to the review, call `artifacts` with the run ID and inspect `artifact` metadata; download it only to a deliberate workspace path and never overwrite an existing file during review.
7. Inspect the affected local symbols and their callers. Check behavior outside the visible diff when a changed contract has downstream effects.
8. Validate each suspected finding against repository code, tests, configuration, Forgejo metadata, and relevant Actions evidence. A missing run is unknown, not success. Discard speculative findings that lack a concrete failure path.
9. Choose a verdict:
   - `REQUEST_CHANGES` for one or more blocking defects.
   - `COMMENT` for non-blocking findings or questions.
   - `APPROVED` only when no blocking defect remains.
10. Call `forgejo_review` with `create_draft`. Write a concise body that leads with findings and includes the reviewed head SHA.
11. Add each actionable inline finding with `add_inline_comment`, using the changed file path and correct new or old line position.
12. Call `forgejo_review` with `preview`. Present the complete verdict, summary, and inline comments to the user.
13. Call `forgejo_review` with `submit` only when the user requested publication. The tool must still show its interactive confirmation. If the PR head changed, discard or rebuild the stale draft and re-review the new snapshot, timeline, diff, and Actions runs.

When there are no findings, state what was inspected and any verification limits. Do not invent a finding to justify the review. If the user later asks to rerun or cancel a workflow, handle that as a separate mutation using the exact run ID and the tool's capability check and interactive confirmation.
