# Manual Release Testing

Run this guide for every release candidate, once per provider: **Claude Code**, **Codex CLI**, **Antigravity CLI (`agy`, Gemini)** and **Hermes Agent**. It covers only what the automated suite cannot reach. That means a real agent loading the plugin or skill, a real host calling the hooks with its own payloads, and a real agent following the workflow.

`npm test`, `npm run typecheck`, `npm run build` and CI cover the hook logic, the MCP tools, the CLI and the commit-guard parser. Run them first. Don't repeat those checks here. For longer exploratory scenarios, see [`TESTING.md`](TESTING.md).

## What each provider supports

| Surface | Claude Code | Codex CLI | Antigravity (`agy`) | Hermes Agent |
| --- | --- | --- | --- | --- |
| Skill `breadcrumbs` | plugin | plugin | `SKILL.md` copied in | managed by `install -g hermes` |
| MCP server (6 tools) | plugin `.mcp.json` | plugin `.mcp.json` | `mcp_config.json` | managed by `install -g hermes` |
| `SessionStart` / `UserPromptSubmit` hooks | yes | yes, after trust | no | no |
| `PreToolUse` commit guard and edit reminder | yes | yes, after trust | no | no |
| `Stop` reminder | blocks once, then advisory | advisory only (`stop-soft`) | no | no |

Run the checks for a provider only where its column says yes. Mark the rest `N/A`, not `PASS`.

## 1. Prepare once per release

Run this in Git Bash, WSL or another POSIX shell, from the release checkout:

```bash
npm ci && npm run build
PACKAGE_TGZ="$PWD/$(npm pack --silent)"
VERSION="$(node -p "require('./package.json').version")"
bc() { npx --yes --package="$PACKAGE_TGZ" breadcrumbs "$@"; }

export BC_TEST="$(mktemp -d)"

# A: no Breadcrumbs yet
mkdir -p "$BC_TEST/fresh" && git -C "$BC_TEST/fresh" init -q
echo "# Fresh" > "$BC_TEST/fresh/README.md"

# B: initialized and committed
mkdir -p "$BC_TEST/tracked" && cd "$BC_TEST/tracked" && git init -q
echo "# Tracked" > README.md
bc init . --project "Manual Tracked"
git add -A && git commit -qm "init" && cd -

# C: initialized, progress must never be committed
mkdir -p "$BC_TEST/private" && cd "$BC_TEST/private" && git init -q
echo "# Private" > README.md
bc init . --project "Manual Private"
sed -i 's/^commit_progress: .*/commit_progress: false/' project-progress/Progress.md
git add README.md && git commit -qm "init" && cd -

echo "Fixtures in $BC_TEST, testing $VERSION"
```

Use a fresh copy of the fixtures for each provider. A previous provider's session leaves handoff and checkpoint fields behind.

## 2. Install the candidate for each provider

Install the release candidate, not the published version. After installing, restart the agent or start a new session.

- **Claude Code.** Add the candidate checkout as a marketplace, then install the plugin:
  ```bash
  claude plugin marketplace add /path/to/release/checkout
  claude plugin install breadcrumbs@breadcrumbs
  claude plugin list
  ```
- **Codex CLI.** Add the candidate checkout as a marketplace, then install the plugin:
  ```bash
  codex plugin marketplace add /path/to/release/checkout
  codex plugin add breadcrumbs@breadcrumbs
  codex plugin list
  ```
  If your Codex version only accepts GitHub sources, push the candidate to a branch and add `AndriiLavrekha/breadcrumbs` at that ref instead. On the first session, review and trust the bundled hooks in `/hooks`.
- **Antigravity (`agy`).**
  1. Copy the skill into a workspace skill folder:
     ```bash
     mkdir -p "$BC_TEST/tracked/.agents/skills/breadcrumbs"
     cp skills/breadcrumbs/SKILL.md "$BC_TEST/tracked/.agents/skills/breadcrumbs/"
     ```
     Repeat for `fresh` and `private`. For a global install, copy it to `~/.gemini/antigravity-cli/skills/breadcrumbs/` instead.
  2. Add the server to `~/.gemini/config/mcp_config.json`, or to a workspace `.agents/mcp_config.json`:
     ```json
     {
       "mcpServers": {
         "breadcrumbs": {
           "command": "npx",
           "args": ["--yes", "--package=<absolute path to the .tgz>", "breadcrumbs", "mcp"],
           "env": { "PROJECT_PROGRESS_ROOTS": "<value of $BC_TEST>" }
         }
       }
     }
     ```
  3. Open `/mcp` and confirm `breadcrumbs` is connected.
- **Hermes Agent.** Follow the disposable-profile recipe in [`TESTING.md` → Scenario 9](TESTING.md#scenario-9-hermes-disposable-profile-verification), using `--roots "$BC_TEST"`. Then restart Hermes.

## 3. Checks for every provider

Each check names its fixture, what to do, and what passes. Record the result in the table in section 6.

**M1. The installed version is the candidate.**
- Claude Code and Codex: pass if `claude plugin list` or `codex plugin list` shows `breadcrumbs@breadcrumbs` at `$VERSION`.
- `agy`: pass if the MCP config points at the candidate tarball.
- Hermes: pass if `bc doctor -g hermes` is OK and `hermes mcp test breadcrumbs` passes.
- In every provider, open the host's MCP view (`/mcp`, or `hermes mcp list`). Pass if the server named `breadcrumbs` is connected and lists exactly these six tools: `list_projects`, `refresh_projects`, `read_project_progress`, `update_project_progress`, `mark_project_status`, `set_project_gates`.

**M2. MCP read, update and read-back (fixture B).**
- Ask: `Use the Breadcrumbs MCP tools to refresh projects, then read "Manual Tracked".`
- Then ask: `Set its Next Action to "Manual MCP check $VERSION" and mark gate tests as done.`
- Pass: `project-progress/Progress.md` on disk has the new Next Action and `gate_tests: done`.
- Pass: `updated:` is today's date.
- Pass: `~/.awesome-progress-tracker/Projects.md` lists the project.
- Pass: a second `read_project_progress` returns the new text.

**M3. Asks before initializing (fixture A).**
- Start a session in `fresh`. Ask: `Add a small CONTRIBUTING.md with setup steps.`
- Pass: before creating `project-progress/`, the agent asks `This project is not initialized with Breadcrumbs. Do you want me to create project-progress/ here?`, or close to it.
- Answer **No**.
- Pass: no `project-progress/` folder is created.
- Pass: `bc state list` shows `fresh` as `opted-out`.
- Pass: a new session in `fresh` doesn't ask again.
- Finally, run `bc state reset "$BC_TEST/fresh"`, ask again, and answer **Yes**.
- Pass: the agent creates `project-progress/` with the project name and does the task.
- Fail: the agent creates files without asking, or asks again after the opt-out.

**M4. Resume and record (fixture B).**
- Ask: `Resume this project and make one small safe README change.`
- Pass: the agent reads `Progress.md` before editing, and does not read every progress file up front.
- Pass: by the end of the session it has updated Resume Snapshot, Next Action and Last Session.
- Pass: the frontmatter fields `provider_last_used`, `agent_last_used` and `model_last_used` describe this session. The provider is `claude-code` for Claude Code, `codex` for Codex and `hermes` for Hermes. For `agy`, write down the slug it uses and expect the same one next release.
- Fail: unknown values are guessed, or the previous session's model is kept.

**M5. Progress stays private (fixture C).**
- Ask: `Make a small README change and commit it.`
- Pass: the commit contains `README.md` and nothing under `project-progress/`.
- Check with `git -C "$BC_TEST/private" show --stat HEAD`.
- Pass: no secrets or tokens appear in any progress file.

## 4. Hook checks (Claude Code and Codex only)

Run these with fixture B unless a check says otherwise. Start a new session for each check, so session state doesn't carry over.

**H1. Resume context at session start.**
- Ask: `Quote the Breadcrumbs context you were given at session start.`
- Pass: the answer contains `This project uses Breadcrumbs`, the project line, and the Resume Snapshot and Next Action text.

**H2. Prompt-time guidance (`UserPromptSubmit`).**
- Start a session in fixture B, so SessionStart injects resume context and no init guidance.
- From another terminal, run `mv "$BC_TEST/tracked/project-progress" "$BC_TEST/tracked/pp.bak"`. Then submit a multi-step request.
- Pass: the agent is told `This project previously opted in to Breadcrumbs, but project-progress/Progress.md is missing`, and it asks before recreating anything.
- Move the folder back afterwards.

**H3. Edit reminder.**
- Ask for a code edit, then another one.
- Pass: the `[project-progress] Before making changes, check …Tasks.md…` message appears once in the session, not on every edit.
- Pass: edits to files under `project-progress/` never trigger it.

**H4. Commit guard (fixture C).**
- Run these in fixture C, where `commit_progress` is `false`.
- Edit `Progress.md` and `README.md` yourself first. Then ask the agent to run each command below, one at a time:

| Command | Expected |
| --- | --- |
| `git add -A && git commit -m probe` | Denied: `This command would commit project-progress files…` |
| `git commit -am probe` | Denied, same reason |
| `git add project-progress/Progress.md && git commit -m probe` | Denied |
| `git add README.md && git commit -m probe` | Allowed |

- Afterwards, stage the still-modified `Progress.md` yourself (`git add project-progress/Progress.md`). Then ask the agent to run `git commit -m probe`.
- Pass: it is denied with `project-progress files are staged…`.
- Run `git restore --staged project-progress/` afterwards.
- Claude Code only: the compound commands in the first rows also show whether the hook's `if: Bash(git commit:*)` filter matches inside a compound command. If they are allowed, the release is blocked.

**H5. Stop reminder after unrecorded work.**
- Ask for a code change, and tell the agent not to update progress.
- Pass on Claude Code: when the turn ends, it is blocked once with `project-progress/Progress.md was not updated this session…`. The next stop in the same session only shows advisory text.
- Pass on Codex: advisory text only, never a block.
- Pass: after the agent updates Progress.md, the next stop is silent, and the frontmatter shows `handoff: clean` and a `base_commit` equal to the current HEAD.

**H6. A read-only session leaves no trace.**
- Note the frontmatter `handoff:` and `session_id:`. Ask a question about the code and make no changes. End the session.
- Pass: no reminder appears.
- Pass: `handoff:` is back to its value from before the session. So is `session_id:`, if it had one; a project with no previous `session_id` keeps the current one. During the session, `handoff` reads `interrupted`.
- Repeat, but have the agent run `git switch -c probe && git switch -`. The pass conditions are the same, because switching branches is not work.

**H7. Leftover edits are not this session's work.**
- Before starting the session, modify `README.md` yourself. Then start a session and only ask a question.
- Pass: no Stop reminder appears.
- In a new session, ask the agent to edit the same file again.
- Pass: the reminder appears.

**H8. An interrupted session is reported.**
- Ask for a code change, then close the terminal before the agent finishes. Start a new session.
- Pass: the context includes `Previous session <id> ended without a clean handoff.`

**H9. Checkpoint drift.**
- After H5 has recorded a clean handoff, make a commit outside the agent (`git commit --allow-empty -m drift`). Start a new session.
- Pass: the context contains `Checkpoint drift: stored base_commit … is 1 commit behind HEAD`, or very close wording, before the Resume Snapshot.

**H10. Compaction keeps the baseline (Claude Code only).**
- Ask for a code change and have the agent update Progress.md. Run `/compact`, then ask a question.
- Pass: the context after compaction does not say the previous session ended without a clean handoff.
- Pass: the next stop is silent.
- This also confirms that Claude Code keeps `session_id` across compaction. Write down what you saw.

**H11. Codex hook trust.**
- On a profile where the hooks are not trusted yet, start a session.
- Pass: Codex asks to review the Breadcrumbs hooks, and after you trust them, H1 passes.
- After a plugin update, Codex asks again. Hooks that are still untrusted never break a normal session.

## 5. Upgrade and uninstall (every provider)

**U1. Upgrade from the previous release.** Install the previous release, run M2 so the index exists, then upgrade to the candidate the way the README describes.
- Pass: M1 now reports `$VERSION`.
- Pass: the fixtures' `project-progress/` folders, the index and the opt-out state are unchanged.

**U2. Uninstall.**
- Claude Code: `claude plugin uninstall breadcrumbs@breadcrumbs`.
- Codex: `codex plugin remove breadcrumbs@breadcrumbs`.
- Hermes: `bc uninstall -g hermes`.
- `agy`: delete the skill folder and the `mcp_config.json` entry.
- Pass: the skill and MCP server are gone.
- Pass: every `project-progress/` folder, `~/.awesome-progress-tracker/` and the opt-out state survive.

## 6. Record the results

Copy this table into the release notes or `RELEASE_CHECKLIST.md`. Use `PASS`, `FAIL`, `PARTIAL` or `N/A`, and link evidence for every `FAIL` or `PARTIAL`. Evidence can be a screenshot, a transcript excerpt, or `git show --stat` output.

| Check | Claude Code | Codex CLI | Antigravity | Hermes |
| --- | --- | --- | --- | --- |
| M1 version and tools | | | | |
| M2 MCP read/update/read-back | | | | |
| M3 asks before init, opt-out | | | | |
| M4 resume and record | | | | |
| M5 progress stays private | | | | |
| H1 resume context | | | N/A | N/A |
| H2 init prompt mid-session | | | N/A | N/A |
| H3 edit reminder once | | | N/A | N/A |
| H4 commit guard | | | N/A | N/A |
| H5 stop reminder | | | N/A | N/A |
| H6 read-only leaves no trace | | | N/A | N/A |
| H7 leftover edits | | | N/A | N/A |
| H8 interrupted session | | | N/A | N/A |
| H9 checkpoint drift | | | N/A | N/A |
| H10 compaction baseline | | N/A | N/A | N/A |
| H11 hook trust | N/A | | N/A | N/A |
| U1 upgrade keeps data | | | | |
| U2 uninstall keeps data | | | | |

Record the host versions you tested with (`claude --version`, `codex --version`, `agy --version`, `hermes --version`) and the operating system.

**Release-blocking failures:**
- A version mismatch in M1.
- Any silent initialization in M3.
- A progress file committed despite `commit_progress: false` in M5 or H4.
- A secret written to progress.
- An MCP write that changes the wrong project, or that the index doesn't reflect.
- A Stop reminder that never fires after real work (H5), or that fires on every read-only session (H6, H7).
- Lost project data or opt-out state in U1 or U2.
