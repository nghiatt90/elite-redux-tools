---
name: windows-npm-and-shell-verification
description: Measured -- npm runs package.json scripts through cmd.exe on this machine, and plain `npm` fails in Windows PowerShell; use npm.cmd to verify a build
metadata:
  type: project
---

Two environment facts settled on 2026-09-13 while verifying the data-sync batch. Do not
re-derive them; they change how a `web/` batch gets verified.

- **npm script shell is cmd.exe.** `npm config get script-shell` is `null` and there is no
  `.npmrc` at the repo root or in `web/`, so npm falls back to `ComSpec`. A POSIX one-liner
  in a `scripts` entry (`rm -rf x && mkdir -p x && cp -r ...`) prints "The syntax of the
  command is incorrect." and **exits 1**, which fails the whole `prebuild`/`predev` chain.
  Reproduced with a throwaway `package.json` in the scratchpad. This holds no matter which
  shell invoked npm, so "it works in Git Bash" is not evidence. Any `scripts` entry that is
  not a single program invocation is a finding.
- **`npm` cannot launch from powershell.exe here.** `Get-ExecutionPolicy -List` is
  `Undefined` in every scope (so: Restricted), `pwsh` is not installed, and `npm.ps1` is
  therefore blocked with a `PSSecurityException`. To verify a build the way the user does,
  call `& npm.cmd --prefix <abs web dir> run build`. Plain `npm ...` under
  `powershell.exe -NoProfile` fails before reaching any project code and must not be
  reported as a batch failure.

**Why:** a reviewer who tests `web/` scripts only through the Bash tool (Git Bash) will
pass a script that is broken for the user, and one who tests through PowerShell naively will
report a false failure.

**How to apply:** for anything touching `web/package.json` scripts, reproduce the script
under npm itself rather than reading it. See [[react-layer-review-gates]].
