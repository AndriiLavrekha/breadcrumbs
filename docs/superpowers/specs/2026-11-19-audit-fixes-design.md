# Audit fixes — design

Source: `docs/breadcrumbs_audit_2026-11-19.md` (items 1–20). Verified against the code on 2026-11-19; line references matched.

## Intent

Fix the audit's findings so the privacy guard, resume warnings, MCP reads and release packaging behave as documented. The audit is the spec; this doc records the decisions made on top of it.

## Goals / non-goals

- Goals: fix items 1–20, each with a focused Vitest test (AGENTS.md); `dist/` rebuilt in every PR that changes `src/`.
- Non-goals: the five "Left out" minor items; any new feature; any dependency addition.
- Anti-goal: a fix that passes its test but still lets a private Progress.md reach a commit.

## Approaches (chosen: six small PRs)

1. One large PR — rejected: hard to review, hooks and release packaging are unrelated risks.
2. Six PRs grouped by file ownership — **chosen** (user approved 2026-11-19).
3. One PR per audit item — rejected: items 3+4 share the session-state change, and 17 touches many files.

| PR | Items | Scope |
|---|---|---|
| 1 Deletions | 16, 19, 8 | Remove standalone hook CLI, its wrappers, `hook` and `build:mcp` scripts and docs sections, `.superpowers/sdd/task-*-report.md`, `misc/apt-logo.png`. Item 8 is closed by the deletion: the CLI's wrapper `hooks/project-progress-check.sh` is the only tracked `.sh`, so no `.gitattributes` is added. |
| 2 Hooks | 1, 3, 4, 11, 20 | Commit guard handles `-a`/`--all`/`git add` and fails closed (ADR 0009); Stop saves HEAD at start and counts HEAD movement as work; SessionStart keeps an existing state file; secret scan covers all `project-progress/*.md`; delete session files older than 30 days. Fix the mislabeled test at `cc-adapter.test.ts:1146`. |
| 3 MCP server | 5, 6, 7, 10, 12, 18 | `read_project_progress` re-reads the file; `replaceFrontmatterValue` uses a replacer function; plain temp+rename write for `projects.json` / `project-state.json` and an unreadable index treated as empty; all three frontmatter-writing tools set `updated`; exact path before the root walk, matches saved with `upsertIndexedProject`; drop `textResult` JSON round trip. |
| 4 CLI | 9, 13 | `init` without `--force` creates only missing files; `doctor` uses `indexDir()` and `W_OK`. |
| 5 Release | 2, 14, 17 | Pin dependencies to lockfile versions (`^1.29.0`, `^4.4.3`, dev tools pinned); add CI (`npm ci`, typecheck, test, build, `git diff --exit-code dist`); single source for section and status lists and `pathExists`. |
| 6 Own progress file | 15 | Decide tracked vs ignored, fix path, stale text and dead links, move finished items to Done, bring Remaining Work under budget. |

## Decisions made on top of the audit

- Item 2: the package is **not published yet**. PR 5 pins dependencies and adds CI only. Changing the generated install command to `@andriilavrekha/breadcrumbs@${PACKAGE_VERSION}` and deleting the `npm_config_allow_git` workaround waits until after the first publish.
- Item 7: `writeFileAtomic` is a compare-and-swap writer for an existing file, so it is not reused. A plain atomic-write helper is added. Rename fixes torn writes only; a lost update between two sessions remains possible. Accepted for the index (rebuildable cache). For `project-state.json` (opt-outs) the plan decides between a retry-on-change read-merge-write and accepting the race.
- Item 8: committed blobs are already LF (`i/lf w/crlf`); only the working tree is CRLF, so renormalizing is probably a no-op.
- Item 10: also covers the third writer at `server.ts:548-555`, from one shared place.
- Item 4 assumes `session_id` survives compaction (unverified). The fix is safe either way.

## Constraints

- `node_modules` on the Windows host has only Linux bindings: run tests, typecheck and build in WSL.
- Local `main` is treated as the audited tree (line references match; `afcda15`/v0.8.1 in the audit header is stale).

## Left to the builder

Exact helper names and placement; test file layout under `tests/hook`, `tests/mcp`, `tests/plugin`; whether the `project-state.json` race gets a fix or a documented shortcut.

## Follow-up after the final review

Branch `fix/audit-deferred-minors` fixes the minors the final review deferred:

- Stop reads the HEAD reflog from the offset recorded at start. Switching branches, reset, pull, clone, fast-forward merges and rebase start/finish lines are not work; every other action is, so an unknown variant errs toward the reminder. The first commit of an empty repository counts.
- Uncommitted work is a change against a tree fingerprint taken at start (as in ADR 0007 for Hermes), so leftovers from an earlier session do not make a read-only session look like work.
- A read-only session restores the `session_id` it found, along with the handoff.
- `set_project_gates` refreshes the index; a `projects.json` holding `null` reads as empty; a bare project name is tried as a folder under the server cwd only after root discovery (ADR 0023 order), so a same-named folder there cannot shadow a project in the roots.
- Item 8 now has a `.gitattributes` (`* text=auto eol=lf`), so a Windows build matches the committed `dist/`.

Still open: pathspec magic such as `:(glob)` in `git add` is not understood by the commit guard, and the `project-state.json` lost-update race is accepted.
