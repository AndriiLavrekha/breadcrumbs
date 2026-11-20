# Breadcrumbs v0.8.2-rc.2 (pre-release)

Release candidate for testing. **Not the latest release**: v0.8.1 stays the stable version. Please run [`MANUAL_TESTING.md`](MANUAL_TESTING.md) on Claude Code, Codex, Antigravity and Hermes and report failures.

## What changed since v0.8.2-rc.1

- Health warnings that `compact` cannot fix (for example "Progress.md is 16 KB after compact; shorten long sections") now include a prompt to give the agent. The hint appears in the Stop warning and in the SessionStart `Progress health:` line.

## What changed since v0.8.1

See [`RELEASE_NOTES_v0.8.2-rc.1.md`](RELEASE_NOTES_v0.8.2-rc.1.md).

## Install for testing

```bash
npx -y github:AndriiLavrekha/breadcrumbs#v0.8.2-rc.2 help
```

Or install the attached tarball: `npm install -g andriilavrekha-breadcrumbs-0.8.2-rc.2.tgz`.
