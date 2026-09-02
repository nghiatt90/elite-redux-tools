import subprocess
import sys

import pytest

from erdata.paths import ER_CONFIG, GENERATED


@pytest.fixture(scope="session", autouse=True)
def _ensure_data_available():
    if not ER_CONFIG.exists():
        subprocess.run([sys.executable, "-m", "erdata.fetch"], check=True)
    if not GENERATED.exists():
        subprocess.run([sys.executable, "-m", "erdata.compile_protos"], check=True)
