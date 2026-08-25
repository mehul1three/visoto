/**
 * Client-side image conditioning.
 *
 * Level boxes are normalised against the image the model was shown, and the
 * game world is a fixed 16:9. If those aspect ratios differ, every box lands in
 * the wrong place — or the photo has to be stretched to compensate, which looks
 * awful. Cropping to 16:9 up front makes the two coordinate spaces identical by
 * construction, so alignment is exact for free.
 *
 * Downscaling also keeps the upload small, which is most of the round-trip time.
 */

import { WORLD_H, WORLD_W } from "./level";

export const TARGET_W = WORLD_W;
export const TARGET_H = WORLD_H;

export interface Prepared {
  /** 16:9 JPEG data URL, ready to both send and render. */
  dataUrl: string;
  width: number;
  height: number;
}

export async function prepareImage(file: File | Blob): Promise<Prepared> {
  const bitmap = await createImageBitmap(file);
  const targetRatio = TARGET_W / TARGET_H;
  const ratio = bitmap.width / bitmap.height;

  // Centre-crop to 16:9.
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (ratio > targetRatio) {
    sw = Math.round(bitmap.height * targetRatio);
    sx = Math.round((bitmap.width - sw) / 2);
  } else if (ratio < targetRatio) {
    sh = Math.round(bitmap.width / targetRatio);
    sy = Math.round((bitmap.height - sh) / 2);
  }

  const canvas = document.createElement("canvas");
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
  bitmap.close();

  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.86),
    width: TARGET_W,
    height: TARGET_H,
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}
