"""Parse er-config textproto files into their generated message types."""

from google.protobuf import text_format
from google.protobuf.message import Message

from erdata.generated import AbilityList_pb2, ItemList_pb2, MoveList_pb2, SpeciesList_pb2
from erdata.paths import ER_CONFIG


def _parse(path, message_cls: type[Message]) -> Message:
    msg = message_cls()
    text = path.read_bytes()
    text_format.Parse(text, msg)
    return msg


def _parse_config(filename: str, message_cls: type[Message]) -> Message:
    return _parse(ER_CONFIG / filename, message_cls)


def parse_species() -> list:
    return list(_parse_config("SpeciesList.textproto", SpeciesList_pb2.SpeciesList).species)


def parse_moves() -> list:
    return list(_parse_config("MoveList.textproto", MoveList_pb2.MoveList).moves)


def parse_abilities() -> list:
    return list(_parse_config("AbilityList.textproto", AbilityList_pb2.AbilityList).ability)


# Items aren't one file like species/moves/abilities -- er-config splits them by
# pocket (items/MegaStonesList.textproto, items/BerriesList.textproto, etc, one
# ItemList message each; "Unused" is er-config's own name for the file, not something
# this pipeline decided to exclude). Every *.textproto directly under items/ is
# parsed and concatenated, sorted by filename, so a new pocket file upstream adds
# itself here without a code change.
def parse_items() -> list:
    items = []
    for path in sorted((ER_CONFIG / "items").glob("*.textproto")):
        items.extend(_parse(path, ItemList_pb2.ItemList).item)
    return items


if __name__ == "__main__":
    species = parse_species()
    moves = parse_moves()
    abilities = parse_abilities()
    items = parse_items()
    print(f"species={len(species)} moves={len(moves)} abilities={len(abilities)} items={len(items)}")
    assert len(species) == 1911, len(species)
    assert len(moves) == 1032, len(moves)
    assert len(abilities) == 1044, len(abilities)
    assert len(items) == 929, len(items)
    print("ok")
