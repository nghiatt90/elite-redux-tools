"""Orchestrates a full pipeline run against whatever SHAs are pinned in
sources.lock.json: fetch -> compile protos -> emit JSON -> generate sprites.

    uv run python -m erdata.build
"""

import sys

from erdata import compile_protos, emit, fetch, sprites
from erdata.paths import game_version, output_dir


def main() -> int:
    print(f"building {game_version()}")
    fetch.main()
    rc = compile_protos.main()
    if rc:
        return rc
    emit.build()
    sprites.build_sprites()
    print(f"done -> {output_dir()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
