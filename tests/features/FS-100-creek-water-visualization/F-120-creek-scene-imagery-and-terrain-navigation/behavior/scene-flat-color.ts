import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { CDPSession, Page, TestInfo } from '../../../../support/browser/esri-response-cache.ts';
import { formatAltitude, readCameraAltitudeM } from './scene-camera.ts';
import type { SidebarMask } from './scene-check-outcome.ts';

/** Exact-RGB mode share. Photographic frames stay under this; a void does not. */
export const EXACT_FLAT_SHARE_LIMIT = 0.1;

/** Sample every Nth pixel. Voids are uniform, so the exact-flat share is unchanged. */
const PIXEL_STRIDE = 4;
/** Left-center viewport clip. On the old failure frames this still measured 34% navy and 92% white. */
const SCENE_CLIP = { x: 0, y: 120, width: 640, height: 480 };

interface FlatColorSample {
  share: number;
  count: number;
  unmaskedPixels: number;
  red: number;
  green: number;
  blue: number;
}

export async function sampleFlatFrame(
  page: Page,
  cdp: CDPSession,
  testInfo: TestInfo,
  step: string,
  samples: string[],
  failures: string[],
  evidenceDir: string | undefined,
  sidebar: SidebarMask,
): Promise<number | null> {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
    clip: { ...SCENE_CLIP, scale: 1 },
  });
  const pngBytes = Buffer.from(shot.data, 'base64');
  const png = PNG.sync.read(pngBytes);
  const mask = maskInsideClip(sidebar, png.width, png.height);
  const flat = exactFlatShare(png, mask);
  const altitudeM = await readCameraAltitudeM(page);
  const color = `rgb(${flat.red}, ${flat.green}, ${flat.blue})`;
  const sharePercent = `${(flat.share * 100).toFixed(1)}%`;
  const sample = `${step} height=${formatAltitude(altitudeM)} flat=${sharePercent} ${color} pixels=${flat.count}/${flat.unmaskedPixels}`;
  samples.push(sample);
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `${step}.png`), pngBytes);
    writeFileSync(path.join(evidenceDir, 'samples.txt'), `${samples.join('\n')}\n`);
  }
  if (flat.share > EXACT_FLAT_SHARE_LIMIT) {
    await testInfo.attach(`${step} ${sharePercent} ${color}`, {
      body: pngBytes,
      contentType: 'image/png',
    });
    failures.push(
      `${step} at camera height ${formatAltitude(altitudeM)} is ${sharePercent} exactly ${color}.`,
    );
  }
  return altitudeM;
}

function exactFlatShare(png: PNG, mask: SidebarMask): FlatColorSample {
  const counts = new Map<number, number>();
  let unmaskedPixels = 0;
  for (let y = 0; y < png.height; y += PIXEL_STRIDE) {
    for (let x = 0; x < png.width; x += PIXEL_STRIDE) {
      if (
        x >= mask.x &&
        x < mask.x + mask.width &&
        y >= mask.y &&
        y < mask.y + mask.height
      ) {
        continue;
      }
      const index = (png.width * y + x) << 2;
      const red = png.data[index] ?? 0;
      const green = png.data[index + 1] ?? 0;
      const blue = png.data[index + 2] ?? 0;
      const key = (red << 16) | (green << 8) | blue;
      unmaskedPixels += 1;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let count = 0;
  let key = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      count = candidateCount;
      key = candidate;
    }
  }

  return {
    share: unmaskedPixels === 0 ? 1 : count / unmaskedPixels,
    count,
    unmaskedPixels,
    red: (key >> 16) & 255,
    green: (key >> 8) & 255,
    blue: key & 255,
  };
}

function maskInsideClip(sidebar: SidebarMask, pngWidth: number, pngHeight: number): SidebarMask {
  const scaleX = pngWidth / SCENE_CLIP.width;
  const scaleY = pngHeight / SCENE_CLIP.height;
  const left = (sidebar.x - SCENE_CLIP.x) * scaleX;
  const top = (sidebar.y - SCENE_CLIP.y) * scaleY;
  const right = left + sidebar.width * scaleX;
  const bottom = top + sidebar.height * scaleY;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const x2 = Math.min(pngWidth, Math.ceil(right));
  const y2 = Math.min(pngHeight, Math.ceil(bottom));
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}
