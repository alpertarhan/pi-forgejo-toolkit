---
name: forgejo-issue-to-pr
description: "Implements a Forgejo issue end to end: reads its discussion, changes and verifies the local repository, pushes a branch, and opens a linked draft pull request. Use when the user asks to solve or implement a Forgejo issue."
---

# Forgejo Issue to Pull Request

## Invariants

- Resolve the issue to a server-qualified reference before changing code. Never infer between two matching Forgejo remotes.
- Keep the issue's acceptance criteria, constraints, comments, labels, and dependencies in scope.
- Use local `git` for branches, commits, rebases, and pushes. Use Forgejo tools for server resources.
- Do not claim verification that was not run.
- Do not close the issue. Link it from the pull request.
- Treat Actions mutations as separate user decisions. Do not dispatch, cancel, or rerun a workflow merely to make a pull request green.
- Never echo workflow-dispatch input values into the conversation; the confirmation dialog is the only place that should show them.

## Workflow

1. Call `forgejo_context` with `current`. If the target is not explicit and the repository is ambiguous, stop and ask the user to choose a server/repository.
2. Call `forgejo_issue` with `get` for the qualified issue reference. Read the complete issue body and discussion comments from the model-facing result.
3. Call `forgejo_issue` with `timeline`, `page: 1`, and an explicit `limit`. Follow `Next page` until `Has more: no`. If a page reports `Truncated: yes`, repeat that page with a smaller limit or narrower `since`/`before` bounds. Keep state changes, title edits, labels, assignees, dependencies, references, and follow-up comments in scope. Extract observable acceptance criteria only after both the snapshot and timeline are complete.
4. Inspect the local repository conventions and current Git state. Preserve unrelated user changes. Create a focused branch from the intended base branch.
5. Reproduce the bug or establish the missing behavior before editing when the issue is a defect.
6. Implement the smallest complete source fix. Update every affected caller and remove obsolete paths rather than adding compatibility shims.
7. Run the narrow behavioral verification that exercises the changed path. Add a permanent test only when the new observable contract is otherwise uncovered.
8. Review the final local diff for unrelated changes, secrets, generated artifacts, and incomplete placeholders.
9. Commit with a message that references the qualified issue. Push the branch to the Forgejo remote that belongs to the resolved server.
10. Call `forgejo_actions` with `list`, the pushed `head_sha`, and an explicit limit. For each relevant failed run, call `jobs`, then fetch only the failed job logs with `job_log` and a bounded `max_bytes`. Do not infer success from the absence of a run.
11. If the repository requires `workflow_dispatch` and the user requested it, first call `forgejo_context` with `capabilities`, then call `forgejo_actions` with `dispatch`, the exact workflow filename, ref, and complete string-valued inputs. Let the tool show its interactive confirmation. Never substitute a dispatch for a missing push-triggered run without evidence that this is the repository's intended workflow.
12. For a run whose artifact is needed as verification evidence, call `artifacts` with its `run_id`, inspect `artifact` metadata, and call `download_artifact` only into a deliberate workspace path. Never set `overwrite: true` unless replacing that exact file was explicitly requested.
13. Call `forgejo_pull` with `create`, `draft: true`, the pushed head branch, target base, and a body containing:
   - the qualified issue reference and web link,
   - a concise change summary,
   - exact local and Forgejo Actions verification commands and results,
   - known limitations, including an unavailable or still-running workflow.
14. Call `forgejo_pull` with `get` on the returned pull request and report its server-qualified reference and URL.

If a failed run is safe to rerun or a running job must be cancelled, report the exact run ID, workflow, ref, and current status first. Call `rerun` or `cancel` only after the user explicitly requests that mutation; the tool's capability check and interactive confirmation still apply.

If push credentials or repository permissions fail, keep the verified local branch intact and report the exact failed operation. Do not open a pull request pointing to an unpushed head.
