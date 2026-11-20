# Breadcrumbs Audit — 2026-11-19

- **Scope:** whole repo at `afcda15` (v0.8.1), branch `main`.
- **Type:** read-only audit. No code was changed.
- **Load assumed:** one developer, with several agent sessions open at once on one machine. Each session has its own MCP server and its own hook processes.

## What this repo does

Breadcrumbs keeps the state of a project in `project-progress/Progress.md`, so that a later agent session can continue the work. It has three parts: hooks for Claude Code and Codex, an MCP server that indexes projects across folders, and a CLI that installs everything for Claude, Codex and Hermes.

## Must fix

### 1. The commit guard lets `git commit -am` through

`src/hook/cc-adapter.ts:375-407`

- **What this is:** Progress.md can say `sensitivity: sensitive` or `commit_progress: false`. Then this hook must stop any commit that contains progress files.
- **Problem:** The hook checks the staged files before the command runs. With `git commit -am x`, or `git add -A && git commit` in one command, nothing is staged yet, so the private progress goes into the commit.
- **Fix:** If the policy is restricted, also block when `git status --porcelain -- project-progress` shows changes and the command has `-a`, `--all` or `git add`. Add a test for `-am`. Also, the hook allows the commit when it gets an error, but ADR 0009 says it must block.
- **If we skip it:** The privacy feature fails silently in the most common commit forms.

### 2. The MCP server runs code with no fixed version

`src/cli.ts:25`, `src/cli.ts:341-351`, `src/cli.ts:392-402`, `src/cli.ts:571-584`, `package.json:47-55`

- **What this is:** `install` writes an MCP config that starts `npx -y github:AndriiLavrekha/breadcrumbs mcp`.
- **Problem:** That command runs the newest commit on `main`, and all dependencies are `"latest"`. npm ignores your lockfile when users install the package. A new major version of the MCP SDK or zod can break the `.../server/mcp.js` and `zod/v4` imports at the next start.
- **Fix:** After the npm publish, use `@andriilavrekha/breadcrumbs@${PACKAGE_VERSION}` (the Hermes skill URL is already pinned this way). Use `^1.29.0` and `^4.4.3` from the lockfile, and pin the dev tools too. Then delete the `npm_config_allow_git=all` workaround.
- **If we skip it:** One bad push or one upstream major release breaks the MCP server for all users. It also goes against ADR 0014 ("immutable" versions).

### 3. The Stop check looks at the working tree, not at the session

`src/hook/cc-adapter.ts:453`

- **What this is:** At session end, the hook checks that Progress.md was updated. Then it writes `handoff: clean` and a new `base_commit`.
- **Problem:** It stops early when git shows no changes outside `project-progress/`. Then three kinds of session never get `clean` or a new checkpoint: sessions that commit their work, read-only sessions, and projects with no git. Committed work with no progress update is also never flagged. You can see this in this repo now: `base_commit` is 18 commits behind, and the session on 2026-11-19 started with a false "no clean handoff" warning.
- **Fix:** Save `HEAD` in the session state at the start, and count "HEAD moved" as work. If no work happened, put back the `handoff` value that was there at start. The test at `tests/plugin/cc-adapter.test.ts:1146` has a name that says "clean", but it never calls Stop and it expects `interrupted`. Fix that test too.
- **If we skip it:** Agents learn to ignore the warning, and the drift list grows with each session.

### 4. Compaction resets the session baseline

`src/hook/cc-adapter.ts:109-116`, `hooks/hooks.json:4-12`

- **What this is:** At start, the hook saves the start time and a hash of the Progress.md body. Stop compares the file with this baseline.
- **Problem:** The Claude SessionStart hook has no matcher, so it runs again after auto-compaction. When it runs, it replaces the whole state file. If the agent already updated Progress.md, the new baseline contains that update. Stop then says "not updated" and blocks again, because `stopBlocked` was also cleared.
- **Fix:** In `recordSessionStart`, keep the state file when one already exists for this `session_id`.
- **If we skip it:** Long sessions that did the right thing get a false block at the end.

### 5. `read_project_progress` returns an old copy

`src/mcp/server.ts:421-425`

- **What this is:** This MCP tool gives an agent the Resume Snapshot, Next Action and Blockers of a project.
- **Problem:** It returns the copy in `~/.awesome-progress-tracker/projects.json`, not the file itself. That copy changes only on MCP writes, `init` and `refresh_projects`. After a hand edit of Progress.md, the tool returns old text and gives no warning.
- **Fix:** After the project is found, read `match.progressPath` again and return `parseProjectSummary(...)`. This is two lines.
- **If we skip it:** A resuming agent acts on an old Next Action. Breadcrumbs exists to stop exactly this.

### 6. A `$` in a value can break the frontmatter

`src/mcp/writer.ts:227`

- **What this is:** The frontmatter is the `key: value` block at the top of Progress.md. `replaceFrontmatterValue` sets one line in it.
- **Problem:** It passes the value to `String.replace` as text, so JavaScript treats `$&`, `$'` and `$$` as special. Tested on `dist`: `last_milestone: keep $' here` adds a second `status: active` line, and `$$5` becomes `$5`.
- **Fix:** Use `frontmatter.replace(keyPattern, () => replacement)` and add one test.
- **If we skip it:** A normal milestone text, for example a price, gives duplicate keys.

### 7. Shared JSON files can be cut in half

`src/mcp/index.ts:94-122`, `src/project-state.ts:53-72`, `src/hook/cc-adapter.ts:300`

- **What this is:** All sessions on the machine share `projects.json` (the index) and `project-state.json` (opt-in and opt-out per project).
- **Problem:** The code reads each file, changes it and writes it back in place. When two sessions do this at the same time, one change is lost. A crash during a write leaves a cut file. After that, `readProjectIndex` fails on every call, so all MCP tools fail, `refresh_projects` included.
- **Fix:** Write to a temp file and rename it, as `writeFileAtomic` already does. Treat an index that cannot be read as empty, because it is only a cache. Do not write `initialized` on every SessionStart when the state is already `initialized`.
- **If we skip it:** The MCP server stays broken until someone deletes the file by hand, and saved opt-outs are lost.

## Should fix

### 8. Windows line endings, and no `.gitattributes`

- **What this is:** Git here has `core.autocrlf=true`. `git ls-files --eol` shows Windows line endings (CRLF) for `dist/` and `hooks/project-progress-check.sh`.
- **Problem:** `prepack` rebuilds `dist/`, so the npm command is safe. The `.sh` file is not rebuilt, so if you pack from this checkout, `sh` fails on Linux and macOS.
- **Fix:** Before the npm publish, add a `.gitattributes` file with `*.sh text eol=lf`. Then renormalize once.
- **If we skip it:** The POSIX wrapper is broken in the published package.

### 9. `init --force` overwrites real history

`src/cli.ts:246-270`

- **What this is:** `init` copies six template files into `project-progress/`.
- **Problem:** If the folder exists, the error says "Use --force", and `--force` overwrites all six files. Example: Progress.md is missing, so an agent runs `init --force`. The full Session Log, Decisions and Tasks become empty templates.
- **Fix:** Without `--force`, create only the missing files. Keep `--force` for a full overwrite.
- **If we skip it:** Following the error message can delete project history.

### 10. MCP writes do not set `updated`

`src/mcp/server.ts:459-463`, `src/mcp/server.ts:506-507`

- **What this is:** The skill tells agents to set `updated` on every Progress.md update.
- **Problem:** `update_project_progress` and `mark_project_status` cannot set it. So agents that use only MCP, such as Hermes, cannot follow this rule.
- **Fix:** In both tools, also set `updated` to today.
- **If we skip it:** `list_projects` and SessionStart show wrong dates.

### 11. The secret check reads only Progress.md

`src/hook/validator.ts:36-56`

- **What this is:** At Stop, the hook warns about text that looks like a key, a token or a password.
- **Problem:** It does not read `Session Log.md`, `Tasks.md` or `Decisions.md`, and agents often commit those files.
- **Fix:** Run the same patterns on all `*.md` files in `project-progress/`.
- **If we skip it:** The check misses most of the text that agents write.

### 12. A typo starts a full disk walk

`src/mcp/server.ts:217-236`

- **What this is:** `resolveProject` finds a project by its name or its path.
- **Problem:** When the index has no match, it walks all of `PROJECT_PROGRESS_ROOTS` before it tries the exact path. It does not save what it finds, so the walk happens again on each call.
- **Fix:** Try the exact path before the walk. Save the match from the walk with `upsertIndexedProject`.
- **If we skip it:** With a large root, such as your home folder, the tools get slow.

### 13. `doctor` checks the wrong folder

`src/cli.ts:787-796`

- **What this is:** The `index` check in `doctor`.
- **Problem:** It ignores `AWESOME_PROGRESS_TRACKER_HOME`, which the index uses. Also, `fs.access` with no mode only checks that the folder exists, not that it can be written.
- **Fix:** Use `indexDir()` and `fs.access(dir, fs.constants.W_OK)`.
- **If we skip it:** `doctor` can say OK when the index folder is broken.

### 14. No CI

- **What this is:** `dist/` is committed, and plugin installs run it with no build step.
- **Problem:** Tests, typecheck and the "dist matches src" check run only by hand in WSL. On 2026-11-19 `dist/` matched (when CRLF is ignored), but nothing stops a commit that forgets to rebuild.
- **Fix:** Add one workflow that runs `npm ci`, `typecheck`, `test` and `build`, then `git diff --exit-code dist`.
- **If we skip it:** An out-of-date `dist/` can reach users, and no test fails.

### 15. This repo's own Progress.md is wrong

`project-progress/Progress.md:11`, `:105`, `:166`, `.gitignore:7`

- **What this is:** This repo uses Breadcrumbs for its own progress.
- **Problem:**
  - `.gitignore` ignores the folder, but the file is tracked, so each session start makes a diff.
  - `path` is still the personal path `C:/Users/<user>/...`, although line 105 says this was fixed.
  - Resume Instructions point to a spec file that does not exist (`docs/superpowers/specs/2026-06-26-project-progress-design.md`).
  - "Current State" still says "no standalone CLI" and "Python validation".
  - Two open items are already finished (compaction spec review, ADR 0016/0017 release).
  - Remaining Work is over its 4000-character budget.
- **Fix:** Decide if the file is tracked or ignored. Then correct these fields and move the finished items to Done.
- **If we skip it:** The tool shows wrong resume data for its own project.

## Lean

### 16. An unused standalone hook CLI

`src/hook/cli.ts`, `hooks/project-progress-check.sh`, `hooks/project-progress-check.ps1`, `tests/hook/cli.test.ts`

- **What this is:** An older manual checker. ADR 0017 calls it "an unused standalone CLI".
- **Problem:** It still uses the old mtime-only freshness rule, so it can disagree with the real Stop hook. It is about 290 lines.
- **Fix:** Delete it, the `hook` npm script, and the sections about it in `README.md`, `TESTING.md` and `agent-instructions/HOOKS.md`. This also removes most of the risk in item 8.
- **If we skip it:** You keep two rules for "fresh", and they can give different answers.

### 17. The same lists exist in several places

`src/mcp/writer.ts:19-30`, `src/hook/validator.ts:8-19`, `src/mcp/server.ts:34`, `src/hook/schema.ts:17-25`, `src/mcp/schema.ts:1-8`

- **What this is:** The section names and the status values.
- **Problem:** `REQUIRED_PROGRESS_SECTIONS` is a copy of `ALLOWED_PROGRESS_SECTIONS`. The statuses exist 3 times, and `pathExists` is copied into 6 files.
- **Fix:** Keep one list for each, make the `ProjectStatus` type from that list, and keep one `pathExists`.
- **If we skip it:** A new status or section can be accepted in one place and rejected in another.

### 18. A JSON round trip in the MCP results

`src/mcp/server.ts:379-389`

- **What this is:** `textResult` builds every tool result.
- **Problem:** Each tool turns its result into a JSON string, and then `textResult` parses that string again to find errors.
- **Fix:** Call `errorResult` or `successResult` directly, and delete `textResult`.
- **If we skip it:** About 15 extra lines, which each new tool copies.

### 19. Files that nothing uses

- **What this is:** `.superpowers/sdd/task-*-report.md` (old agent notes), `misc/apt-logo.png` (the rename removed it from the README), and the `build:mcp` script (`package.json:42`), which is a copy of `build`.
- **Problem:** Nothing uses them, and the notes still use the old names.
- **Fix:** Delete them, and change `README.md:325` to `npm run build`.
- **If we skip it:** They confuse readers and search.

## Nice to have

### 20. Session files in the temp folder are never deleted

`src/hook/cc-adapter.ts:76-107`

- **What this is:** The hook writes one JSON file per session.
- **Problem:** Nothing deletes these files, and Windows does not clean `%TEMP%` by itself.
- **Fix:** At SessionStart, delete files that are older than 30 days.
- **If we skip it:** The folder grows slowly. Results stay correct.

## Left out

Five smaller items are not listed above. Two examples: `git log --grep commit` counts as a commit, and Codex runs the pre-commit hook on every Bash command.

## Verdict

Fix item 1 first, because a privacy feature fails silently. Fix items 2 and 8 before the npm publish. Then fix items 3 and 4, because they make the resume warnings false.

**Lean:** -350 lines, -0 dependencies possible.

## Not checked

- Tests, typecheck and build were not run, because `node_modules` is not on the Windows host. `dist/` was only compiled with `tsc --noCheck` to compare it with the committed files.
- Not read: `bench/`, most of `tests/` and `docs/` (ADRs 0006, 0009, 0014 and 0019 were read), `src/encoding.ts`, and `src/hook/checkpoint-render.ts`.
- Host behavior not verified:
  - whether the hook filter `if: Bash(git commit:*)` matches commands that are joined with `&&`;
  - whether compaction keeps the `session_id` (item 4 assumes that it does);
  - whether Codex sets `PLUGIN_DATA` only for hooks. If it does, CLI opt-outs go to a different folder than the one the hooks read.
