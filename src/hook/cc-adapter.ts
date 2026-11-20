import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../fs-util.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bodyHash, sha256 } from "../hash.js";
import { extractSection, isKnownRuntimeValue, parseFrontmatter, renderLastRuntime } from "../mcp/markdown.js";
import { replaceFrontmatterValue, writeFileAtomic } from "../mcp/writer.js";
import { readProjectTrackingState, setProjectTrackingState } from "../project-state.js";
// defaultGitRunner's implementation lives in checkpoint.ts, not here.
import { defaultGitRunner as git, readCheckpoint, resolveDrift } from "./checkpoint.js";
import { renderDrift, renderGates } from "./checkpoint-render.js";
import { checkFreshness } from "./freshness.js";
import { analyzeGitCommand } from "./git-command.js";
import { CLEAN_TREE, committedSince, headReflogSize, treeFingerprint } from "./work-evidence.js";
import { checkProgressHealth, summarizeProblems, validateProgressFile } from "./validator.js";
import type { HealthFinding } from "./validator.js";

// Adapter that bridges Claude Code hook events (JSON on stdin) to the Breadcrumbs
// checks. Invoked as: node cc-adapter.js <session-start|user-prompt-submit|pre-commit|stop>
// It must never throw or block a session on its own failure: every handler
// degrades to "allow / stay silent" on error.

export interface HookEvent {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface HookResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

async function initializationGuidance(cwd: string, hookEventName: string): Promise<HookResult> {
  const progressPath = progressPathFor(cwd);
  if (await pathExists(progressPath)) return { code: 0 };

  const state = await bestEffortReadProjectState(cwd);
  if (state === "opted-out") return { code: 0 };

  const statusLine = state === "opted-in"
    ? "This project previously opted in to Breadcrumbs, but `project-progress/Progress.md` is missing."
    : "This project is not initialized with Breadcrumbs.";
  return {
    code: 0,
    stdout: emitJson({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: [
          `${statusLine} For multi-step feature, investigation, refactor, debugging, deployment, release, or setup work, ask exactly:`,
          "\"This project is not initialized with Breadcrumbs. Do you want me to create `project-progress/` here?\"",
          "Only initialize after the user says yes. If the user says no, record a per-project opt-out with `breadcrumbs state set . --state opted-out`.",
          "Do not ask for trivial one-off or read-only tasks. Do not create files from hooks. Never write secrets to progress files."
        ].join("\n")
      }
    })
  };
}

function progressPathFor(cwd: string): string {
  return path.join(cwd, "project-progress", "Progress.md");
}

function sessionStateDir(): string {
  return path.join(os.tmpdir(), "awesome-progress-tracker", "sessions");
}

function sessionStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(sessionStateDir(), `${safe}.json`);
}

interface SessionState {
  startedAt?: string;
  cwd?: string;
  editReminderShown?: boolean;
  stopBlocked?: boolean;
  healthShown?: boolean;
  bodyHash?: string;
  headAtStart?: string;
  // HEAD reflog length and uncommitted-tree fingerprint at start, so Stop counts only what this session did.
  reflogBytesAtStart?: number;
  treeAtStart?: string;
  // Frontmatter handoff and session_id before SessionStart marked them, so a session that did nothing can put them back.
  handoffAtStart?: string;
  sessionIdAtStart?: string;
}

async function readSessionState(sessionId: string | undefined): Promise<SessionState> {
  if (!sessionId) return {};
  try {
    const raw = await fs.readFile(sessionStatePath(sessionId), "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch {
    return {};
  }
}

async function writeSessionState(sessionId: string, state: SessionState): Promise<void> {
  await fs.mkdir(sessionStateDir(), { recursive: true });
  await fs.writeFile(sessionStatePath(sessionId), JSON.stringify(state), "utf-8");
}

const SESSION_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Nothing else deletes these files and Windows does not clean %TEMP% by itself.
async function pruneSessionState(now: number = Date.now()): Promise<void> {
  try {
    const dir = sessionStateDir();
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = await fs.stat(file);
      if (now - mtimeMs > SESSION_STATE_MAX_AGE_MS) await fs.rm(file, { force: true });
    }
  } catch {
    // best effort only
  }
}

function currentHead(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "HEAD"])?.trim() || undefined;
}

interface HandoffFields {
  handoff: string;
  sessionId?: string;
}

// A Progress.md without a handoff key (a fresh init) counts as clean.
async function readHandoffFields(progressPath: string): Promise<HandoffFields> {
  try {
    const frontmatter = parseFrontmatter(await fs.readFile(progressPath, "utf-8"));
    const sessionId = frontmatter.session_id ? String(frontmatter.session_id) : undefined;
    return { handoff: typeof frontmatter.handoff === "string" ? frontmatter.handoff : "clean", sessionId };
  } catch {
    return { handoff: "clean" };
  }
}

// Returns false when this start only repeats one already recorded: Claude Code re-runs SessionStart after
// compaction (source "compact"), and that must not reset the baseline Stop compares Progress.md against.
// Docs do not say whether session_id survives compaction; a new id simply gets a fresh baseline.
async function recordSessionStart(
  sessionId: string | undefined,
  cwd: string,
  source: string | undefined,
  atStart: HandoffFields
): Promise<boolean> {
  if (!sessionId) return true;
  try {
    if (source === "compact") {
      const existing = await readSessionState(sessionId);
      if (existing.startedAt && existing.cwd === cwd) return false;
    }
    await writeSessionState(sessionId, {
      startedAt: new Date().toISOString(),
      cwd,
      headAtStart: currentHead(cwd),
      reflogBytesAtStart: await headReflogSize(cwd),
      treeAtStart: await treeFingerprint(cwd),
      handoffAtStart: atStart.handoff,
      sessionIdAtStart: atStart.sessionId
    });
  } catch {
    // best effort only
  }
  return true;
}

async function bestEffortRecordBodyHash(sessionId: string | undefined, markdown: string): Promise<void> {
  if (!sessionId) return;
  try {
    const state = await readSessionState(sessionId);
    await writeSessionState(sessionId, { ...state, bodyHash: bodyHash(markdown) });
  } catch {
    // best effort only
  }
}

async function bestEffortSetProjectState(cwd: string, state: "initialized"): Promise<void> {
  try {
    // Every SessionStart would otherwise rewrite the shared state file for no change.
    if ((await readProjectTrackingState(cwd)).state === state) return;
    await setProjectTrackingState(cwd, state);
  } catch {
    // best effort only
  }
}

async function bestEffortReadProjectState(cwd: string): Promise<"unknown" | "opted-in" | "opted-out" | "initialized"> {
  try {
    return (await readProjectTrackingState(cwd)).state;
  } catch {
    return "unknown";
  }
}

async function bestEffortMarkHandoff(
  progressPath: string,
  handoff: "clean" | "interrupted",
  sessionId?: string
): Promise<boolean> {
  try {
    const markdown = await fs.readFile(progressPath, "utf-8");
    const expectedHash = sha256(markdown);
    let updated = replaceFrontmatterValue(markdown, "handoff", handoff);
    if (sessionId) updated = replaceFrontmatterValue(updated, "session_id", sessionId);
    await writeFileAtomic(progressPath, updated, expectedHash);
    return true;
  } catch {
    // Best effort only: a handoff write must never fail a session.
    return false;
  }
}

export function normalizeProviderSlug(value: string | undefined): string | undefined {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(value)) return undefined;
  return value;
}

export function providerFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf("--provider");
  if (index === -1) return undefined;
  return normalizeProviderSlug(argv[index + 1]);
}

async function bestEffortRecordSessionEnd(
  cwd: string,
  progressPath: string,
  now: Date = new Date(),
  provider?: string
): Promise<boolean> {
  try {
    const markdown = await fs.readFile(progressPath, "utf-8");
    const expectedHash = sha256(markdown);
    let updated = replaceFrontmatterValue(markdown, "handoff", "clean");

    const fields = readCheckpoint(cwd, now);
    if (fields) {
      updated = replaceFrontmatterValue(updated, "base_commit", fields.base_commit);
      updated = replaceFrontmatterValue(updated, "base_branch", fields.base_branch);
      updated = replaceFrontmatterValue(updated, "worktree_dirty", String(fields.worktree_dirty));
      updated = replaceFrontmatterValue(updated, "checkpoint_at", fields.checkpoint_at);
    }

    const slug = normalizeProviderSlug(provider);
    if (slug && isKnownRuntimeValue(parseFrontmatter(markdown).provider_last_used) === null) {
      updated = replaceFrontmatterValue(updated, "provider_last_used", slug);
    }

    // writeFileAtomic throws "Progress file changed on disk" when another
    // writer (e.g. an MCP update_project_progress call) raced us and won.
    // That is the correct outcome to swallow: their content is newer and
    // must not be clobbered by our stamp.
    await writeFileAtomic(progressPath, updated, expectedHash);
    return true;
  } catch {
    // Best effort only: a recording failure must never fail a session.
    return false;
  }
}

// null means git could not be inspected; callers that guard something must not read that as "nothing staged".
function stagedFiles(cwd: string): string[] | null {
  const out = git(cwd, ["diff", "--cached", "--name-only"]);
  if (out === null) return null;
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function emitJson(value: unknown): string {
  return JSON.stringify(value);
}

function boundedContext(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 14))}… [truncated]`;
}

// Built from this file's location so it works for plugin installs, where the
// awesome-progress-tracker binary is usually not on PATH.
function compactCommand(cwd: string): string {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  // A trailing separator before the closing quote would escape it on Windows.
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const dir = trimmed === "" || trimmed.endsWith(":") ? `${cwd.slice(0, trimmed.length + 1)}.` : trimmed;
  return `node "${cli}" compact "${dir}"`;
}

async function bestEffortHealth(progressPath: string): Promise<HealthFinding[]> {
  try {
    return await checkProgressHealth(path.dirname(progressPath));
  } catch (error) {
    // A non-UTF-8 file is something the user must fix, so don't hide it.
    if (error instanceof Error && error.message.includes("is not valid UTF-8")) return [{ message: error.message, remedy: "edit" }];
    return [];
  }
}

export async function handleSessionStart(event: HookEvent): Promise<HookResult> {
  const cwd = event.cwd ?? process.cwd();
  const progressPath = progressPathFor(cwd);
  await pruneSessionState();
  const fresh = await recordSessionStart(event.session_id, cwd, event.source, await readHandoffFields(progressPath));

  if (!(await pathExists(progressPath))) {
    return await initializationGuidance(cwd, "SessionStart");
  }

  await bestEffortSetProjectState(cwd, "initialized");

  const markdown = await fs.readFile(progressPath, "utf-8");
  if (fresh) await bestEffortRecordBodyHash(event.session_id, markdown);
  const frontmatter = parseFrontmatter(markdown);

  const lines: string[] = [
    "This project uses Breadcrumbs. `project-progress/Progress.md` is the canonical " +
      "resume source: read it before changing project files, and update Progress.md (Resume Snapshot, " +
      "Next Action, Blockers) before finishing meaningful work.",
    `Project: ${frontmatter.project ?? "(unknown)"} | Status: ${frontmatter.status ?? "?"} | Updated: ${frontmatter.updated ?? "?"}`
  ];

  const runtime = renderLastRuntime(frontmatter);
  if (runtime) lines.push(`\n${runtime}`);

  const health = await bestEffortHealth(progressPath);
  if (health.length > 0) {
    const command = health.some((finding) => finding.remedy === "compact") ? ` — run ${compactCommand(cwd)}` : "";
    lines.push(`\nProgress health: ${boundedContext(health.map((finding) => finding.message).join("; "), 300)}${command}`);
  }

  // Drift is pushed before Resume Snapshot/Next Action/Blockers so the agent
  // is warned that the recorded state may be stale before it absorbs that
  // state, not after.
  const baseCommit = typeof frontmatter.base_commit === "string" ? frontmatter.base_commit : "";
  if (baseCommit) {
    const status = resolveDrift(cwd, baseCommit);
    if (status) {
      // renderDrift is self-bounding to MAX_DRIFT_LENGTH: it trims its own file
      // list to fit and never sheds prose. Do NOT wrap it in boundedContext —
      // that truncates from the end, which would cut the closing instruction
      // and keep the file names, exactly backwards.
      const drift = renderDrift(status, baseCommit);
      if (drift) lines.push(`\n${drift}`);
    }
  }

  // After compaction the interrupted mark is this very session's own, not a predecessor's.
  const ownMark = !fresh && frontmatter.session_id === event.session_id;
  if (frontmatter.handoff === "interrupted" && !ownMark) {
    const previous = frontmatter.session_id ? String(frontmatter.session_id) : "(unknown)";
    lines.push(
      `\nPrevious session ${previous} ended without a clean handoff. ` +
        "Progress.md may predate uncommitted work in the tree."
    );
  }

  const resume = extractSection(markdown, "Resume Snapshot");
  const next = extractSection(markdown, "Next Action");
  const blockers = extractSection(markdown, "Blockers");
  if (resume) lines.push(`\nResume Snapshot:\n${boundedContext(resume, 800)}`);
  if (next) lines.push(`\nNext Action:\n${boundedContext(next, 300)}`);
  if (blockers && blockers.trim() && blockers.trim().toLowerCase() !== "none.") {
    lines.push(`\nBlockers:\n${boundedContext(blockers, 200)}`);
  }

  const gates = renderGates(frontmatter);
  if (gates) lines.push(`\n${gates}`);

  if (fresh) await bestEffortMarkHandoff(progressPath, "interrupted", event.session_id);

  return {
    code: 0,
    stdout: emitJson({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n")
      }
    })
  };
}

export async function handleUserPromptSubmit(event: HookEvent): Promise<HookResult> {
  return await initializationGuidance(event.cwd ?? process.cwd(), "UserPromptSubmit");
}

function denyCommit(reason: string): HookResult {
  return {
    code: 0,
    stdout: emitJson({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })
  };
}

// Loose gate, kept from before the strict classifier: it only ever gates the staged-files check, which denies
// real staged progress files and nothing else, so it cannot conflict with ADR 0009's "confidently classified" rule.
const LOOSE_COMMIT = /\bgit\b[\s\S]*\bcommit\b(?![\w-])/;

export async function handlePreCommit(event: HookEvent): Promise<HookResult> {
  const cwd = event.cwd ?? process.cwd();
  const command = event.tool_input?.command ?? "";
  const { commits, adds } = analyzeGitCommand(command);
  const strict = commits.length > 0;
  if (!strict && !LOOSE_COMMIT.test(command)) return { code: 0 };

  const progressPath = progressPathFor(cwd);
  if (!(await pathExists(progressPath))) return { code: 0 };

  // ADR 0009: for a confidently classified commit, anything we cannot verify blocks the commit.
  // runHook turns every throw into "allow", so failures must be caught here.
  try {
    const frontmatter = parseFrontmatter(await fs.readFile(progressPath, "utf-8"));
    const restricted = frontmatter.commit_progress === false || frontmatter.sensitivity === "sensitive";
    if (!restricted) return { code: 0 };

    const why = frontmatter.commit_progress === false ? "commit_progress: false" : "sensitivity: sensitive";
    const cannotInspect =
      `Breadcrumbs could not inspect git, and Progress.md declares ${why}. ` +
      "Fix the repository state or change the policy in Progress.md, then retry the commit.";

    const staged = stagedFiles(cwd);
    if (staged === null) return strict ? denyCommit(cannotInspect) : { code: 0 };
    if (staged.some((file) => file.replace(/\\/g, "/").includes("project-progress/"))) {
      return denyCommit(
        `project-progress files are staged but Progress.md declares ${why}. ` +
          "Unstage them with `git restore --staged project-progress/` before committing, " +
          "or change the policy in Progress.md if sharing is intended."
      );
    }
    if (!strict) return { code: 0 };

    // Nothing is staged yet, but this same command may stage the progress files itself.
    const stagesEverything =
      adds.some((add) => add.broad || add.namesProgress) || commits.some((commit) => commit.namesProgress);
    const stagesTracked = commits.some((commit) => commit.stagesTracked || commit.broadPathspec);
    if (stagesEverything || stagesTracked) {
      const porcelain = git(cwd, ["status", "--porcelain", "--", "project-progress"]);
      if (porcelain === null) return denyCommit(cannotInspect);
      const changes = porcelain.split(/\r?\n/).filter((line) => line.trim().length > 0);
      // `commit -a` never adds untracked files; `git add -A` and explicit paths do.
      const wouldStage = stagesEverything ? changes : changes.filter((line) => !line.startsWith("??"));
      if (wouldStage.length > 0) {
        return denyCommit(
          `This command would commit project-progress files, but Progress.md declares ${why}. ` +
            "Commit specific paths instead of -a / git add -A, or change the policy in Progress.md if sharing is intended."
        );
      }
    }
    return { code: 0 };
  } catch {
    return strict
      ? denyCommit(
          "Breadcrumbs could not verify whether project-progress files would be committed. " +
            "Check that Progress.md is readable, then retry."
        )
      : { code: 0 };
  }
}

export async function handlePreEdit(event: HookEvent): Promise<HookResult> {
  const cwd = event.cwd ?? process.cwd();
  const progressPath = progressPathFor(cwd);
  if (!(await pathExists(progressPath))) return { code: 0 };

  const filePath = (event.tool_input?.file_path as string | undefined) ?? "";
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/project-progress/") || normalized.startsWith("project-progress/")) {
    return { code: 0 };
  }

  const state = await readSessionState(event.session_id);
  if (state.editReminderShown) return { code: 0 };

  if (event.session_id) {
    await writeSessionState(event.session_id, { ...state, editReminderShown: true });
  }

  return {
    code: 0,
    stdout: emitJson({
      systemMessage:
        "[project-progress] Before making changes, check `project-progress/Tasks.md` and " +
        "`Open Questions.md` for relevant remaining work, then update Progress.md at meaningful checkpoints."
    })
  };
}

async function progressBodyChanged(progressPath: string, startHash: string | undefined): Promise<boolean> {
  if (!startHash) return false;
  try {
    return bodyHash(await fs.readFile(progressPath, "utf-8")) !== startHash;
  } catch {
    return false;
  }
}

// SessionStart marks the handoff interrupted. A session that did nothing puts back what was there, but only
// while that mark is still this session's own: another session may have ended clean since.
async function bestEffortRestoreHandoff(progressPath: string, state: SessionState, sessionId?: string): Promise<void> {
  if (!sessionId || !state.handoffAtStart) return;
  try {
    const markdown = await fs.readFile(progressPath, "utf-8");
    const frontmatter = parseFrontmatter(markdown);
    if (frontmatter.handoff !== "interrupted" || String(frontmatter.session_id) !== sessionId) return;
    if (state.handoffAtStart === "interrupted") return;
    let restored = replaceFrontmatterValue(markdown, "handoff", state.handoffAtStart);
    if (state.sessionIdAtStart) restored = replaceFrontmatterValue(restored, "session_id", state.sessionIdAtStart);
    await writeFileAtomic(progressPath, restored, sha256(markdown));
  } catch {
    // best effort only
  }
}

export interface HandleStopOptions {
  // Claude Code's Stop hook can block (exit 2) to force the agent to keep
  // working instead of ending its turn. Codex's exit-2 semantics for its
  // equivalent hook are unverified, so callers there must pass false and
  // fall back to the soft, non-blocking warning.
  allowBlock?: boolean;
  provider?: string;
}

export async function handleStop(event: HookEvent, options: HandleStopOptions = {}): Promise<HookResult> {
  const { allowBlock = true } = options;
  const cwd = event.cwd ?? process.cwd();
  const progressPath = progressPathFor(cwd);
  if (!(await pathExists(progressPath))) return { code: 0 };

  const sessionState = await readSessionState(event.session_id);
  // Only nudge when the session did work, so read-only sessions are never nagged. Work is a commit written
  // since start or an uncommitted tree outside project-progress/ that differs from the one at start. Without
  // git there is no other evidence, so an edited Progress.md body counts there; in a git repo a progress-only
  // edit is deliberately not meaningful work (ADR 0006).
  const head = currentHead(cwd);
  const committed =
    sessionState.reflogBytesAtStart === undefined
      ? undefined
      : await committedSince(cwd, sessionState.reflogBytesAtStart);
  const madeCommits = committed ?? Boolean(sessionState.headAtStart && head && head !== sessionState.headAtStart);
  const tree = await treeFingerprint(cwd);
  const treeChanged = tree !== undefined && tree !== (sessionState.treeAtStart ?? CLEAN_TREE);
  const bodyChanged = !head && (await progressBodyChanged(progressPath, sessionState.bodyHash));
  if (!madeCommits && !treeChanged && !bodyChanged) {
    await bestEffortRestoreHandoff(progressPath, sessionState, event.session_id);
    return { code: 0 };
  }

  const warnings: string[] = [];

  let stale = true;
  const startedAt = sessionState.startedAt ? Date.parse(sessionState.startedAt) : NaN;
  if (Number.isFinite(startedAt)) {
    try {
      const freshness = await checkFreshness(progressPath, {
        meaningfulWorkHappened: true,
        sessionStartedAt: new Date(startedAt),
        completionBoundary: true,
        sessionBodyHash: sessionState.bodyHash
      });
      stale = !freshness.isFresh;
    } catch {
      // keep stale = true
    }
  }
  if (stale) {
    // An earlier read-only turn of this session may have restored the handoff; work happened since.
    await bestEffortMarkHandoff(progressPath, "interrupted", event.session_id);
    warnings.push(
      "project-progress/Progress.md was not updated this session. If you did meaningful work, " +
        "update Resume Snapshot, Next Action, and Blockers before finishing."
    );
  }

  if (!stale) {
    // Only stamp when the agent actually updated Progress.md this session.
    // Stamping an unchanged file would assert a verification that never happened.
    const recorded = await bestEffortRecordSessionEnd(cwd, progressPath, new Date(), options.provider);
    if (!recorded) {
      warnings.push(
        "Checkpoint and handoff were not recorded; drift detection may be unavailable next session."
      );
    }
  }

  try {
    const errors = await validateProgressFile(progressPath);
    const secretErrors = errors.filter((error) => error.includes("secret-like"));
    if (secretErrors.length > 0) {
      warnings.push(`Progress file may contain secrets (${secretErrors.join("; ")}); remove them.`);
    }
    // Shown once per session: these persist until someone edits the files, and
    // repeating them on every stop turns a report into noise.
    if (!sessionState.healthShown) {
      const health = await bestEffortHealth(progressPath);
      const problems = [
        ...health.map((finding) => finding.message),
        ...errors.filter((error) => !error.includes("secret-like"))
      ];
      if (problems.length > 0) {
        const command = health.some((finding) => finding.remedy === "compact") ? compactCommand(cwd) : undefined;
        warnings.push(summarizeProblems(problems, command));
        if (event.session_id) {
          await writeSessionState(event.session_id, { ...(await readSessionState(event.session_id)), healthShown: true });
        }
      }
    }
  } catch {
    // validation is best effort
  }

  if (warnings.length === 0) return { code: 0 };

  const message = `[project-progress] ${warnings.join(" ")}`;

  if (stale && allowBlock) {
    const state = await readSessionState(event.session_id);
    if (!state.stopBlocked) {
      if (event.session_id) {
        await writeSessionState(event.session_id, { ...state, stopBlocked: true });
      }
      // Exit code 2 blocks Claude Code's Stop event and feeds stderr back so
      // the agent keeps working instead of ending its turn. Capped to once
      // per session (via stopBlocked) so a session that truly can't update
      // Progress.md doesn't loop forever.
      return { code: 2, stderr: message };
    }
  }

  // `systemMessage` is the portable output field surfaced to the user by both
  // Claude Code and Codex; keep the "[project-progress]" prefix for grep-ability.
  return { code: 0, stdout: emitJson({ systemMessage: message }) };
}

export async function runHook(sub: string, event: HookEvent, options: { provider?: string } = {}): Promise<HookResult> {
  try {
    switch (sub) {
      case "session-start":
        return await handleSessionStart(event);
      case "user-prompt-submit":
        return await handleUserPromptSubmit(event);
      case "pre-commit":
        return await handlePreCommit(event);
      case "pre-edit":
        return await handlePreEdit(event);
      case "stop":
        return await handleStop(event, { provider: options.provider });
      case "stop-soft":
        return await handleStop(event, { allowBlock: false, provider: options.provider });
      default:
        return { code: 0 };
    }
  } catch {
    // Never break a session because of a hook failure.
    return { code: 0 };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function main(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "";
  const provider = providerFromArgv(argv.slice(1));
  const raw = await readStdin();
  let event: HookEvent = {};
  if (raw.trim()) {
    try {
      event = JSON.parse(raw) as HookEvent;
    } catch {
      event = {};
    }
  }
  const result = await runHook(sub, event, { provider });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(0)
  );
}
