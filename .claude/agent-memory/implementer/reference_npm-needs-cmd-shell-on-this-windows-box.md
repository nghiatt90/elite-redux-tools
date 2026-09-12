---
name: npm-needs-cmd-shell-on-this-windows-box
description: On this machine, npm cannot be launched from PowerShell directly -- use the PowerShell tool's own cmd-wrapper invocation or a plain cmd.exe, not a raw `npm ...` line in a PowerShell session
metadata:
  type: reference
---

On this Windows machine, invoking `npm` directly from an interactive PowerShell
session fails: PowerShell's execution policy is undefined (not just Restricted) in
every scope checked, `pwsh` (PowerShell 7+) is not installed, and the npm-provided
`npm.ps1` shim is blocked as a result -- so `npm run <script>` typed straight into
PowerShell throws a `PSSecurityException` before npm itself ever runs. This is a
machine/environment fact, unrelated to any project code.

**How to apply:** don't diagnose this as a project bug when it shows up -- it will
look like "npm is broken" or "the dev server won't start" and waste time chasing the
wrong cause. Confirmed working invocations on this box:
- The `Bash` tool (Git Bash) calling `npm --prefix <path> run <script>` -- npm still
  runs its OWN package.json scripts through cmd.exe regardless of the invoking shell,
  but the `npm` command itself resolves fine from Git Bash.
- `cmd /c "npm run <script>"` (or the PowerShell tool's own default invocation style,
  which goes through the command-shell wrapper rather than a bare `npm ...` line).

Don't invoke `npm ...` as a bare command in a raw PowerShell session on this
machine; wrap it or use Bash instead. See also
[Sprite PNG non-determinism cause](reference_sprite-png-nondeterminism-cause.md) for
another environment quirk worth knowing before assuming a real bug.
