import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PIPELINE_ROOT = REPO_ROOT / "pipeline"
UPSTREAM = PIPELINE_ROOT / ".upstream"
GENERATED = PIPELINE_ROOT / "src" / "erdata" / "generated"
DATA_ROOT = REPO_ROOT / "data"
LOCKFILE = REPO_ROOT / "sources.lock.json"

ER_CONFIG = UPSTREAM / "er-config"
ER_SOURCE = UPSTREAM / "eliteredux-source"


def load_lock() -> dict:
    return json.loads(LOCKFILE.read_text())


def game_version() -> str:
    return load_lock()["game_version"]


def output_dir() -> Path:
    return DATA_ROOT / game_version()
