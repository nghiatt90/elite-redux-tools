"""Parse er-config textproto files into their generated message types."""

from google.protobuf import text_format
from google.protobuf.message import Message

from erdata.generated import AbilityList_pb2, MoveList_pb2, SpeciesList_pb2
from erdata.paths import ER_CONFIG


def _parse(filename: str, message_cls: type[Message]) -> Message:
    msg = message_cls()
    text = (ER_CONFIG / filename).read_bytes()
    text_format.Parse(text, msg)
    return msg


def parse_species() -> list:
    return list(_parse("SpeciesList.textproto", SpeciesList_pb2.SpeciesList).species)


def parse_moves() -> list:
    return list(_parse("MoveList.textproto", MoveList_pb2.MoveList).moves)


def parse_abilities() -> list:
    return list(_parse("AbilityList.textproto", AbilityList_pb2.AbilityList).ability)


if __name__ == "__main__":
    species = parse_species()
    moves = parse_moves()
    abilities = parse_abilities()
    print(f"species={len(species)} moves={len(moves)} abilities={len(abilities)}")
    assert len(species) == 1911, len(species)
    assert len(moves) == 1032, len(moves)
    assert len(abilities) == 1044, len(abilities)
    print("ok")
