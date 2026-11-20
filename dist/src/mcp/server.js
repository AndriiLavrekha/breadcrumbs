import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { DEFAULT_DISCOVERY_EXCLUDES, discoverProjects } from "./discovery.js";
import { readProjectIndex, refreshProjectIndex, upsertIndexedProject } from "./index.js";
import { extractSection, parseFrontmatter, parseProjectSummary } from "./markdown.js";
import { sha256 } from "../hash.js";
import path from "node:path";
import { MAX_LAST_MILESTONE_LENGTH, MAX_SECTION_CONTENT_LENGTH, appendToArchive, foldDoneSection, replaceFrontmatterValue, replaceSectionWithOperation, updateArchiveFile, writeFileAtomic, ProgressConflictError, validateLastMilestone, validateSectionContent, validateSectionName, todayIso } from "./writer.js";
import { listProjectTrackingStates, resetProjectTrackingState } from "../project-state.js";
import { ALLOWED_GATE_VALUES, ALLOWED_PROGRESS_SECTIONS, ALLOWED_STATUSES, GATE_KEYS } from "../hook/schema.js";
import { PACKAGE_VERSION } from "../package.js";
const DEFAULT_EXCLUDES = DEFAULT_DISCOVERY_EXCLUDES;
const DEFAULT_MAX_PROJECTS = 50;
const DEFAULT_MAX_STRING_LENGTH = 1000;
const DEFAULT_MAX_INDEX_AGE_MS = 24 * 60 * 60 * 1000;
export const projectSelectorSchema = z.string().trim().min(1).max(DEFAULT_MAX_STRING_LENGTH);
export const progressSectionSchema = z.enum(ALLOWED_PROGRESS_SECTIONS);
export const sectionContentSchema = z.string().max(MAX_SECTION_CONTENT_LENGTH);
export const lastMilestoneSchema = z.string().trim().min(1).max(MAX_LAST_MILESTONE_LENGTH);
// Derived from GATE_KEYS so a new gate cannot be readable but unwritable.
const GATE_FIELDS = GATE_KEYS.map((key) => key.slice("gate_".length));
export const gateValueSchema = z.enum(ALLOWED_GATE_VALUES);
// Emits [frontmatterKey, value] pairs for supplied gates only, in a fixed
// order so writes are deterministic regardless of argument order.
export function gateFrontmatterUpdates(gates) {
    const updates = [];
    for (const field of GATE_FIELDS) {
        const value = gates[field];
        if (value === undefined)
            continue;
        updates.push([`gate_${field}`, value]);
    }
    return updates;
}
export const toolDefinitions = [
    { name: "list_projects" },
    { name: "refresh_projects" },
    { name: "read_project_progress" },
    { name: "update_project_progress" },
    { name: "mark_project_status" },
    { name: "set_project_gates" }
];
export function rootsFromEnv(value = process.env.PROJECT_PROGRESS_ROOTS) {
    return (value ?? "")
        .split(";")
        .map((root) => root.trim())
        .filter((root) => root.length > 0);
}
function truncateString(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    if (maxLength <= 3)
        return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
}
function boundString(value, maxLength) {
    return truncateString(value ?? "", maxLength);
}
export function boundProjectSummaries(projects, options = {}) {
    const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
    const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    return projects.slice(0, maxProjects).map((project) => ({
        ...project,
        progressPath: boundString(project.progressPath, maxStringLength),
        project: boundString(project.project, maxStringLength),
        path: boundString(project.path, maxStringLength),
        updated: boundString(project.updated, maxStringLength),
        lastMilestone: boundString(project.lastMilestone, maxStringLength),
        deploymentUrl: boundString(project.deploymentUrl, maxStringLength),
        resumeSnapshot: boundString(project.resumeSnapshot, maxStringLength),
        nextAction: boundString(project.nextAction, maxStringLength),
        blockers: boundString(project.blockers, maxStringLength),
        lastRuntime: boundString(project.lastRuntime, maxStringLength)
    }));
}
export function compactProjectListItem(project) {
    const nextAction = truncateString(project.nextAction, DEFAULT_MAX_STRING_LENGTH);
    return {
        project: project.project,
        status: project.status,
        updated: project.updated,
        nextAction,
        path: project.path,
        truncatedFields: nextAction === project.nextAction ? [] : ["nextAction"]
    };
}
export async function projectsJson(filter) {
    const index = await readProjectIndex();
    const projects = index.projects;
    const filtered = filter ? projects.filter((project) => filter(project.status)) : projects;
    const items = filtered.slice(0, DEFAULT_MAX_PROJECTS).map(compactProjectListItem);
    const indexedAt = Date.parse(index.updatedAt);
    const indexAgeMs = Number.isFinite(indexedAt) ? Math.max(0, Date.now() - indexedAt) : null;
    const result = {
        items,
        total: filtered.length,
        returned: items.length,
        truncated: items.length < filtered.length,
        indexUpdatedAt: index.updatedAt,
        indexAgeMs,
        refreshRecommended: indexAgeMs === null || indexAgeMs > DEFAULT_MAX_INDEX_AGE_MS
    };
    return JSON.stringify(result);
}
function matchesSelector(project, selector) {
    return (project.project === selector ||
        project.path === selector ||
        project.progressPath === selector);
}
function dedupeByProgressPath(projects) {
    return [...new Map(projects.map((project) => [project.progressPath, project])).values()];
}
// A selector naming a Progress.md, its project-progress directory, or its project directory,
// tried directly on disk. Unlike root scanning (which stays opt-in via PROJECT_PROGRESS_ROOTS
// so an unconfigured server never silently reads the launch cwd), this only ever touches the
// exact path the caller typed — it can't surface anything the caller didn't already name.
function looksLikePath(selector) {
    return path.isAbsolute(selector) || /[\\/]/.test(selector) || selector === "." || selector === "..";
}
async function resolveLiteralProgressPath(selector) {
    const base = path.resolve(selector);
    const candidates = [
        base,
        path.join(base, "project-progress", "Progress.md"),
        path.join(base, "Progress.md")
    ];
    for (const candidate of candidates) {
        if (path.basename(candidate) !== "Progress.md")
            continue;
        try {
            const stat = await fs.stat(candidate);
            if (stat.isFile())
                return candidate;
        }
        catch {
            // not present at this candidate, try the next
        }
    }
    return undefined;
}
// Resolve a project by exact name, path, or progressPath. Names are not unique, so an
// ambiguous selector returns an error listing candidate paths instead of silently editing
// whichever entry happened to be found first.
export async function resolveProject(selector) {
    const index = await readProjectIndex();
    let candidates = dedupeByProgressPath(index.projects.filter((project) => matchesSelector(project, selector)));
    // Checkouts outside PROJECT_PROGRESS_ROOTS (a fresh clone, a benchmark fixture, a temp
    // worktree) are invisible to root scanning by design. If the caller named an exact path to
    // one, honor it directly instead of forcing a re-install just to move Progress.md.
    // A bare name is a project name: reading it as a folder under the server's cwd would let any
    // same-named folder there shadow the project the caller meant, so only path-shaped selectors go to disk.
    if (candidates.length === 0 && looksLikePath(selector)) {
        const literalPath = await resolveLiteralProgressPath(selector);
        if (literalPath) {
            const markdown = await fs.readFile(literalPath, "utf-8");
            const project = parseProjectSummary(markdown, literalPath);
            await upsertIndexedProject(project);
            candidates = [project];
        }
    }
    if (candidates.length === 0) {
        const discovered = await discoverProjects({
            projectRoots: rootsFromEnv(),
            exclude: DEFAULT_EXCLUDES
        });
        candidates = dedupeByProgressPath(discovered.filter((project) => matchesSelector(project, selector)));
        // Remember what the walk found so the next call does not repeat it.
        for (const project of candidates) {
            await upsertIndexedProject(project).catch(() => undefined);
        }
    }
    if (candidates.length === 0) {
        const normalized = selector.toLowerCase();
        const suggestions = index.projects
            .filter((project) => project.project.toLowerCase().includes(normalized))
            .slice(0, 5)
            .map(({ project, path, progressPath }) => ({ project, path, progressPath }));
        return { error: "project not found", suggestions };
    }
    if (candidates.length > 1) {
        // The progressPath, not the project directory: a worktree checkout puts a
        // second Progress.md under one project, so listing directories would print
        // the same string twice and tell the caller nothing about how to pick one.
        const paths = candidates.map((project) => project.progressPath || project.path).join(", ");
        return {
            error: `ambiguous project selector "${selector}" matches ${candidates.length} projects: ${paths}. Pass an exact path instead.`
        };
    }
    return { project: candidates[0] };
}
export async function refreshProjectsJson() {
    const index = await refreshProjectIndex(rootsFromEnv(), DEFAULT_EXCLUDES);
    return JSON.stringify({
        refreshed: true,
        updatedAt: index.updatedAt,
        total: index.projects.length
    });
}
export async function projectTrackingStateJson(options = {}) {
    return JSON.stringify(await listProjectTrackingStates(options));
}
export async function resetProjectTrackingStateJson(project, options = {}) {
    return JSON.stringify({
        reset: await resetProjectTrackingState(project, options),
        path: project.replace(/\\/g, "/")
    });
}
// Builds the payload a caller needs in order to merge and retry without a
// second round trip: the current content of the section it tried to write, or
// the current values of the frontmatter keys it tried to set.
export function conflictPayload(currentMarkdown, options) {
    const payload = {
        error: "conflict",
        hint: "another writer changed Progress.md; merge with the current values and retry"
    };
    if (options.section) {
        payload.section = options.section;
        payload.currentContent = extractSection(currentMarkdown, options.section);
    }
    if (options.keys && options.keys.length > 0) {
        const frontmatter = parseFrontmatter(currentMarkdown);
        payload.currentFrontmatter = Object.fromEntries(options.keys.map((key) => [key, frontmatter[key] ?? null]));
    }
    return payload;
}
// Called after the guarded Progress.md write (ADR 0020). Progress.md has
// already dropped these items, so a failed archive write hands them back
// instead of losing them.
export async function archiveFoldedItems(progressPath, items) {
    if (items.length === 0)
        return {};
    try {
        await updateArchiveFile(path.dirname(progressPath), (current) => appendToArchive(current, items));
        return {};
    }
    catch (error) {
        return {
            archiveError: error instanceof Error ? error.message : String(error),
            archiveHint: "Progress.md is saved. Archive.md was not updated; append unarchivedItems to Archive.md or add them back to Done.",
            unarchivedItems: items
        };
    }
}
// Built directly rather than through invalidRequest/errorResult, which would discard currentContent and
// currentFrontmatter — the entire reason the conflict payload exists. The merge data survives to the
// caller while isError still marks the failure.
async function conflictResult(error, progressPath, options) {
    if (!(error instanceof ProgressConflictError))
        throw error;
    const current = await fs.readFile(progressPath, "utf-8");
    const payload = conflictPayload(current, options);
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true
    };
}
export function successResult(structuredContent, text) {
    return {
        content: [
            {
                type: "text",
                text
            }
        ],
        structuredContent,
        isError: false
    };
}
export function errorResult(code, message, hint) {
    return {
        content: [
            {
                type: "text",
                text: `${message} ${hint}`
            }
        ],
        structuredContent: { error: { code, message, hint } },
        isError: true
    };
}
function invalidRequest(message) {
    return errorResult("invalid_request", message, "Correct the request and retry.");
}
function jsonResult(payload) {
    return successResult(payload, JSON.stringify(payload));
}
export function createServer() {
    const server = new McpServer({ name: "breadcrumbs", version: PACKAGE_VERSION });
    server.registerTool("list_projects", {
        description: "List compact summaries from the cached project index. Filter by status when needed.",
        inputSchema: {
            status: z.enum(ALLOWED_STATUSES).optional()
        }
    }, async ({ status }) => {
        const text = await projectsJson(status ? (projectStatus) => projectStatus === status : undefined);
        return successResult(JSON.parse(text), text);
    });
    server.registerTool("refresh_projects", {
        description: "Refresh the project index by scanning PROJECT_PROGRESS_ROOTS for project-progress/Progress.md files."
    }, async () => {
        const text = await refreshProjectsJson();
        return successResult(JSON.parse(text), text);
    });
    server.registerTool("read_project_progress", {
        description: "Read one compact project progress summary.",
        inputSchema: {
            project: projectSelectorSchema
        }
    }, async ({ project }) => {
        const resolution = await resolveProject(project);
        if (resolution.error)
            return invalidRequest(resolution.error);
        // The index is a cache that only MCP writes refresh; resuming from it would hide hand edits to Progress.md.
        let current;
        try {
            current = parseProjectSummary(await fs.readFile(resolution.project.progressPath, "utf-8"), resolution.project.progressPath);
        }
        catch {
            return errorResult("read_failed", `Could not read ${resolution.project.progressPath}.`, "Check that the file exists, or run refresh_projects.");
        }
        return jsonResult(boundProjectSummaries([current])[0]);
    });
    server.registerTool("update_project_progress", {
        description: "Replace or append a named section in a project's Progress.md.",
        inputSchema: {
            project: projectSelectorSchema,
            section: progressSectionSchema,
            content: sectionContentSchema
        }
    }, async ({ project, section, content }) => {
        const sectionError = validateSectionName(section);
        if (sectionError)
            return invalidRequest(sectionError);
        const contentError = validateSectionContent(content);
        if (contentError)
            return invalidRequest(contentError);
        const resolution = await resolveProject(project);
        if (resolution.error)
            return invalidRequest(resolution.error);
        const match = resolution.project;
        const markdown = await fs.readFile(match.progressPath, "utf-8");
        const expectedHash = sha256(markdown);
        let sectionContent = content;
        let archived = [];
        if (section === "Done") {
            const fold = foldDoneSection(content);
            sectionContent = fold.kept;
            archived = fold.archived;
        }
        const result = replaceSectionWithOperation(markdown, section, sectionContent);
        const updated = replaceFrontmatterValue(result.markdown, "updated", todayIso());
        try {
            await writeFileAtomic(match.progressPath, updated, expectedHash);
        }
        catch (error) {
            return await conflictResult(error, match.progressPath, { section });
        }
        // Right after the guarded write lands (ADR 0020), before anything else that can throw.
        const archive = await archiveFoldedItems(match.progressPath, archived);
        await upsertIndexedProject(parseProjectSummary(updated, match.progressPath));
        return jsonResult({
            updated: true,
            operation: result.operation,
            project,
            section,
            archived: archive.unarchivedItems ? 0 : archived.length,
            ...archive,
            updatedAt: new Date().toISOString(),
            progressPath: match.progressPath
        });
    });
    server.registerTool("mark_project_status", {
        description: "Update frontmatter status and last_milestone in a project's Progress.md.",
        inputSchema: {
            project: projectSelectorSchema,
            status: z.enum(ALLOWED_STATUSES),
            last_milestone: lastMilestoneSchema
        }
    }, async ({ project, status, last_milestone }) => {
        const milestoneError = validateLastMilestone(last_milestone);
        if (milestoneError)
            return invalidRequest(milestoneError);
        const resolution = await resolveProject(project);
        if (resolution.error)
            return invalidRequest(resolution.error);
        const match = resolution.project;
        const markdown = await fs.readFile(match.progressPath, "utf-8");
        const expectedHash = sha256(markdown);
        const withStatus = replaceFrontmatterValue(markdown, "status", status);
        const updated = replaceFrontmatterValue(replaceFrontmatterValue(withStatus, "last_milestone", last_milestone), "updated", todayIso());
        try {
            await writeFileAtomic(match.progressPath, updated, expectedHash);
        }
        catch (error) {
            return await conflictResult(error, match.progressPath, {
                keys: ["status", "last_milestone"]
            });
        }
        await upsertIndexedProject(parseProjectSummary(updated, match.progressPath));
        return jsonResult({ updated: true, project, status, progressPath: match.progressPath });
    });
    server.registerTool("set_project_gates", {
        description: "Set verification gates (implementation, tests, review, deploy) in a project's Progress.md frontmatter. Only supplied gates are written.",
        inputSchema: {
            project: projectSelectorSchema,
            implementation: gateValueSchema.optional(),
            tests: gateValueSchema.optional(),
            review: gateValueSchema.optional(),
            deploy: gateValueSchema.optional()
        }
    }, async ({ project, implementation, tests, review, deploy }) => {
        const updates = gateFrontmatterUpdates({ implementation, tests, review, deploy });
        if (updates.length === 0) {
            return invalidRequest("at least one gate must be supplied");
        }
        const resolution = await resolveProject(project);
        if (resolution.error)
            return invalidRequest(resolution.error);
        const match = resolution.project;
        const markdown = await fs.readFile(match.progressPath, "utf-8");
        const expectedHash = sha256(markdown);
        let updated = markdown;
        for (const [key, value] of updates) {
            updated = replaceFrontmatterValue(updated, key, value);
        }
        updated = replaceFrontmatterValue(updated, "updated", todayIso());
        try {
            await writeFileAtomic(match.progressPath, updated, expectedHash);
        }
        catch (error) {
            return await conflictResult(error, match.progressPath, {
                keys: updates.map(([key]) => key)
            });
        }
        await upsertIndexedProject(parseProjectSummary(updated, match.progressPath));
        return jsonResult({
            updated: true,
            project,
            gates: Object.fromEntries(updates),
            progressPath: match.progressPath
        });
    });
    return server;
}
export async function main() {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
