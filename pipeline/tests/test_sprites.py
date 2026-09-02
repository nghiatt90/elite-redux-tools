from erdata.generated import SpeciesEnum_pb2
from erdata.parse import parse_species
from erdata.resolve import build_species_map
from erdata.sprites import _ICON_FRAME, _first_frame, generate_species_sprites, species_sprites

_S = SpeciesEnum_pb2.SpeciesEnum.Name


def _by_name(species, name):
    return next(s for s in species if _S(s.id) == name)


def test_pikachu_sprite_sources_resolve_correctly():
    species = parse_species()
    species_map = build_species_map(species)
    pikachu = _by_name(species, "SPECIES_PIKACHU")

    src = species_sprites(pikachu, species_map)
    assert src["front"].name == "anim_front.png"  # the frame sheet, not a plain front.png
    assert src["front"].parent.name == "pikachu"
    assert src["icon_palette_index"] == 2  # shared icon palette table, not pikachu's own .pal


def test_reuse_visuals_and_reuse_icon_resolve_to_the_base_species():
    species = parse_species()
    species_map = build_species_map(species)
    arceus_fighting = _by_name(species, "SPECIES_ARCEUS_FIGHTING")

    src = species_sprites(arceus_fighting, species_map)
    assert src["front"].parent.name == "arceus"
    assert src["icon"].parent.name == "arceus"


def test_frame_sheet_is_cropped_to_a_single_frame_and_made_transparent():
    species = parse_species()
    species_map = build_species_map(species)
    pikachu = _by_name(species, "SPECIES_PIKACHU")
    src = species_sprites(pikachu, species_map)

    frame = _first_frame(src["front"], (64, 64))
    assert frame.size == (64, 64)
    assert frame.info["transparency"] == 0


def test_generate_species_sprites_writes_expected_files(tmp_path):
    species = parse_species()
    species_map = build_species_map(species)
    pikachu = _by_name(species, "SPECIES_PIKACHU")
    src = species_sprites(pikachu, species_map)

    dest = tmp_path / "SPECIES_PIKACHU"
    generate_species_sprites("SPECIES_PIKACHU", src, dest)

    assert (dest / "front.png").exists()
    assert (dest / "back.png").exists()
    assert (dest / "icon.png").exists()
    assert (dest / "front-shiny.png").exists()

    from PIL import Image

    front = Image.open(dest / "front.png")
    assert front.size == (64, 64)
    icon = Image.open(dest / "icon.png")
    assert icon.size == _ICON_FRAME
