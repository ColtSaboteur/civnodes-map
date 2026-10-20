# Updating map data

Run these commands from the website repository root, with the tiles repository
cloned at `site/map-data/`.

## Update map tiles

1. Install Python 3 if it is not already installed.
2. Install the dependencies once: `python3 -m pip install -r scripts/requirements.txt`.
3. Put the CivModern map data at `input/map.sqlite`.
4. Run `python3 scripts/generate_map.py`.

The script asks what to render:

- **Render whole map** replaces every tile from the database.
- **Select map areas** shows a preview. Drag over the 512 x 512 block map regions you want to update. Only the selected region pixels change.

Selected areas use the data in the database you provide, even when that data is older. Partial rendering only works when the database has the same world bounds as the existing tiles.

For a non-interactive full render, run:

```sh
python3 scripts/generate_map.py --mode whole
```

The generator writes `site/map-data/tiles/` and `site/map-data/api/config.json` together.
It only needs `input/map.sqlite`. PNG compression preserves every pixel; palette
encoding is used only when it reproduces the RGB pixels exactly.

To losslessly recompress an existing set without a database:

```sh
python3 scripts/generate_map.py --optimize-existing
```

`--output PATH` overrides the default `site/map-data/` output directory.

## Update claims

Put the new image of the claims map at `site/images/claims.png` and commit.

## Update settlements

Edit `site/api/settlements.json` and commit it with the website. Settlements are loaded from the server and shown by default; players can hide them with the map toggle.

```json
{
  "settlements": [
    {
      "name": "Settlement name",
      "coordinates": { "x": 0, "z": 0 },
      "nation": "Nation name",
      "contact": "Player name",
      "visitors": "ask first",
      "discord": "https://discord.gg/example"
    }
  ]
}
```

`visitors` should be `welcome`, `not welcome`, or `ask first`. Discord links must use HTTPS.

## Check locally

Run:

```sh
python3 scripts/generate_map.py --self-test
python3 -m http.server --directory site 8080
```

Open `http://localhost:8080`.
