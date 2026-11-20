# Breadcrumbs v0.8.2-rc.1 (pre-release)

Release candidate for testing. **Not the latest release**: v0.8.1 stays the stable version. Please run [`MANUAL_TESTING.md`](MANUAL_TESTING.md) on Claude Code, Codex, Antigravity and Hermes and report failures.

## What changed since v0.8.1

- All 20 findings of the 2026-11-19 audit are fixed (`docs/breadcrumbs_audit_2026-11-19.md`).
- Hooks: `git commit -a` and broad `git add` are blocked when progress is restricted (fail closed); Stop counts commits and only work done this session; the session baseline survives a repeated SessionStart after compaction; the start handoff is restored; all `project-progress` Markdown files are scanned for secrets; state files older than 30 days are pruned.
- MCP: reads use the real file, writes set `updated`, root scans are cached; index and project state are written atomically and corrupt files are tolerated; gate updates refresh the index; `$` sequences in frontmatter values are no longer expanded; bare project names fall back to the cwd folder.
- Init keeps existing files; doctor checks the real index folder.
- Removed the unused standalone hook CLI and wrappers.
- Dependencies pinned and updated to patched versions (`npm audit` clean); CI added; `.gitattributes` forces LF.

## Install for testing

```bash
npx -y github:AndriiLavrekha/breadcrumbs#v0.8.2-rc.1 help
```

Or install the attached tarball: `npm install -g andriilavrekha-breadcrumbs-0.8.2-rc.1.tgz`.
