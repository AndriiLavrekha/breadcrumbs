import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { defaultGitRunner as git } from "./checkpoint.js";
// Evidence that a session did work, compared against what SessionStart recorded. Progress files never count:
// hooks write them, and a progress-only edit is not meaningful work (ADR 0006).
export function isProgressFile(relativePath) {
    return relativePath.startsWith("project-progress/") || relativePath.includes("/project-progress/");
}
// HEAD reflog actions that move HEAD without writing a commit here: switching branches, reset, pull, clone,
// fast-forward merges, and the lines that bracket a rebase. Every other action counts as a commit, so a
// variant this list has never seen errs toward the reminder rather than toward missed work.
const NON_AUTHORING_ACTION = /^(?:checkout|reset|pull|initial pull|clone|merge [^:]*: Fast-forward|rebase(?: -i)? \((?:start|finish|abort)\))/;
function headReflogPath(cwd) {
    const out = git(cwd, ["rev-parse", "--git-path", "logs/HEAD"])?.trim();
    return out ? path.resolve(cwd, out) : undefined;
}
// Byte length of the HEAD reflog, 0 before the first commit, undefined outside git.
export async function headReflogSize(cwd) {
    const file = headReflogPath(cwd);
    if (!file)
        return undefined;
    try {
        return (await fs.stat(file)).size;
    }
    catch {
        return 0;
    }
}
// Whether a commit was written since the reflog had `offset` bytes. undefined when the reflog cannot tell
// (no git, reflogs disabled, or expired below the offset); callers then fall back to comparing HEAD.
// shortcut: a reflog expired mid-session that regrows past the offset is read from a misaligned point,
// record its first line too if sessions long enough to span `git gc` reflog expiry turn up.
export async function committedSince(cwd, offset) {
    const file = headReflogPath(cwd);
    if (!file)
        return undefined;
    let handle;
    try {
        handle = await fs.open(file, "r");
    }
    catch {
        return undefined;
    }
    try {
        const { size } = await handle.stat();
        if (size < offset)
            return undefined;
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        return buffer
            .toString("utf-8")
            .split("\n")
            .some((line) => line.trim() !== "" && !NON_AUTHORING_ACTION.test(line.slice(line.indexOf("\t") + 1)));
    }
    finally {
        await handle.close();
    }
}
// Fingerprint of the uncommitted tree outside project-progress/: status lines plus size and mtime of each
// dirty file, so a second edit to an already modified file still changes it. undefined outside git.
export async function treeFingerprint(cwd) {
    // -z keeps paths unquoted; --untracked-files=all lists files inside untracked directories.
    const out = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (out === null)
        return undefined;
    const hash = createHash("sha256");
    const entries = out.split("\0");
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4)
            continue;
        // A rename or copy is followed by its source path as a separate entry.
        if (entry[0] === "R" || entry[0] === "C")
            i++;
        const file = entry.slice(3);
        if (isProgressFile(file))
            continue;
        let stamp = "-";
        try {
            const stat = await fs.stat(path.join(cwd, file));
            stamp = `${stat.size}:${stat.mtimeMs}`;
        }
        catch {
            // deleted in the tree: the status line alone describes it
        }
        hash.update(`${entry}\0${stamp}\0`);
    }
    return hash.digest("hex");
}
// The fingerprint of a tree with no uncommitted changes.
export const CLEAN_TREE = createHash("sha256").digest("hex");
