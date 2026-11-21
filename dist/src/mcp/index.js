import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists, writeTextAtomic } from "../fs-util.js";
import { discoverProjects } from "./discovery.js";
function defaultHomeDir() {
    return process.env.AWESOME_PROGRESS_TRACKER_HOME ?? os.homedir();
}
export function indexDir(homeDir = defaultHomeDir()) {
    return path.join(homeDir, ".awesome-progress-tracker");
}
export function indexJsonPath(homeDir = defaultHomeDir()) {
    return path.join(indexDir(homeDir), "projects.json");
}
export function indexMarkdownPath(homeDir = defaultHomeDir()) {
    return path.join(indexDir(homeDir), "Projects.md");
}
function sortProjects(projects) {
    return [...projects].sort((left, right) => left.project.localeCompare(right.project));
}
function projectKey(project) {
    return project.progressPath || `${project.path}/${project.project}`;
}
export function mergeProjects(existing, incoming) {
    const byKey = new Map();
    for (const project of existing)
        byKey.set(projectKey(project), project);
    for (const project of incoming)
        byKey.set(projectKey(project), project);
    return sortProjects([...byKey.values()]);
}
function normalizePath(value) {
    if (!value)
        return "";
    const resolved = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function isUnderRoots(targetPath, roots) {
    const target = normalizePath(targetPath);
    if (!target)
        return false;
    return roots.some((root) => {
        const normalizedRoot = normalizePath(root);
        if (!normalizedRoot)
            return false;
        return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
    });
}
const RESTART_NOTE = "Roots are read when the MCP server starts, so restart the agent session after changing PROJECT_PROGRESS_ROOTS.";
// Explains an index that looks empty or partial. Discovery only scans PROJECT_PROGRESS_ROOTS, so
// without this a user cannot tell "no such project" from "project outside the roots".
export function rootsHint(roots, projects) {
    if (roots.length === 0) {
        return ("PROJECT_PROGRESS_ROOTS is not set, so this index only holds projects that were initialized, opened by exact path, or had a session started in them " +
            "(pass a project folder to read_project_progress to add one). To discover projects automatically, set " +
            `PROJECT_PROGRESS_ROOTS (semicolon-separated) in the MCP server's environment. ${RESTART_NOTE}`);
    }
    const outside = projects.filter((project) => !isUnderRoots(project.progressPath, roots));
    if (outside.length === 0)
        return undefined;
    const shown = outside.slice(0, 5).map((project) => project.progressPath).join(", ");
    return (`${outside.length} indexed project(s) are outside PROJECT_PROGRESS_ROOTS and will not be rediscovered by refresh_projects: ` +
        `${shown}${outside.length > 5 ? ", ..." : ""}. Add their parent folder to PROJECT_PROGRESS_ROOTS to scan them. ${RESTART_NOTE}`);
}
export function renderProjectsMarkdown(index) {
    const rows = index.projects
        .map((project) => {
        const safeProject = project.project.replace(/\|/g, "\\|");
        const safeNextAction = project.nextAction.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
        return `| ${safeProject} | ${project.status} | ${project.updated} | ${safeNextAction} | ${project.path} |`;
    })
        .join("\n");
    return `# Breadcrumbs Projects

Updated: ${index.updatedAt}

| Project | Status | Updated | Next Action | Path |
| --- | --- | --- | --- | --- |
${rows}
`;
}
export async function readProjectIndex(options = {}) {
    const filePath = indexJsonPath(options.homeDir);
    if (!(await pathExists(filePath))) {
        return {
            schemaVersion: 1,
            updatedAt: "",
            projects: []
        };
    }
    // The index is only a cache of what discovery can rebuild, so an unreadable file must not take every tool down.
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    }
    catch {
        parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { schemaVersion: 1, updatedAt: "", projects: [] };
    }
    return {
        schemaVersion: 1,
        updatedAt: String(parsed.updatedAt ?? ""),
        projects: Array.isArray(parsed.projects) ? parsed.projects : []
    };
}
export async function writeProjectIndex(index, options = {}) {
    const dir = indexDir(options.homeDir);
    await fs.mkdir(dir, { recursive: true });
    await writeTextAtomic(indexJsonPath(options.homeDir), `${JSON.stringify(index, null, 2)}\n`);
    if (options.writeMarkdown !== false) {
        await writeTextAtomic(indexMarkdownPath(options.homeDir), renderProjectsMarkdown(index));
    }
}
export async function refreshProjectIndex(projectRoots, exclude, options = {}) {
    const existing = await readProjectIndex(options);
    const discovered = await discoverProjects({ projectRoots, exclude });
    const discoveredKeys = new Set(discovered.map((project) => project.progressPath));
    // Discovery is authoritative for the scanned roots. Keep an existing entry only when it is
    // not rediscovered, not inside a scanned root (those are fully re-derived from disk), and its
    // Progress.md still exists. This prunes deleted, moved, and out-of-scope projects instead of
    // accumulating them forever.
    const kept = [];
    for (const project of existing.projects) {
        if (discoveredKeys.has(project.progressPath))
            continue;
        if (isUnderRoots(project.progressPath, projectRoots))
            continue;
        if (!(await pathExists(project.progressPath)))
            continue;
        kept.push(project);
    }
    const updated = {
        schemaVersion: 1,
        updatedAt: (options.now ?? new Date()).toISOString(),
        projects: mergeProjects(kept, discovered)
    };
    await writeProjectIndex(updated, options);
    return updated;
}
export async function upsertIndexedProject(project, options = {}) {
    const existing = await readProjectIndex(options);
    await writeProjectIndex({
        schemaVersion: 1,
        updatedAt: (options.now ?? new Date()).toISOString(),
        projects: mergeProjects(existing.projects, [project])
    }, { ...options, writeMarkdown: false });
}
