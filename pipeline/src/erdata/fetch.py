"""Fetch upstream Elite Redux sources at the SHAs pinned in sources.lock.json."""

import subprocess
import sys
from pathlib import Path

from erdata.paths import UPSTREAM, load_lock


def _git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def _head(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    try:
        return _git("rev-parse", "HEAD", cwd=path)
    except subprocess.CalledProcessError:
        return None


def fetch_one(name: str, spec: dict) -> Path:
    dest = UPSTREAM / name
    sha = spec["sha"]

    if _head(dest) == sha:
        print(f"{name}: already at {sha[:12]}")
        return dest

    if not (dest / ".git").exists():
        dest.mkdir(parents=True, exist_ok=True)
        _git("init", "-q", cwd=dest)
        _git("remote", "add", "origin", spec["repo"], cwd=dest)

    if spec["sparse_paths"]:
        _git("config", "core.sparseCheckout", "true", cwd=dest)
        _git("sparse-checkout", "init", "--cone", cwd=dest)
        _git("sparse-checkout", "set", *spec["sparse_paths"], cwd=dest)

    print(f"{name}: fetching {sha[:12]} (blobless partial clone)")
    _git("fetch", "--filter=blob:none", "--depth=1", "origin", sha, cwd=dest)
    _git("checkout", "-q", "--detach", sha, cwd=dest)
    return dest


def main() -> int:
    lock = load_lock()
    UPSTREAM.mkdir(parents=True, exist_ok=True)
    for name, spec in lock["sources"].items():
        fetch_one(name, spec)
    return 0


if __name__ == "__main__":
    sys.exit(main())
