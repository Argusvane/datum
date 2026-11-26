/**
 * The ICC profiles the kernel carries: what a layout's or theme's
 * `outputIntent.profile` names with `storage: "builtin"` — so every host, the browser and a
 * server running the program alike, declares the same output condition from the same bytes
 * with nothing to fetch. Three conditions cover what a form platform's archives are asked for:
 *
 * - `srgb`: sRGB IEC61966-2.1, the HP profile pdf-lib bundles (3,144 bytes) — the default
 *   whenever nothing names a profile;
 * - `gray`: a gamma-2.2 grey profile the kernel builds itself (a few hundred bytes), for
 *   monochrome archives;
 * - `cmyk`: a compact CGATS TR 001 (SWOP) compatible profile, CC0, from pdf.js (8,464 bytes).
 *
 * Press-grade profiles (ECI / FOGRA, 1–2 MB each) stay outside the program: a layout carries
 * one inline, or a host stores it and the engine's resolver hands it to the request.
 */
import { getDefaultSRGBProfile } from "@cantoo/pdf-lib";
import { PDF_BUILTIN_PROFILES, type PdfBuiltinProfileId } from "@argusvane/datum-engine/core";
import { base64ToBytes } from "@argusvane/datum-engine/render";
import { CGATS_TR001_COMPAT_MICRO_BASE64 } from "./profiles/cgats-tr001-compat-micro.js";

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

/** An `s15Fixed16Number`: the ICC fixed-point format for XYZ values. */
function s15Fixed16(value: number): number[] {
  return u32(Math.round(value * 65536));
}

/** A tag's data padded to the 4-byte boundary the format asks for. */
function padded(bytes: number[]): number[] {
  const out = [...bytes];
  while (out.length % 4 !== 0) {
    out.push(0);
  }
  return out;
}

/** A v2 `textDescriptionType`: the ASCII form, and empty Unicode and Macintosh forms. */
function descriptionTag(text: string): number[] {
  const chars = [...ascii(text), 0];
  return padded([...ascii("desc"), 0, 0, 0, 0, ...u32(chars.length), ...chars, ...u32(0), ...u32(0), ...u16(0), 0, ...new Array<number>(67).fill(0)]);
}

function textTag(text: string): number[] {
  return padded([...ascii("text"), 0, 0, 0, 0, ...ascii(text), 0]);
}

function xyzTag(x: number, y: number, z: number): number[] {
  return [...ascii("XYZ "), 0, 0, 0, 0, ...s15Fixed16(x), ...s15Fixed16(y), ...s15Fixed16(z)];
}

/** A `curveType` holding one gamma value (`u8Fixed8Number`). */
function gammaTag(gamma: number): number[] {
  return padded([...ascii("curv"), 0, 0, 0, 0, ...u32(1), ...u16(Math.round(gamma * 256))]);
}

/**
 * A monochrome display-class profile: grey with a 2.2 gamma tone curve and a D65 white point,
 * as the ICC v2.1 format lays one out — header, tag table, then `desc`, `cprt`, `wtpt` and
 * `kTRC`. Built from constants, so it is the same bytes everywhere and needs no file.
 */
export function grayGamma22Profile(): Uint8Array {
  const tags: Array<[string, number[]]> = [
    ["desc", descriptionTag("Gray gamma 2.2")],
    ["cprt", textTag("Datum PDF kernel. No rights reserved (CC0).")],
    ["wtpt", xyzTag(0.9505, 1.0, 1.0891)],
    ["kTRC", gammaTag(2.2)]
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const table: number[] = [...u32(tags.length)];
  const data: number[] = [];
  for (const [signature, bytes] of tags) {
    table.push(...ascii(signature), ...u32(offset), ...u32(bytes.length));
    data.push(...bytes);
    offset += bytes.length;
  }
  const header = [
    ...u32(128 + tableSize + data.length),
    ...u32(0), // preferred CMM: none
    ...u32(0x02100000), // version 2.1
    ...ascii("mntr"),
    ...ascii("GRAY"),
    ...ascii("XYZ "),
    ...u16(2026), ...u16(1), ...u16(1), ...u16(0), ...u16(0), ...u16(0), // a fixed creation date
    ...ascii("acsp"),
    ...u32(0), // platform: none
    ...u32(0), // flags
    ...u32(0), // manufacturer
    ...u32(0), // model
    ...u32(0), ...u32(0), // attributes
    ...u32(0), // rendering intent: perceptual
    ...s15Fixed16(0.9642), ...s15Fixed16(1.0), ...s15Fixed16(0.8249), // the PCS illuminant, D50
    ...u32(0) // creator
  ];
  while (header.length < 128) {
    header.push(0);
  }
  return new Uint8Array([...header, ...table, ...data]);
}

let cmyk: Uint8Array | undefined;

/** The bytes of a built-in profile; `undefined` for an id the kernel does not carry. */
export function builtinProfile(id: string): Uint8Array | undefined {
  switch (id as PdfBuiltinProfileId) {
    case "srgb":
      return getDefaultSRGBProfile();
    case "gray":
      return grayGamma22Profile();
    case "cmyk":
      cmyk ??= base64ToBytes(CGATS_TR001_COMPAT_MICRO_BASE64);
      return cmyk;
    default:
      return undefined;
  }
}

/** Every built-in profile's bytes match what the schema says of it — a check the tests run. */
export function builtinProfileSizes(): Record<string, number> {
  return Object.fromEntries(PDF_BUILTIN_PROFILES.map((profile) => [profile.id, builtinProfile(profile.id)?.length ?? -1]));
}
