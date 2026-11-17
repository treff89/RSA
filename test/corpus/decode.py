# Decode one image file to raw RGBA on stdout: 8-byte header (uint32 LE width, height) then width*height*4 bytes.
# Used by eval.mjs. Run with `python3 -I` — the input is untrusted.
import sys, struct
from PIL import Image
im = Image.open(sys.argv[1])
im.load()
if im.mode in ('I;16', 'I;16B', 'I', 'F'):
    # 16-bit greyscale: scale to 8-bit for parity with what a browser canvas would give
    import numpy as np
    a = np.asarray(im).astype('float64')
    lo, hi = np.percentile(a, 0.1), np.percentile(a, 99.9)
    a = np.clip((a - lo) / max(1e-9, hi - lo) * 255, 0, 255).astype('uint8')
    im = Image.fromarray(a, 'L')
im = im.convert('RGBA')
mx = int(sys.argv[2]) if len(sys.argv) > 2 else 4096
if max(im.size) > mx:
    k = mx / max(im.size)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
sys.stdout.buffer.write(struct.pack('<II', im.width, im.height))
sys.stdout.buffer.write(im.tobytes())
