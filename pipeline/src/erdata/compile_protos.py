"""Compile er-config's .proto files into Python modules using grpcio-tools' bundled protoc."""

import shutil
import sys

from grpc_tools import protoc

from erdata.paths import ER_CONFIG, GENERATED


def main() -> int:
    if not ER_CONFIG.exists():
        print("er-config not fetched; run `python -m erdata.fetch` first", file=sys.stderr)
        return 1

    if GENERATED.exists():
        shutil.rmtree(GENERATED)
    GENERATED.mkdir(parents=True)
    (GENERATED / "__init__.py").write_text("")

    protos = sorted(p.name for p in ER_CONFIG.glob("*.proto"))
    args = [
        "protoc",
        f"--proto_path={ER_CONFIG}",
        f"--python_out={GENERATED}",
        f"--pyi_out={GENERATED}",
        *protos,
    ]
    rc = protoc.main(args)
    if rc != 0:
        return rc

    # Generated modules import each other as top-level names (`import MoveEnum_pb2`),
    # so the package dir has to be importable as a path root.
    (GENERATED / "__init__.py").write_text(
        "import sys\nfrom pathlib import Path\n\n"
        "sys.path.insert(0, str(Path(__file__).parent))\n"
    )
    print(f"compiled {len(protos)} protos -> {GENERATED.relative_to(ER_CONFIG.parents[3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
