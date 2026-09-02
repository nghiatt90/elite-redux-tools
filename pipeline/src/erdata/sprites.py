"""Generate the sprite set (front/back/icon, normal + shiny) for every playable species.

Elite Redux's on-disk sprite files are not simply <species-name>/front.png -- three
things have to be resolved first, all verified by hand against Pikachu and a handful
of reuse_visuals/reuse_icon species:

- The path comes from the species' resolved `visuals` (70+ species use reuse_visuals,
  and directory names don't reliably match species names), and icons separately from
  `visuals.icon_or` (icon vs reuse_icon -- yet another, independent reference chain).
- What visuals.front.path actually points at (e.g. "pikachu/anim_front") is a vertical
  frame sheet, width x (64*n) for front/back, 32 x (32*n) for icons -- not a plain
  single sprite. The Pokedex only needs the standing frame, so we crop the top tile.
- Icons don't use the species' own .pal at all -- Visuals.Icon.palette is an index
  into a small shared table (graphics/pokemon/icon_palettes/palN.pal), not a per-
  species file.

Normal-palette PNGs already carry the correct palette embedded (verified byte-identical
to the species' own normal.pal), so they're copied as-is. Only shiny variants are
generated, by swapping in shiny.pal. Icons are not given a shiny variant in v1 -- Elite
Redux's icon palette table isn't shiny-aware, matching how the vanilla-derived engine
displays icons in menus regardless of shiny status.
"""

from pathlib import Path

from PIL import Image

from erdata.generated import SpeciesEnum_pb2
from erdata.parse import parse_species
from erdata.paths import ER_SOURCE, output_dir
from erdata.resolve import build_species_map, playable_species, resolve_visuals

_S = SpeciesEnum_pb2.SpeciesEnum.Name
_GFX = ER_SOURCE / "graphics" / "pokemon"
_ICON_PALETTES = _GFX / "icon_palettes"

# GBA sprite canvases are fixed-width; a multi-frame sheet stacks frames vertically.
_FRONT_BACK_FRAME = (64, 64)
_ICON_FRAME = (32, 32)


def _load_jasc_pal(path: Path) -> list[int]:
    lines = path.read_text().splitlines()
    assert lines[0] == "JASC-PAL", f"not a JASC-PAL file: {path}"
    count = int(lines[2])
    flat: list[int] = []
    for line in lines[3 : 3 + count]:
        flat.extend(int(v) for v in line.split())
    return flat


def _first_frame(png_path: Path, frame_size: tuple[int, int]) -> Image.Image:
    im = Image.open(png_path)
    w, h = frame_size
    assert im.size[0] == w and im.size[1] % h == 0, f"{png_path}: unexpected size {im.size}"
    frame = im.crop((0, 0, w, h))
    # GBA hardware treats palette index 0 as transparent by convention; these source
    # PNGs don't carry a tRNS chunk saying so (index 0 is usually some solid filler
    # colour, not black), so every frame we cut needs it set explicitly or sprites
    # render with a solid-colour box around them.
    frame.info["transparency"] = 0
    return frame


def _resolve_icon(visuals, species_map, chain=None):
    """visuals.icon_or is a second, independent reuse chain from the top-level
    reuse_visuals -- e.g. a species can have its own front/back but reuse another's
    icon.
    """
    if chain is None:
        chain = []
    if visuals.WhichOneof("icon_or") == "reuse_icon":
        target = visuals.reuse_icon
        if target in chain:
            raise ValueError(f"self-referential icon reference: {chain + [target]}")
        return _resolve_icon(
            resolve_visuals(species_map[target], species_map), species_map, [*chain, target]
        )
    return visuals.icon


def species_sprites(species, species_map) -> dict:
    """Returns the resolved, on-disk-relative source info needed to render this
    species' sprites -- doesn't touch the filesystem itself.
    """
    visuals = resolve_visuals(species, species_map)
    icon = _resolve_icon(visuals, species_map)
    return {
        "front": _GFX / f"{visuals.front.path}.png",
        "back": _GFX / f"{visuals.back.path}.png",
        "icon": _GFX / f"{icon.path}.png" if icon.path else None,
        "icon_palette_index": icon.palette,
        "normal_pal": _GFX / f"{visuals.palette}.pal" if visuals.palette else None,
        "shiny_pal": _GFX / f"{visuals.shiny}.pal" if visuals.shiny else None,
    }


def generate_species_sprites(species_id: str, sources: dict, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)

    front = _first_frame(sources["front"], _FRONT_BACK_FRAME)
    front.save(dest_dir / "front.png")

    if sources["back"].exists():
        back = _first_frame(sources["back"], _FRONT_BACK_FRAME)
        back.save(dest_dir / "back.png")

    if sources["icon"] and sources["icon"].exists():
        icon = _first_frame(sources["icon"], _ICON_FRAME)
        icon_pal_path = _ICON_PALETTES / f"pal{sources['icon_palette_index']}.pal"
        if icon_pal_path.exists():
            icon = icon.convert("P")
            icon.putpalette(_load_jasc_pal(icon_pal_path))
            icon.info["transparency"] = 0
        icon.save(dest_dir / "icon.png")

    if sources["shiny_pal"] and sources["shiny_pal"].exists():
        shiny = front.copy()
        shiny.putpalette(_load_jasc_pal(sources["shiny_pal"]))
        shiny.info["transparency"] = 0
        shiny.save(dest_dir / "front-shiny.png")


def build_sprites() -> None:
    all_species = parse_species()
    species = playable_species(all_species)
    species_map = build_species_map(all_species)
    dest_root = output_dir() / "sprites"

    ok, skipped = 0, 0
    for s in species:
        sid = _S(s.id)
        sources = species_sprites(s, species_map)
        if not sources["front"].exists():
            skipped += 1
            continue
        generate_species_sprites(sid, sources, dest_root / sid)
        ok += 1
    print(f"sprites: {ok} generated, {skipped} skipped (missing source)")


if __name__ == "__main__":
    build_sprites()
