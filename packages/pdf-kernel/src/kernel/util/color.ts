import { rgb, type RGB } from "@cantoo/pdf-lib";

/** `#rgb`, `#rrggbb` or `#rrggbbaa` to a pdf-lib colour; anything else is the fallback. */
export function parseColor(value: string | undefined, fallback: string): RGB {
  const hex = (value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback).slice(1);
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}
