# Breadcrumbs v0.8.1

Patch release for the `npx github:` MCP integrations on npm 12+ and for Hermes MCP status reporting.

## Fixes

- Generated MCP configs (Hermes, Codex, CLI-written Claude JSON) set `npm_config_allow_git=all`, so `npx -y github:AndriiLavrekha/breadcrumbs mcp` starts under npm 12+ instead of failing with `EALLOWGIT`. The setting applies to that `npx` process only.
- Hermes `mcp add` now receives both environment assignments under a single `--env` flag.
- Hermes `mcp list` parsing reads the status column. A server saved as disabled is rolled back on `install` and reported as not configured by `status` and `doctor`.
- The `mcp list` parser ignores title lines above the header and footer text below the table, so they are never read as servers.

## Upgrade

```bash
breadcrumbs uninstall -g hermes
breadcrumbs install -g hermes
```

Claude Code and Codex plugin installs are unaffected. Restart the agent afterwards. No project-data migration is required.
