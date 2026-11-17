// Viewer screenshots carry the patient's name, date of birth and IDs as coloured text over the picture. A radiograph
// is grey (R = G = B), so anything coloured is overlay: it is blanked — and a few pixels around it, for the
// anti-aliased fringe — before the image is shown, analysed or exported. White or grey text cannot be told apart
// from the film this way and is left alone.

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba  pixel data, 4 bytes per pixel
 * @returns {{ gray: Float32Array, blanked: number }} luminance with overlay pixels set to 0, and how many were blanked
 */
export function grayWithoutOverlay(rgba, width, height, grow = 3) {
  const n = width * height;
  const col = new Uint8Array(n);
  let any = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx - mn > Math.max(18, 0.2 * mx)) { col[i] = 1; any++; }
  }
  let mask = col;
  if (any && grow > 0) {
    // separable box dilation
    const tmp = new Uint8Array(n);
    mask = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!col[row + x]) continue;
        for (let k = Math.max(0, x - grow); k <= Math.min(width - 1, x + grow); k++) tmp[row + k] = 1;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!tmp[y * width + x]) continue;
        for (let k = Math.max(0, y - grow); k <= Math.min(height - 1, y + grow); k++) mask[k * width + x] = 1;
      }
    }
  }
  const gray = new Float32Array(n);
  let blanked = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (mask[i]) { blanked++; continue; }
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return { gray, blanked };
}
