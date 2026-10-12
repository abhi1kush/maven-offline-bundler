export type Raster = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};

function meanLuminance(pixels: Uint8ClampedArray): number {
  let total = 0;
  let count = 0;
  const step = pixels.length > 400_000 ? 32 : 4;
  for (let index = 0; index < pixels.length; index += step) {
    if (pixels[index + 3] < 16) continue;
    total += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    count += 1;
  }
  return count === 0 ? 255 : total / count;
}

function scale2x(pixels: Uint8ClampedArray, width: number, height: number): Raster {
  const outWidth = width * 2;
  const outHeight = height * 2;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const dst = ((y * 2 + dy) * outWidth + (x * 2 + dx)) * 4;
          out[dst] = pixels[src];
          out[dst + 1] = pixels[src + 1];
          out[dst + 2] = pixels[src + 2];
          out[dst + 3] = pixels[src + 3];
        }
      }
    }
  }
  return { pixels: out, width: outWidth, height: outHeight };
}

export function prepareRgba(pixels: Uint8ClampedArray, width: number, height: number): Raster {
  const copy = new Uint8ClampedArray(pixels);
  if (meanLuminance(copy) < 120) {
    for (let index = 0; index < copy.length; index += 4) {
      copy[index] = 255 - copy[index];
      copy[index + 1] = 255 - copy[index + 1];
      copy[index + 2] = 255 - copy[index + 2];
    }
  }
  if (width > 0 && width < 1200) return scale2x(copy, width, height);
  return { pixels: copy, width, height };
}
