# Breadcrumbs v0.8.2-rc.3 (pre-release)

Release candidate for testing. **Not the latest release**: v0.8.1 stays the stable version. Please run [`MANUAL_TESTING.md`](MANUAL_TESTING.md) on Claude Code, Codex, Antigravity and Hermes and report failures.

## What changed since v0.8.2-rc.2

- `list_projects` no longer looks silently empty. Without `PROJECT_PROGRESS_ROOTS` (the plugin sets none), the index only held projects that were initialized or opened by exact path. `list_projects` and `refresh_projects` now return `rootsConfigured` and a `hint` when roots are unset or indexed projects sit outside them, and say that roots are read at server start, so a session restart is needed after changing them.
- The SessionStart hook adds the current project to the MCP index when it is missing, so any project you have started a session in is listed without configuring roots.
- `breadcrumbs doctor` has a `roots` check that warns (without failing) when roots are unset in this environment or the current project is outside them.

Default discovery is unchanged: nothing is scanned unless `PROJECT_PROGRESS_ROOTS` names it.

## What changed since v0.8.1

See [`RELEASE_NOTES_v0.8.2-rc.1.md`](RELEASE_NOTES_v0.8.2-rc.1.md) and [`RELEASE_NOTES_v0.8.2-rc.2.md`](RELEASE_NOTES_v0.8.2-rc.2.md).

## Install for testing

```bash
npx -y github:AndriiLavrekha/breadcrumbs#v0.8.2-rc.3 help
```

Or install the attached tarball: `npm install -g andriilavrekha-breadcrumbs-0.8.2-rc.3.tgz`.
