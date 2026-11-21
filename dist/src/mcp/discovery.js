import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "../fs-util.js";
import { parseProjectSummary } from "./markdown.js";
export const DEFAULT_DISCOVERY_EXCLUDES = [".git", "node_modules", "vendor", ".cache", ".venv", "dist"];
export function rootsFromEnv(value = process.env.PROJECT_PROGRESS_ROOTS) {
    return (value ?? "")
        .split(";")
        .map((root) => root.trim())
        .filter((root) => root.length > 0);
}
async function mapWithConcurrency(items, limit, run) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await run(items[index]);
        }
    });
    await Promise.all(workers);
}
async function walk(root, exclude, found, diagnostics, isRoot = false) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        diagnostics.unreadableDirectories.push(root);
        if (isRoot)
            diagnostics.skippedRoots.push(root);
        return;
    }
    await mapWithConcurrency(entries, 8, async (entry) => {
        if (!entry.isDirectory() || exclude.has(entry.name))
            return;
        const fullPath = path.join(root, entry.name);
        if (entry.name === "project-progress") {
            const progressPath = path.join(fullPath, "Progress.md");
            if (await pathExists(progressPath))
                found.push(progressPath);
            return;
        }
        await walk(fullPath, exclude, found, diagnostics);
    });
}
export async function discoverProjectsWithDiagnostics(config) {
    const found = [];
    const exclude = new Set(config.exclude);
    const diagnostics = { skippedRoots: [], unreadableDirectories: [] };
    await mapWithConcurrency(config.projectRoots, 4, (root) => walk(root, exclude, found, diagnostics, true));
    const projects = await Promise.all(found.map(async (progressPath) => {
        const markdown = await fs.readFile(progressPath, "utf-8");
        return parseProjectSummary(markdown, progressPath);
    }));
    return { projects: projects.sort((left, right) => left.project.localeCompare(right.project)), diagnostics };
}
export async function discoverProjects(config) {
    return (await discoverProjectsWithDiagnostics(config)).projects;
}
