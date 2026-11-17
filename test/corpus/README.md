# Corpus evaluation (development tool)

Runs the app's radiograph pipeline on a folder of real radiographs and compares the results with any values the
sources state for those very images. The images themselves are **not** in this repository (copyright and privacy);
point the tool at a local corpus laid out as `<corpus>/<collection>/manifest.jsonl` + image files (see the field
list in the manifest spec used for collection).

```bash
node test/corpus/eval.mjs <corpus-dir> <out-dir>
```

```bash
python3 -I test/corpus/draw.py <out-dir>
```

Needs Python 3 with Pillow (and numpy for 16-bit images).
