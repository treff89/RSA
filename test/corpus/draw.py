# Render overlays and contact sheets for eval.mjs results:  python3 -I test/corpus/draw.py <out-dir> [ids…]
import json, sys, os, math
from PIL import Image, ImageDraw
out = sys.argv[1]
want = set(sys.argv[2:])
rows = [json.loads(l) for l in open(os.path.join(out, 'results.jsonl')) if l.strip()]
os.makedirs(os.path.join(out, 'ov'), exist_ok=True)
COL = {'auto': (40, 230, 120), 'estimated': (255, 200, 0), 'manual': (90, 160, 255)}
thumbs = []
for r in rows:
    if want and r['id'] not in want: continue
    try:
        im = Image.open(r['file']).convert('RGB')
    except Exception:
        continue
    if r.get('size') and list(im.size) != r['size']:
        im = im.resize(tuple(r['size']), Image.LANCZOS)
    k = max(1, round(max(im.size) / 900))
    lw = max(2, k * 2)
    d = ImageDraw.Draw(im)
    L, S = r.get('landmarks') or {}, r.get('landmarkState') or {}
    for lid, v in L.items():
        c = COL.get(S.get(lid), (255, 255, 255))
        if 'r' in v:
            d.ellipse([v['cx'] - v['r'], v['cy'] - v['r'], v['cx'] + v['r'], v['cy'] + v['r']], outline=c, width=lw)
            p = (v['cx'], v['cy'])
        elif 'a' in v:
            d.line([(v['a']['x'], v['a']['y']), (v['b']['x'], v['b']['y'])], fill=c, width=lw)
            p = (v['a']['x'], v['a']['y'])
        else:
            p = (v['x'], v['y'])
            rr = 3 * lw
            d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], outline=c, width=lw)
        d.text((p[0] + 4 * lw, p[1] - 4 * lw), lid, fill=c)
    # annotated ground truth in magenta
    for lid, o in ((r.get('annot') or {}).get('lm') or {}).items():
        t = o['truth']; c = (255, 60, 220)
        if 'r' in t:
            d.ellipse([t['cx'] - t['r'], t['cy'] - t['r'], t['cx'] + t['r'], t['cy'] + t['r']], outline=c, width=max(1, lw // 2))
        elif 'a' in t:
            d.line([(t['a']['x'], t['a']['y']), (t['b']['x'], t['b']['y'])], fill=c, width=max(1, lw // 2))
        else:
            rr = 2 * lw; d.line([(t['x'] - rr, t['y']), (t['x'] + rr, t['y'])], fill=c, width=lw); d.line([(t['x'], t['y'] - rr), (t['x'], t['y'] + rr)], fill=c, width=lw)
    m = r.get('metrics') or {}
    head = f"{r['id']} {r.get('implant')}→{r.get('kind')} {r.get('confidence', 0):.2f}"
    txt = ' '.join(f"{k2}={v2}" for k2, v2 in m.items() if k2 in ('lsa', 'dsa', 'tilt', 'csa', 'corDev', 'hh', 'stemAlign', 'incl', 'ai'))
    for c in r.get('compare') or []:
        txt += f" | {c['name']} stated {c['stated']} ours {c.get('ours')}"
    d.rectangle([0, 0, im.width, 18 * k + 4], fill=(0, 0, 0))
    d.text((4, 2), head + '  ' + txt, fill=(255, 255, 255))
    f = os.path.join(out, 'ov', r['id'] + '.png')
    im.save(f)
    t = im.copy(); t.thumbnail((420, 420)); thumbs.append((r['id'], t))
# contact sheets, 12 per page
for pg in range(0, len(thumbs), 12):
    sheet = Image.new('RGB', (4 * 430, 3 * 450), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for i, (tid, t) in enumerate(thumbs[pg:pg + 12]):
        x, y = (i % 4) * 430 + 5, (i // 4) * 450 + 25
        sheet.paste(t, (x, y)); d.text((x, y - 18), tid, fill=(255, 255, 0))
    sheet.save(os.path.join(out, f'sheet-{pg // 12 + 1:02d}.png'))
print(len(thumbs), 'overlays')
