# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 20 findings in `docs/breadcrumbs_audit_2026-11-19.md` as six small PRs.

**Architecture:** One branch and PR per section below, each cut from `main` and merged before the next starts (PR 5 touches files that PRs 2 and 3 change). Every behavior change gets a failing test first. `dist/` is committed, so every PR that touches `src/` rebuilds it.

**Tech Stack:** TypeScript ESM, Vitest, Node. Tests, typecheck and build run in WSL (the Windows `node_modules` has only Linux bindings).

**Spec:** `docs/superpowers/specs/2026-11-19-audit-fixes-design.md` (decisions) and `docs/breadcrumbs_audit_2026-11-19.md` (findings, items 1–20).

## Global Constraints

- Code style per `AGENTS.md`: ESM with explicit `.js` import specifiers, two-space indent, semicolons, double quotes.
- Verification command used in every PR (call it **VERIFY**): `wsl bash -lc "cd /mnt/c/depot/breadcrumbs && npm run typecheck && npm test && npm run build"`. Expected: typecheck clean, all tests pass, build clean. Then `git status --short dist` must show only intended `dist/` changes.
- Commit subjects are Conventional Commits (`fix:`, `chore:`, `refactor:`). Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Open PRs only after the user asks.
- No new dependencies. No changes to the generated MCP install command (`PACKAGE_SPEC`, `npm_config_allow_git`) until after the first npm publish (deferred, see end).
- Branch names: `fix/audit-1-deletions`, `fix/audit-2-hooks`, `fix/audit-3-mcp`, `fix/audit-4-cli`, `chore/audit-5-release`, `chore/audit-6-own-progress`.

## Review Focus

Failure modes the audit implies that a user would hit first; each is pinned by a test in the task named.

1. `git commit -am "x"` and `git add -A && git commit` with a restricted Progress.md must be denied, while `git commit -m "fix a bug"` and `git commit --amend` must not be (Task 2.1).
2. A session that is compacted (SessionStart fires twice for one `session_id`) and updated Progress.md before the end must not get a false "not updated" block (Task 2.2).
3. A read-only session must leave `handoff` as it was at start, not `interrupted` (Task 2.3).
4. A milestone like `costs $5, then $'` must round-trip through `mark_project_status` unchanged with no duplicated keys (Task 3.2).
5. A truncated `projects.json` must not break every MCP tool (Task 3.3).
6. `init` in a folder that already has `Session Log.md` but no `Progress.md` must not wipe the log (Task 4.1).

---

## PR 1 — Deletions (items 16, 19, and 8)

Item 8 (CRLF in `hooks/project-progress-check.sh`) is closed by this PR: that script is the only `.sh` file tracked in the repo, so no `.gitattributes` is added.

### Task 1.1: Remove the standalone hook CLI and unused files

**Files:**
- Delete: `src/hook/cli.ts`, `tests/hook/cli.test.ts`, `hooks/project-progress-check.sh`, `hooks/project-progress-check.ps1`, `dist/src/hook/cli.js`, `.superpowers/sdd/task-2-report.md`, `.superpowers/sdd/task-3-report.md`, `misc/apt-logo.png`
- Modify: `package.json` (remove the `hook` and `build:mcp` scripts), `AGENTS.md:15` (drop `or npm run hook`), `README.md` (the wrapper sections near lines 273–281 and 364, and `README.md:325` → `npm run build`), `TESTING.md:82-87`, `agent-instructions/HOOKS.md:14`, `tests/hook/instruction-pack.test.ts:183-184` (remove the two wrapper paths from the expected list)

**Interfaces:** Produces nothing. `parseSessionDatetime` is only used inside `src/hook/cli.ts` and its test, so it goes with them.

- [ ] **Step 1:** Run `git grep -n -E "project-progress-check|hook/cli|npm run hook|build:mcp|apt-logo|\.superpowers"` and confirm the only live references are the files listed above (ADR 0017, old plans and specs are history, leave them).
- [ ] **Step 2:** `git rm` the files listed under Delete, then edit the Modify files. In the README, TESTING and HOOKS docs remove only the sections that describe the wrappers or the `hook` script.
- [ ] **Step 3:** Run VERIFY. Expected: all pass; `instruction-pack.test.ts` passes with the shortened list.
- [ ] **Step 4:** Re-run the grep from Step 1. Expected: no matches outside `docs/adr`, `docs/superpowers`, and the audit file.
- [ ] **Step 5:** Commit `chore: remove unused standalone hook CLI, wrappers and stale files`.

---

## PR 2 — Hooks (items 1, 3, 4, 11, 20)

All in `src/hook/cc-adapter.ts` and `src/hook/validator.ts`. Tests go in `tests/plugin/cc-adapter.test.ts` (helpers `makeRepo`, `writeProgress`, `progressDoc`, `commitAll`, `withTrackerHome` already exist) and `tests/hook/validator.test.ts`.

### Task 2.1: Commit guard covers `-a` and `git add`, and fails closed (item 1)

**Files:** Modify `src/hook/cc-adapter.ts:375-407` (`handlePreCommit`), `hooks/hooks.json:31` (the `if` filter, see Step 5). Test `tests/plugin/cc-adapter.test.ts`.

**Interfaces:** Produces `function commitMayStageProgress(command: string): boolean` (module-private): true when the command contains `--all`, a short-flag group containing `a` as its own token (`-a`, `-am`, `-ma`), or `git add`. A `-m` message text must not trigger it.

- [ ] **Step 1: Write failing tests** (each builds a repo whose committed Progress.md has `sensitivity: sensitive`, then calls `handlePreCommit({ cwd, tool_input: { command } })` and parses `stdout`):
  - `denies git commit -am when restricted progress has unstaged changes` — edit Progress.md after the commit; command `git commit -am "x"`; expect `hookSpecificOutput.permissionDecision === "deny"`.
  - `denies git add -A && git commit when restricted progress is untracked or modified` — same, command `git add -A && git commit -m x`.
  - `allows git commit -m with the letter a in the message` — command `git commit -m "fix a bug"` with Progress.md modified; expect `stdout` undefined.
  - `does not treat --amend as -a` — command `git commit --amend -m x`; expect `stdout` undefined.
  - `denies a commit when git cannot be inspected` — `cwd` is a plain temp dir (not a repo) holding a sensitive Progress.md; command `git commit -m x`; expect deny.
  - `denies a commit when Progress.md cannot be read` — make `project-progress/Progress.md` a directory; expect deny.
- [ ] **Step 2:** Run `wsl bash -lc "cd /mnt/c/depot/breadcrumbs && npx vitest run tests/plugin/cc-adapter.test.ts -t \"commit\""`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `handlePreCommit`: wrap the frontmatter read in try/catch and deny on failure; when restricted, treat a `null` result from `git(cwd, ["diff", "--cached", "--name-only"])` as indeterminate and deny; when `commitMayStageProgress(command)` is true, also run `git(cwd, ["status", "--porcelain", "--", "project-progress"])` and deny if it is non-null and non-empty, or null. Reuse the existing `emitJson` deny payload; change the reason text to mention both staged and about-to-be-staged files. `stagedFiles` must stop converting `null` into `[]` (return `string[] | null`; its only caller is this handler). Add a one-line `shortcut:` comment: any change under `project-progress/` blocks, not only files the command would stage.
- [ ] **Step 4:** Re-run the Step 2 command. Expected: PASS.
- [ ] **Step 5: Verify the hook filter.** `hooks.json` runs this hook only when `if: Bash(git commit:*)` matches. Ask the `claude-code-guide` agent whether that matcher matches a compound command (`git add -A && git commit -m x`). If it does not, or the answer is not documented, delete the `"if"` line (the handler's `isCommitCommand` already classifies commands) and mention the extra process spawn per Bash call in the PR body.
- [ ] **Step 6:** Commit `fix: block commit -a and git add when progress is restricted, fail closed`.

### Task 2.2: SessionStart keeps the existing baseline (item 4)

**Files:** Modify `src/hook/cc-adapter.ts:109-116` (`recordSessionStart`). Test `tests/plugin/cc-adapter.test.ts`.

- [ ] **Step 1: Failing test** `keeps the first baseline when SessionStart fires again for the same session` — repo with committed Progress.md; `handleSessionStart({cwd, session_id: "s"})`; write `src.txt`; update the Progress.md body (change Next Action text) through `fs.writeFile`; call `handleSessionStart` again with the same id; call `handleStop`. Expect `result.code === 0`, `result.stdout` not containing `"was not updated"`, and `handoff` equal to `clean`.
- [ ] **Step 2:** Run it; expect FAIL (the second start resets the baseline, Stop returns code 2).
- [ ] **Step 3: Implement.** `recordSessionStart` returns early when `readSessionState(sessionId)` already has a `startedAt`. Both `handleSessionStart` side effects that depend on a fresh start (handoff marking, body hash) must also run only once: check `handleSessionStart` and guard them with the same condition so a re-run does not overwrite `bodyHash` or set `handoff: interrupted` again.
- [ ] **Step 4:** Run it; expect PASS. Run the whole file; expect PASS.
- [ ] **Step 5:** Commit `fix: keep session baseline when SessionStart repeats after compaction`.

### Task 2.3: Stop counts commits and restores the start handoff (item 3)

**Files:** Modify `src/hook/cc-adapter.ts` (`SessionState`, `recordSessionStart`, `handleStop` at line ~446). Test `tests/plugin/cc-adapter.test.ts`.

**Interfaces:** `SessionState` gains `headAtStart?: string` (`git(cwd, ["rev-parse", "HEAD"])?.trim()`) and `handoffAtStart?: string` (the frontmatter `handoff` value read before SessionStart marks `interrupted`). Both are written once, by `recordSessionStart` (so Task 2.2 must land first).

- [ ] **Step 1: Failing tests:**
  - `treats a moved HEAD as work` — start session, commit a file (tree clean, Progress.md body untouched), `handleStop`; expect `code === 2` and stderr containing `"not updated"`.
  - `restores the handoff recorded at start when no work happened` — Progress.md committed with `handoff: clean`; start; `handleStop` with no changes; expect `handoff === "clean"`.
  - `records a clean handoff outside a git repository after Progress.md is updated` — **replace** the mislabeled test at `tests/plugin/cc-adapter.test.ts` (the one named `still records a clean handoff outside a git repository`, which never calls Stop and expects `interrupted`): temp dir with no git, start, change the Progress.md body, `handleStop`, expect `clean`.
- [ ] **Step 2:** Run; expect the first two FAIL and the third FAIL.
- [ ] **Step 3: Implement.** In `handleStop` replace the early `if (!gitHasChanges(cwd)) return` with: `worked = gitHasChanges(cwd) || headMoved || bodyChanged`, where `headMoved` compares `state.headAtStart` with the current HEAD and `bodyChanged` compares `bodyHash(currentMarkdown)` with `state.bodyHash`. When `!worked`: if `state.handoffAtStart` is defined and differs from the current `handoff`, write it back with `bestEffortMarkHandoff`-style replace (do not change `session_id`), then return `{ code: 0 }`. The rest of `handleStop` is unchanged.
- [ ] **Step 4:** Run; expect PASS; then VERIFY for the file.
- [ ] **Step 5:** Commit `fix: count commits and progress edits as work in Stop, restore start handoff`.

### Task 2.4: Secret scan covers every progress file (item 11)

**Files:** Modify `src/hook/validator.ts:36-56` (`validateProgressFile`). Test `tests/hook/validator.test.ts`.

- [ ] **Step 1: Failing test** `flags secret-like values in Session Log.md` — temp `project-progress/` with a valid Progress.md and a `Session Log.md` containing `password = hunter2pass`; expect `validateProgressFile` errors to include `Found secret-like value: generic password assignment`. A second case, `reports each secret label once across files`, puts the same label in two files and expects one error.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.** After reading Progress.md, read every other `*.md` directly inside `path.dirname(progressPath)` and run `SECRET_PATTERNS` over the concatenated text (frontmatter and section checks stay Progress.md-only). Unreadable sibling files are skipped.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `fix: scan all project-progress markdown files for secrets`.

### Task 2.5: Prune old session files (item 20)

**Files:** Modify `src/hook/cc-adapter.ts` (new `pruneSessionState(now: number): Promise<void>`, called from `recordSessionStart`, best effort). Test `tests/plugin/cc-adapter.test.ts`.

- [ ] **Step 1: Failing test** `removes session state files older than 30 days at SessionStart` — create `<os.tmpdir()>/awesome-progress-tracker/sessions/old-test.json`, `fs.utimes` it 31 days back, create a fresh `new-test.json`; call `handleSessionStart`; expect the old file gone and the fresh one present.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement** `pruneSessionState`: `readdir(sessionStateDir())`, `stat` each `.json`, `rm` when `mtimeMs < now - 30*24*3600*1000`; swallow all errors.
- [ ] **Step 4:** Run; expect PASS. Run VERIFY.
- [ ] **Step 5:** Commit `chore: prune session state files older than 30 days`.

---

## PR 3 — MCP server (items 5, 6, 7, 10, 12, 18)

### Task 3.1: `read_project_progress` reads the file (item 5)

**Files:** Modify `src/mcp/server.ts:421-425`. Test `tests/mcp/server.test.ts` (follow its `Client` + `InMemoryTransport` pattern).

- [ ] **Step 1: Failing test** `read_project_progress returns the current file, not the indexed copy` — write a Progress.md, index it with `writeProjectIndex`, then edit the file's Next Action on disk; call the tool; expect `structuredContent.nextAction` to be the new text.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.** After `resolveProject`, read `match.progressPath` and return `boundProjectSummaries([parseProjectSummary(markdown, match.progressPath)])[0]`. If the read throws, return `errorResult("read_failed", "Could not read <path>.", "Check the file exists, or run refresh_projects.")`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `fix: read_project_progress reads Progress.md instead of the cached summary`.

### Task 3.2: Literal `$` in frontmatter values (item 6)

**Files:** Modify `src/mcp/writer.ts:227`. Test `tests/mcp/writer.test.ts`.

- [ ] **Step 1: Failing test** `replaceFrontmatterValue treats $ sequences literally` — for values `keep $' here`, `cost $$5`, `a $& b`, call `replaceFrontmatterValue(doc, "last_milestone", value)` and expect `parseFrontmatter(result).last_milestone === value` and exactly one `status:` line.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement:** `frontmatter.replace(keyPattern, () => replacement)`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `fix: stop $ sequences in frontmatter values from being expanded`.

### Task 3.3: Atomic JSON writes and tolerant reads (item 7)

**Files:** Create `src/fs-util.ts` exporting `writeTextAtomic(filePath: string, text: string): Promise<void>` (write `.<name>.<pid>.<Date.now()>.tmp` in the same directory, then `fs.rename`, remove the temp file on failure). Modify `src/mcp/index.ts:94-122` (`readProjectIndex` returns the empty index when the file cannot be parsed; `writeProjectIndex` uses `writeTextAtomic` for both files), `src/project-state.ts:53-72` (`readStateFile` treats a `SyntaxError` or invalid shape as empty, still rethrows other non-`ENOENT` errors; `writeStateFile` uses `writeTextAtomic`), `src/hook/cc-adapter.ts:~300` (skip `bestEffortSetProjectState` when `bestEffortReadProjectState(cwd)` is already `"initialized"`). Tests `tests/mcp/index.test.ts`, new `tests/project-state.test.ts`, and `tests/plugin/cc-adapter.test.ts`.

**Interfaces:** Does not reuse `writeFileAtomic` (it needs an existing file and an expected hash). Add a `shortcut:` comment on `setProjectTrackingState`: temp+rename prevents torn files but two sessions writing at the same moment can still lose one update; acceptable because writes happen once per project per session, revisit if opt-outs go missing.

- [ ] **Step 1: Failing tests:**
  - `readProjectIndex returns an empty index when projects.json is truncated` (write `{"schemaVersion":1,"proj` to the file).
  - `writeProjectIndex leaves no temp files behind` (after the write, the index dir lists only `projects.json` and `projects.md`).
  - `readProjectTrackingState returns unknown when the state file is corrupt`, and `setProjectTrackingState recovers from a corrupt state file`.
  - `SessionStart does not rewrite project-state.json when already initialized` (record the file's mtime after the first start, wait 20 ms, start a second session, expect the same mtime).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement as described under Files.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `fix: write index and project state atomically, tolerate corrupt files`.

### Task 3.4: MCP writes set `updated` (item 10)

**Files:** Modify `src/mcp/server.ts` at the three `writeFileAtomic` call sites for frontmatter changes: `update_project_progress` (~line 459), `mark_project_status` (~line 506), and the multi-key gates update (~line 548, built from `gateFrontmatterUpdates`). Move `todayIso` from `src/cli.ts:214` into `src/mcp/writer.ts` as an export and import it in both places. Test `tests/mcp/server.test.ts`.

- [ ] **Step 1: Failing test** `MCP write tools set updated to today` — for each of the three tools, start from a Progress.md with `updated: 2020-01-01`; after the call expect `parseFrontmatter(...).updated === todayIso()`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement:** apply `replaceFrontmatterValue(markdown, "updated", todayIso())` before each write.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `fix: MCP write tools update the updated date`.

### Task 3.5: `resolveProject` order and caching (item 12)

**Files:** Modify `src/mcp/server.ts:217-236`. Test `tests/mcp/server.test.ts`.

- [ ] **Step 1: Failing test** `resolveProject saves projects found by scanning roots` — empty index, `PROJECT_PROGRESS_ROOTS` containing one project; call `resolveProject(name)`; then `readProjectIndex()` must contain that project's `progressPath`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement:** move the literal-path block above the root walk; after the walk, `upsertIndexedProject` each match. The existing literal-path tests (ADR 0023) must keep passing.
- [ ] **Step 4:** Run the whole `tests/mcp` folder; expect PASS.
- [ ] **Step 5:** Commit `fix: resolve exact paths before scanning roots and cache scan results`.

### Task 3.6: Remove the JSON round trip (item 18)

**Files:** Modify `src/mcp/server.ts:379-389` and its 16 `textResult(JSON.stringify(...))` call sites.

**Interfaces:** Produces `function invalidRequest(message: string)` returning `errorResult("invalid_request", message, "Correct the request and retry.")`. Success sites call `successResult(payload, JSON.stringify(payload))`. Delete `textResult`.

- [ ] **Step 1:** No new test: the existing server tests assert result shape (`isError`, `structuredContent`, error code `invalid_request`). Run `npx vitest run tests/mcp/server.test.ts` first; expect PASS (baseline).
- [ ] **Step 2:** Convert every call site; `git grep -n textResult src` must return nothing.
- [ ] **Step 3:** Run VERIFY. Expected: same results as the baseline.
- [ ] **Step 4:** Commit `refactor: build MCP tool results directly instead of re-parsing JSON`.

---

## PR 4 — CLI (items 9, 13)

### Task 4.1: `init` without `--force` keeps existing files (item 9)

**Files:** Modify `src/cli.ts:246-270` (`initProject`). Test `tests/mcp/cli.test.ts` (update any existing test that expects the throw for an existing folder).

- [ ] **Step 1: Failing tests:**
  - `initProject without force creates only missing files` — folder has a custom `Session Log.md`; `initProject({ cwd })` resolves, `Progress.md` now exists, and `Session Log.md` content is unchanged.
  - `initProject without force still throws when every template file exists` — error message contains `Use --force`.
  - `initProject with force overwrites every template file` (keep/adjust the existing test).
- [ ] **Step 2:** Run; expect the first FAIL.
- [ ] **Step 3: Implement:** remove the directory-level throw; in the loop skip existing files when `!options.force`; after the loop, if nothing was created and `!options.force`, throw the existing "already exists ... Use --force" error. `createdFiles` lists only files actually written.
- [ ] **Step 4:** Run; expect PASS. Check the `init` command output in `src/cli.ts` still reads correctly with a partial `createdFiles`.
- [ ] **Step 5:** Commit `fix: init fills in missing files and never overwrites without --force`.

### Task 4.2: `doctor` checks the real index folder (item 13)

**Files:** Modify `src/cli.ts:779-790` (`checkIndexWritable`) and its caller in `runDoctor`. Test `tests/mcp/cli.test.ts`.

**Interfaces:** `checkIndexWritable(homeDir?: string)` uses `indexDir(homeDir)` from `src/mcp/index.ts` (which honors `AWESOME_PROGRESS_TRACKER_HOME` when `homeDir` is undefined) and `fs.access(dir, fs.constants.W_OK)`. `runDoctor` passes `options.homeDir` (the explicit override), not the HOME fallback it computes for other checks.

- [ ] **Step 1: Failing tests:** `doctor index check honors AWESOME_PROGRESS_TRACKER_HOME` (env set to a temp dir, no `homeDir` option; the check message contains that directory) and `doctor index check fails when the folder is not a writable directory` (env points at a path whose parent is a regular file; expect `ok === false`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement as described.
- [ ] **Step 4:** Run; expect PASS. Run VERIFY.
- [ ] **Step 5:** Commit `fix: doctor checks the folder the index really uses and requires write access`.

---

## PR 5 — Release prep (items 2, 14, 17)

### Task 5.1: Pin dependencies (item 2, first half)

**Files:** Modify `package.json:47-55`, `package-lock.json`. Test `tests/plugin/manifests.test.ts`.

- [ ] **Step 1: Failing test** `package.json has no "latest" version ranges` — read `package.json`; every value in `dependencies` and `devDependencies` is not `"latest"`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.** Set `@modelcontextprotocol/sdk` to `^1.29.0`, `zod` to `^4.4.3`, and pin `@types/node` `26.0.1`, `typescript` `6.0.3`, `vitest` `4.1.9` (the versions in the current lockfile). Run `wsl bash -lc "cd /mnt/c/depot/breadcrumbs && npm install"` and check the lockfile diff only changes the root `packages[""]` ranges.
- [ ] **Step 4:** Run `npm ci` in WSL, then VERIFY; expect PASS.
- [ ] **Step 5:** Commit `chore: pin dependency versions to the locked set`.

### Task 5.2: CI workflow (item 14)

**Files:** Create `.github/workflows/ci.yml`.

- [ ] **Step 1:** Write a workflow triggered on `push` to `main` and on `pull_request`, one `ubuntu-latest` job, Node version taken from `engines.node` in `package.json` (use `22` if absent), steps in order: checkout, setup-node with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, then `git diff --exit-code -- dist`.
- [ ] **Step 2:** Validate locally: run the same four npm commands plus the `git diff --exit-code -- dist` check in WSL; expected exit 0 on a clean tree.
- [ ] **Step 3:** Commit `chore: add CI for typecheck, tests, build and dist drift`.

### Task 5.3: One source for the shared lists and `pathExists` (item 17)

**Files:** Modify `src/hook/schema.ts` (move `ALLOWED_PROGRESS_SECTIONS` here from `src/mcp/writer.ts:19-30`), `src/hook/validator.ts:8-19` (delete `REQUIRED_PROGRESS_SECTIONS`, import the single list; keep an alias export only if a test imports it), `src/mcp/writer.ts` (import it), `src/mcp/server.ts:34` (`PROJECT_STATUSES` → `ALLOWED_STATUSES`), `src/mcp/schema.ts:1-8` (`export type ProjectStatus = (typeof ALLOWED_STATUSES)[number]`, `Sensitivity` likewise from `ALLOWED_SENSITIVITY`). Add `pathExists(filePath: string): Promise<boolean>` to `src/fs-util.ts` (created in Task 3.3) and delete the copies in `src/cli.ts:223`, `src/hook/validator.ts:27`, `src/mcp/discovery.ts:23`, `src/mcp/index.ts:35`, and replace `fileExists` in `src/hook/cc-adapter.ts:67` (the `src/hook/cli.ts` copy is already gone after PR 1).

- [ ] **Step 1:** Run VERIFY first; expect PASS (baseline, behavior must not change).
- [ ] **Step 2:** Apply the moves. Update any test that imports a removed export (`git grep -n REQUIRED_PROGRESS_SECTIONS tests`).
- [ ] **Step 3:** Run VERIFY; expect the same results. Check `git grep -n "function pathExists\|function fileExists" src` returns only `src/fs-util.ts`.
- [ ] **Step 4:** Commit `refactor: single source for progress sections, statuses and pathExists`.

---

## PR 6 — This repo's own Progress.md (item 15)

### Task 6.1: Untrack and correct the dogfood progress file

**Files:** `project-progress/Progress.md`, `.gitignore:7` (unchanged), git index.

**Decision for the user before starting:** recommended is to untrack the file (`.gitignore` already says it is internal session notes), which makes this PR only the untracking commit. The alternative (track it) means deleting `/project-progress/` from `.gitignore` and committing the corrected file.

- [ ] **Step 1:** Ask the user which option. Then, if untracking: `git rm --cached project-progress/Progress.md` (and any other tracked files under `project-progress/`; list them first with `git ls-files project-progress`).
- [ ] **Step 2:** Correct the file's content with the MCP `update_project_progress` / `mark_project_status` tools or an editor: frontmatter `path` to this repo's real path; remove the Resume Instructions link to `docs/superpowers/specs/2026-06-26-project-progress-design.md`; rewrite Current State (it still says "no standalone CLI" and "Python validation"); move the finished items (compaction spec review, ADR 0016/0017 release) to Done; trim Remaining Work to at most 4000 characters.
- [ ] **Step 3: Verify.** Run `wsl bash -lc "cd /mnt/c/depot/breadcrumbs && node -e \"import('./dist/src/hook/validator.js').then(async m => console.log(await m.validateProgressFile('project-progress/Progress.md')))\""`. Expected: `[]`. Then start a new session or run the SessionStart hook and confirm the health line no longer mentions the 4000-character budget.
- [ ] **Step 4:** Commit `chore: untrack dogfood progress file` (content edits stay local when untracked).

---

## Deferred until after the first npm publish

- `PACKAGE_SPEC` (`src/cli.ts:25`) and the MCP config writers (`src/cli.ts:341-351, 392-402, 571-584`) switch to `@andriilavrekha/breadcrumbs@${PACKAGE_VERSION}`, and the `npm_config_allow_git=all` workaround is removed, with updated tests in `tests/mcp/cli.test.ts`.
- Record this in Progress.md Next Action so it is not lost.

## Self-review notes

- Spec coverage: items 1–20 each map to a task (8 closed by Task 1.1; 2 split between 5.1 and the deferred section; 15 to 6.1). The five "left out" audit items are out of scope per the spec.
- Task 2.2 must merge before 2.3 because both change `recordSessionStart`; Task 3.3 creates `src/fs-util.ts` that Task 5.3 extends.
- Open verification inside the plan: Task 2.1 Step 5 (does the `if: Bash(git commit:*)` hook filter match compound commands). Task 2.2 assumes `session_id` survives compaction; the fix is safe if it does not.
