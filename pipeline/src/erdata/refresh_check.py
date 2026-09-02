"""Checks upstream for new commits and, if found, updates sources.lock.json's pinned
SHAs. Does not run the pipeline itself -- the refresh-data workflow does that as a
separate step, so a rebuild failure doesn't leave the lockfile pointing at a SHA whose
data was never actually generated.

    uv run python -m erdata.refresh_check          # updates the lockfile if changed
    uv run python -m erdata.refresh_check --check   # exit 1 if an update is available, no write
"""

import subprocess
import sys
from datetime import UTC, datetime

from erdata.paths import LOCKFILE, load_lock


def latest_commit(repo_url: str, branch: str) -> str:
    out = subprocess.run(
        ["git", "ls-remote", repo_url, f"refs/heads/{branch}"],
        check=True, capture_output=True, text=True,
    ).stdout
    sha = out.split()[0]
    return sha


def main() -> int:
    check_only = "--check" in sys.argv
    lock = load_lock()
    changed = False

    for name, spec in lock["sources"].items():
        latest = latest_commit(spec["repo"], spec["branch"])
        if latest != spec["sha"]:
            print(f"{name}: {spec['sha'][:12]} -> {latest[:12]}")
            if not check_only:
                spec["sha"] = latest
                spec["date"] = datetime.now(UTC).replace(microsecond=0).isoformat()
            changed = True
        else:
            print(f"{name}: up to date at {spec['sha'][:12]}")

    if changed and not check_only:
        import json
        LOCKFILE.write_text(json.dumps(lock, indent=2) + "\n")
        print("sources.lock.json updated")

    return 1 if (changed and check_only) else 0


if __name__ == "__main__":
    sys.exit(main())
