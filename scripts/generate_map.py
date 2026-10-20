#!/usr/bin/env python3
"""Build static tiles and API JSON from a CivModern map.sqlite export."""

from __future__ import annotations

import argparse
import functools
import io
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

try:
    import numpy as np
    import zstandard as zstd
    from PIL import Image
except ImportError as error:
    sys.exit(f"Missing generator dependency: {error.name}. Run: python3 -m pip install -r scripts/requirements.txt")


TILE_SIZE = 256
REGION_SIZE = 512
BLOCK_COLORS = {
    "water": (61, 118, 215), "lava": (207, 75, 28), "grass": (102, 151, 70),
    "leaves": (77, 121, 53), "dirt": (133, 99, 67), "sand": (210, 192, 129),
    "snow": (230, 236, 237), "ice": (119, 166, 222), "deepslate": (68, 68, 75),
    "stone": (124, 124, 124), "cobblestone": (113, 113, 113), "netherrack": (110, 52, 49),
    "end_stone": (208, 211, 143), "wood": (113, 79, 47), "log": (105, 77, 47),
    "planks": (157, 123, 72), "ore": (118, 124, 126), "air": (0, 0, 0),
}


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def block_color(name: str) -> tuple[int, int, int]:
    lowered = name.lower()
    for key, color in BLOCK_COLORS.items():
        if key in lowered:
            return color
    return (128, 128, 128)


def decompress(blob: bytes) -> bytes:
    return zstd.ZstdDecompressor().decompress(blob, max_output_size=REGION_SIZE * REGION_SIZE * 4)


def load_regions(connection: sqlite3.Connection) -> list[tuple[int, int, bytes]]:
    return connection.execute("""
        SELECT x, z, data
        FROM regions AS map
        WHERE type = 'map'
        ORDER BY x, z
    """).fetchall()


def region_image(blob: bytes, block_names: dict[int, str], width: int, height: int) -> Image.Image:
    raw = np.frombuffer(decompress(blob), dtype=">i4").astype(np.uint32)
    if raw.size != REGION_SIZE * REGION_SIZE:
        raise ValueError("a map region did not contain 512 x 512 cells")
    # CivModern stores each cell at z + x * 512; Pillow expects rows of Z then columns of X.
    packed = raw.reshape(REGION_SIZE, REGION_SIZE).T
    rows = ((np.arange(height) + .5) * REGION_SIZE / height).astype(np.intp)
    columns = ((np.arange(width) + .5) * REGION_SIZE / width).astype(np.intp)
    packed = packed[rows[:, None], columns]
    ids = (packed >> 16) & 0xFFFF
    colors = np.empty((height, width, 3), dtype=np.uint8)
    for raw_id in np.unique(ids):
        name = "minecraft:air" if raw_id == 0 else block_names.get(int(raw_id) - 1, "minecraft:air")
        colors[ids == raw_id] = block_color(name)

    water = ((packed >> 12) & 0xF) > 0
    if water.any():
        colors[water] = (colors[water].astype(np.uint16) * 61 + np.array((63, 118, 228), dtype=np.uint16) * 194) // 255

    slopes = np.array([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4], dtype=np.uint8)[(packed >> 8) & 0xF]
    shade = np.where(slopes >= 3, np.where(water, 34, 68), np.where(slopes == 2, np.where(water, 17, 34), 0))
    colors = (colors.astype(np.uint16) * (255 - shade[..., None]) // 255).astype(np.uint8)
    return Image.fromarray(colors, "RGB")


def map_bounds(regions: list[tuple[int, int, bytes]]) -> tuple[int, int, int]:
    min_x = min(region[0] for region in regions) * REGION_SIZE
    min_z = min(region[1] for region in regions) * REGION_SIZE
    max_x = (max(region[0] for region in regions) + 1) * REGION_SIZE
    max_z = (max(region[1] for region in regions) + 1) * REGION_SIZE
    return min_x, min_z, max(max_x - min_x, max_z - min_z)


def write_tile(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = image.convert("RGB")
    colors = image.getcolors(256)
    if colors is not None:
        palette = image.convert("P", palette=Image.Palette.ADAPTIVE, colors=len(colors))
        if palette.convert("RGB").tobytes() == image.tobytes():
            image = palette
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(output.getvalue())
    temporary.replace(path)


def scaled_region_image(blob: bytes, block_names: dict[int, str], width: int, height: int) -> Image.Image:
    image = region_image(blob, block_names, min(width, REGION_SIZE), min(height, REGION_SIZE))
    return image if image.size == (width, height) else image.resize((width, height), Image.Resampling.NEAREST)


def write_parent_tile(tiles: Path, zoom: int, tile_x: int, tile_y: int) -> None:
    image = Image.new("RGB", (TILE_SIZE, TILE_SIZE), (20, 22, 26))
    for offset_x, offset_y in ((0, 0), (1, 0), (0, 1), (1, 1)):
        child = tiles / str(zoom + 1) / str(tile_x * 2 + offset_x) / f"{tile_y * 2 + offset_y}.png"
        with Image.open(child) as source:
            image.paste(source.convert("RGB").resize((TILE_SIZE // 2, TILE_SIZE // 2), Image.Resampling.BOX), (offset_x * TILE_SIZE // 2, offset_y * TILE_SIZE // 2))
    write_tile(image, tiles / str(zoom) / str(tile_x) / f"{tile_y}.png")


def render_tiles(regions: list[tuple[int, int, bytes]], block_names: dict[int, str], tiles: Path, max_zoom: int) -> tuple[int, int, int, int]:
    min_x, min_z, world_size = map_bounds(regions)
    pixels = TILE_SIZE * (2 ** max_zoom)
    tiles_per_edge = 2 ** max_zoom
    placements = []
    for region_x, region_z, blob in regions:
        left = round((region_x * REGION_SIZE - min_x) / world_size * pixels)
        top = round((region_z * REGION_SIZE - min_z) / world_size * pixels)
        right = round(((region_x + 1) * REGION_SIZE - min_x) / world_size * pixels)
        bottom = round(((region_z + 1) * REGION_SIZE - min_z) / world_size * pixels)
        placements.append((left, top, right, bottom, blob))

    if tiles.exists():
        shutil.rmtree(tiles)
    rendered = {}
    for tile_y in range(tiles_per_edge):
        row_top, row_bottom = tile_y * TILE_SIZE, (tile_y + 1) * TILE_SIZE
        row = [Image.new("RGB", (TILE_SIZE, TILE_SIZE), (20, 22, 26)) for _ in range(tiles_per_edge)]
        for index, (left, top, right, bottom, blob) in enumerate(placements):
            if bottom <= row_top or top >= row_bottom:
                continue
            source = rendered.get(index)
            if source is None:
                source = scaled_region_image(blob, block_names, right - left, bottom - top)
                rendered[index] = source
            for tile_x in range(max(0, left // TILE_SIZE), min(tiles_per_edge, (right - 1) // TILE_SIZE + 1)):
                tile_left = tile_x * TILE_SIZE
                overlap_left, overlap_top = max(left, tile_left), max(top, row_top)
                overlap_right, overlap_bottom = min(right, tile_left + TILE_SIZE), min(bottom, row_bottom)
                row[tile_x].paste(source.crop((overlap_left - left, overlap_top - top, overlap_right - left, overlap_bottom - top)), (overlap_left - tile_left, overlap_top - row_top))
        for tile_x, image in enumerate(row):
            write_tile(image, tiles / str(max_zoom) / str(tile_x) / f"{tile_y}.png")
        for index, (_, _, _, bottom, _) in enumerate(placements):
            if bottom <= row_bottom:
                rendered.pop(index, None)
        if tile_y % 4 == 3 or tile_y + 1 == tiles_per_edge:
            print(f"\\rRendering tile rows: {tile_y + 1}/{tiles_per_edge}", end="", flush=True)
    print()

    for zoom in range(max_zoom - 1, -1, -1):
        tiles_per_edge = 2 ** zoom
        for tile_y in range(tiles_per_edge):
            for tile_x in range(tiles_per_edge):
                write_parent_tile(tiles, zoom, tile_x, tile_y)
        print(f"Rendered zoom {zoom}/{max_zoom}")
    return min_x, min_z, world_size, sum(4 ** zoom for zoom in range(max_zoom + 1))


def output_bounds(output_dir: Path) -> tuple[int, int, int]:
    try:
        settings = json.loads((output_dir / "api/config.json").read_text(encoding="utf-8"))["tileSettings"]
        bounds = settings["worldBounds"]
        return bounds["minX"], bounds["minZ"], bounds["size"]
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("partial rendering needs an existing whole-map render. Run with --mode whole first.") from error


def render_selected_tiles(regions: list[tuple[int, int, bytes]], block_names: dict[int, str], tiles: Path, max_zoom: int, selected: set[tuple[int, int]]) -> tuple[int, int, int, int]:
    min_x, min_z, world_size = map_bounds(regions)
    if output_bounds(tiles.parent) != (min_x, min_z, world_size):
        raise ValueError("partial rendering needs map data with the same bounds as the existing tiles. Run with --mode whole instead.")
    if not (tiles / str(max_zoom)).is_dir():
        raise ValueError("partial rendering needs existing maximum-zoom tiles. Run with --mode whole first.")

    pixels = TILE_SIZE * (2 ** max_zoom)
    tiles_per_edge = 2 ** max_zoom
    placements = []
    region_indexes = {}
    tile_indexes: dict[tuple[int, int], list[int]] = {}
    for region_x, region_z, blob in regions:
        left = round((region_x * REGION_SIZE - min_x) / world_size * pixels)
        top = round((region_z * REGION_SIZE - min_z) / world_size * pixels)
        right = round(((region_x + 1) * REGION_SIZE - min_x) / world_size * pixels)
        bottom = round(((region_z + 1) * REGION_SIZE - min_z) / world_size * pixels)
        index = len(placements)
        placements.append((left, top, right, bottom, blob))
        region_indexes[(region_x, region_z)] = index
        for tile_y in range(max(0, top // TILE_SIZE), min(tiles_per_edge, (bottom - 1) // TILE_SIZE + 1)):
            for tile_x in range(max(0, left // TILE_SIZE), min(tiles_per_edge, (right - 1) // TILE_SIZE + 1)):
                tile_indexes.setdefault((tile_x, tile_y), []).append(index)

    missing = selected - region_indexes.keys()
    if missing:
        raise ValueError(f"selected map regions are not present in this database: {sorted(missing)}")
    affected = set()
    for region in selected:
        left, top, right, bottom, _ = placements[region_indexes[region]]
        for tile_y in range(max(0, top // TILE_SIZE), min(tiles_per_edge, (bottom - 1) // TILE_SIZE + 1)):
            for tile_x in range(max(0, left // TILE_SIZE), min(tiles_per_edge, (right - 1) // TILE_SIZE + 1)):
                affected.add((tile_x, tile_y))

    @functools.lru_cache(maxsize=32)
    def source(index: int) -> Image.Image:
        left, top, right, bottom, blob = placements[index]
        return scaled_region_image(blob, block_names, right - left, bottom - top)

    selected_indexes = {region_indexes[region] for region in selected}
    for tile_x, tile_y in sorted(affected, key=lambda point: (point[1], point[0])):
        path = tiles / str(max_zoom) / str(tile_x) / f"{tile_y}.png"
        with Image.open(path) as existing:
            image = existing.convert("RGB")
        tile_left, tile_top = tile_x * TILE_SIZE, tile_y * TILE_SIZE
        for index in tile_indexes[(tile_x, tile_y)]:
            if index not in selected_indexes:
                continue
            left, top, right, bottom, _ = placements[index]
            overlap_left, overlap_top = max(left, tile_left), max(top, tile_top)
            overlap_right, overlap_bottom = min(right, tile_left + TILE_SIZE), min(bottom, tile_top + TILE_SIZE)
            image.paste(source(index).crop((overlap_left - left, overlap_top - top, overlap_right - left, overlap_bottom - top)), (overlap_left - tile_left, overlap_top - tile_top))
        write_tile(image, path)

    children = affected
    written = len(affected)
    for zoom in range(max_zoom - 1, -1, -1):
        parents = {(tile_x // 2, tile_y // 2) for tile_x, tile_y in children}
        for tile_x, tile_y in parents:
            write_parent_tile(tiles, zoom, tile_x, tile_y)
        written += len(parents)
        children = parents
    return min_x, min_z, world_size, written


def preview_image(regions: list[tuple[int, int, bytes]], block_names: dict[int, str], size: int = 720) -> Image.Image:
    min_x, min_z, world_size = map_bounds(regions)
    image = Image.new("RGB", (size, size), (20, 22, 26))
    for region_x, region_z, blob in regions:
        left = round((region_x * REGION_SIZE - min_x) / world_size * size)
        top = round((region_z * REGION_SIZE - min_z) / world_size * size)
        right = round(((region_x + 1) * REGION_SIZE - min_x) / world_size * size)
        bottom = round(((region_z + 1) * REGION_SIZE - min_z) / world_size * size)
        image.paste(scaled_region_image(blob, block_names, right - left, bottom - top), (left, top))
    return image


def choose_mode() -> str | None:
    try:
        import tkinter as tk
    except ImportError as error:
        raise RuntimeError("Tkinter is required when --mode is omitted. Use --mode whole if you cannot install it.") from error
    choice = {"mode": None}
    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise RuntimeError("Tkinter could not open a window. Run with --mode whole in a non-graphical shell.") from error
    root.title("CivNodes map update")
    root.resizable(False, False)
    tk.Label(root, text="Choose what to render", font=("TkDefaultFont", 13, "bold")).pack(padx=20, pady=(20, 8))
    tk.Label(root, text="Whole map replaces every tile. Select areas keeps the rest.").pack(padx=20, pady=(0, 14))
    buttons = tk.Frame(root)
    buttons.pack(padx=20, pady=(0, 20))
    whole_button = tk.Button(buttons, text="Render whole map", command=lambda: (choice.update(mode="whole"), root.destroy()))
    whole_button.pack(side="left", padx=4)
    tk.Button(buttons, text="Select map areas", command=lambda: (choice.update(mode="select"), root.destroy())).pack(side="left", padx=4)
    root.bind("<Escape>", lambda _: root.destroy())
    whole_button.focus_set()
    root.mainloop()
    return choice["mode"]


def choose_regions(regions: list[tuple[int, int, bytes]], block_names: dict[int, str]) -> set[tuple[int, int]] | None:
    try:
        import tkinter as tk
        from PIL import ImageTk
    except ImportError as error:
        raise RuntimeError("Tkinter is required for --mode select. Use --mode whole if you cannot install it.") from error

    print("Rendering selection preview...", flush=True)
    preview = preview_image(regions, block_names)
    min_x, min_z, world_size = map_bounds(regions)
    available = {(region_x, region_z) for region_x, region_z, _ in regions}
    selected: set[tuple[int, int]] = set()
    result = {"selected": None}
    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise RuntimeError("Tkinter could not open a window. Run with --mode whole in a non-graphical shell.") from error
    root.title("Select CivModern map regions")
    photo = ImageTk.PhotoImage(preview)
    tk.Label(root, text="Drag to add 512 x 512 block map regions. Existing tiles outside the selection stay unchanged.", wraplength=720).pack(padx=12, pady=(12, 6))
    canvas = tk.Canvas(root, width=preview.width, height=preview.height, highlightthickness=1)
    canvas.pack(padx=12)
    canvas.create_image(0, 0, image=photo, anchor="nw")
    status = tk.StringVar()
    button_row = tk.Frame(root)
    button_row.pack(padx=12, pady=12, fill="x")
    render_button = tk.Button(button_row, text="Render selected", state="disabled")
    render_button.pack(side="right")
    clear_button = tk.Button(button_row, text="Clear selection")
    clear_button.pack(side="right", padx=6)
    tk.Button(button_row, text="Cancel", command=root.destroy).pack(side="right", padx=6)
    tk.Label(button_row, textvariable=status).pack(side="left")
    drag_start = {"point": None, "item": None}

    def region_at(point: float) -> int:
        return int((point / preview.width * world_size) // REGION_SIZE)

    def redraw() -> None:
        canvas.delete("selection")
        for region_x, region_z in selected:
            left = (region_x * REGION_SIZE - min_x) / world_size * preview.width
            top = (region_z * REGION_SIZE - min_z) / world_size * preview.height
            right = left + REGION_SIZE / world_size * preview.width
            bottom = top + REGION_SIZE / world_size * preview.height
            canvas.create_rectangle(left, top, right, bottom, outline="#6ee7a7", width=1, tags="selection")
        status.set(f"{len(selected)} map regions selected")
        render_button.configure(state="normal" if selected else "disabled", text=f"Render {len(selected)} selected")

    def start_drag(event) -> None:
        drag_start["point"] = (event.x, event.y)
        drag_start["item"] = canvas.create_rectangle(event.x, event.y, event.x, event.y, outline="#ffffff", dash=(3, 3), tags="drag")

    def move_drag(event) -> None:
        if drag_start["item"]:
            start_x, start_y = drag_start["point"]
            canvas.coords(drag_start["item"], start_x, start_y, event.x, event.y)

    def finish_drag(event) -> None:
        if not drag_start["item"]:
            return
        start_x, start_y = drag_start["point"]
        canvas.delete(drag_start["item"])
        drag_start["item"] = None
        left, right = sorted((region_at(max(0, start_x)), region_at(min(preview.width - 1, event.x))))
        top, bottom = sorted((region_at(max(0, start_y)), region_at(min(preview.height - 1, event.y))))
        for region_x in range(left + min_x // REGION_SIZE, right + min_x // REGION_SIZE + 1):
            for region_z in range(top + min_z // REGION_SIZE, bottom + min_z // REGION_SIZE + 1):
                if (region_x, region_z) in available:
                    selected.add((region_x, region_z))
        redraw()

    def clear() -> None:
        selected.clear()
        redraw()

    def submit() -> None:
        result["selected"] = set(selected)
        root.destroy()

    canvas.bind("<ButtonPress-1>", start_drag)
    canvas.bind("<B1-Motion>", move_drag)
    canvas.bind("<ButtonRelease-1>", finish_drag)
    render_button.configure(command=submit)
    clear_button.configure(command=clear)
    root.bind("<Escape>", lambda _: root.destroy())
    redraw()
    root.mainloop()
    return result["selected"]


def export_config(output_dir: Path, bounds: tuple[int, int, int], max_zoom: int) -> None:
    write_json(output_dir / "api/config.json", {
        "tileSettings": {
            "minZoom": 0,
            "maxZoom": max_zoom,
            "tileSize": TILE_SIZE,
            "worldBounds": {"minX": bounds[0], "minZ": bounds[1], "size": bounds[2]},
        },
    })


def generate(output_dir: Path, database: Path, max_zoom: int, selected: set[tuple[int, int]] | None = None) -> int:
    if not database.is_file():
        raise ValueError(f"CivModern database not found: {database}")
    if max_zoom < 0 or max_zoom > 8:
        raise ValueError("max zoom must be between 0 and 8")
    with sqlite3.connect(database) as connection:
        regions = load_regions(connection)
        if not regions:
            raise ValueError("no CivModern map regions were found")
        block_names = dict(connection.execute("SELECT id, name FROM blocks"))
        if selected is None:
            min_x, min_z, size, written = render_tiles(regions, block_names, output_dir / "tiles", max_zoom)
        else:
            min_x, min_z, size, written = render_selected_tiles(regions, block_names, output_dir / "tiles", max_zoom, selected)
        export_config(output_dir, (min_x, min_z, size), max_zoom)
    return written


def self_test() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        pixels = np.random.default_rng(0).integers(0, 256, (TILE_SIZE, TILE_SIZE, 3), dtype=np.uint8)
        for name, image in (("rgb", Image.fromarray(pixels)), ("palette", Image.fromarray(pixels % 4 * 85))):
            path = root / f"{name}.png"
            write_tile(image, path)
            with Image.open(path) as saved:
                assert saved.convert("RGB").tobytes() == image.tobytes()
                assert saved.mode == ("RGB" if name == "rgb" else "P")
        checker = np.indices((TILE_SIZE, TILE_SIZE)).sum(axis=0) % 2 * 254
        for x in range(2):
            for y in range(2):
                write_tile(Image.fromarray(checker.astype(np.uint8)).convert("RGB"), root / "tiles/1" / str(x) / f"{y}.png")
        write_parent_tile(root / "tiles", 0, 0, 0)
        with Image.open(root / "tiles/0/0/0.png") as parent:
            assert parent.convert("RGB").getpixel((0, 0)) == (127, 127, 127)
        output_dir, database = root / "site", root / "map.sqlite"
        with sqlite3.connect(database) as connection:
            connection.executescript("""
                CREATE TABLE blocks (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE regions (x INTEGER, z INTEGER, type TEXT, data BLOB);
            """)
            raw = np.full(REGION_SIZE * REGION_SIZE, 1 << 16, dtype=">u4")
            raw[128 * REGION_SIZE + 384] |= 1 << 12
            connection.execute("INSERT INTO blocks VALUES (0, 'minecraft:grass_block')")
            connection.execute("INSERT INTO blocks VALUES (1, 'minecraft:lava')")
            connection.execute("INSERT INTO regions VALUES (0, 0, 'map', ?)", (zstd.ZstdCompressor().compress(raw.tobytes()),))
            connection.execute("INSERT INTO regions VALUES (0, 1, 'map', ?)", (zstd.ZstdCompressor().compress(np.full(REGION_SIZE * REGION_SIZE, 2 << 16, dtype=">u4").tobytes()),))
        assert generate(output_dir, database, 1) == 5
        assert Image.open(output_dir / "tiles/1/1/1.png").size == (TILE_SIZE, TILE_SIZE)
        assert Image.open(output_dir / "tiles/1/0/0.png").convert("RGB").getpixel((128, 128)) == (102, 151, 70)
        assert Image.open(output_dir / "tiles/1/0/1.png").convert("RGB").getpixel((128, 128)) == (207, 75, 28)
        assert region_image(zstd.ZstdCompressor().compress(raw.tobytes()), {0: "minecraft:grass_block"}, 2, 2).getpixel((0, 1))[2] > 150
        with sqlite3.connect(database) as connection:
            connection.execute("INSERT INTO blocks VALUES (2, 'minecraft:stone')")
            connection.execute("UPDATE regions SET data = ? WHERE x = 0 AND z = 0", (zstd.ZstdCompressor().compress(np.full(REGION_SIZE * REGION_SIZE, 3 << 16, dtype=">u4").tobytes()),))
        assert generate(output_dir, database, 1, {(0, 0)}) == 2
        assert Image.open(output_dir / "tiles/1/0/0.png").convert("RGB").getpixel((128, 128)) == (124, 124, 124)
        assert Image.open(output_dir / "tiles/1/0/1.png").convert("RGB").getpixel((128, 128)) == (207, 75, 28)
        with (output_dir / "api/config.json").open(encoding="utf-8") as source:
            assert json.load(source)["tileSettings"]["maxZoom"] == 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("site/map-data"))
    parser.add_argument("--database", type=Path, default=Path("input/map.sqlite"))
    parser.add_argument("--max-zoom", type=int, default=8)
    parser.add_argument("--mode", choices=("whole", "select"), help="Render every tile or choose map regions. Omit to choose in a window.")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--optimize-existing", action="store_true", help="Losslessly recompress existing tiles without a database.")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("self-test passed")
        return
    if args.optimize_existing:
        paths = sorted((args.output / "tiles").glob("*/*/*.png"))
        if not paths:
            raise ValueError(f"No existing tiles found in {args.output / 'tiles'}")
        for index, path in enumerate(paths, 1):
            with Image.open(path) as image:
                write_tile(image, path)
            if index % 1000 == 0 or index == len(paths):
                print(f"Optimized {index}/{len(paths)} tiles", flush=True)
        return
    mode = args.mode or choose_mode()
    if mode is None:
        print("No render selected.")
        return
    selected = None
    if mode == "select":
        if not args.database.is_file():
            raise ValueError(f"CivModern database not found: {args.database}")
        with sqlite3.connect(args.database) as connection:
            selected = choose_regions(load_regions(connection), dict(connection.execute("SELECT id, name FROM blocks")))
        if not selected:
            print("No map regions selected.")
            return
    print(f"Wrote {generate(args.output, args.database, args.max_zoom, selected)} tiles")


if __name__ == "__main__":
    main()
