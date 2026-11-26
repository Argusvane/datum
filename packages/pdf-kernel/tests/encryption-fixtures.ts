import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFString, StandardFonts, type PDFObject, type SecurityOptions } from "@cantoo/pdf-lib";

/**
 * Encrypted PDFs for the template tests, made with the fork's own `encrypt()`.
 *
 * The fork encrypts a document's streams and leaves its strings in the clear, which no other
 * reader accepts: every string is decrypted on the way in. `encryptStrings` finishes the job
 * the way a conforming writer does — each string of each object under that object's key, with
 * the fork's own cipher — so the fixture reads as a real file does, field names included.
 */
type Transform = { encryptString(text: string): string };
type Factory = new (dict: PDFDict, id: Uint8Array, password: string) => { createCipherTransform(num: number, gen: number): Transform };
type Cipher = new (key: Uint8Array) => { encryptBlock(data: Uint8Array): Uint8Array };
interface ForkCrypto {
  CipherTransformFactory: Factory;
  ARCFourCipher: Cipher;
}

/** The version the kernel pins; the path below is where that release keeps its cipher module. */
const FORK_VERSION = "2.9.1";

async function forkCrypto(): Promise<ForkCrypto> {
  // The fork exports no subpath; its ES build sits beside the entry the package resolves to.
  const entry = createRequire(import.meta.url).resolve("@cantoo/pdf-lib");
  const path = join(dirname(dirname(entry)), "es", "core", "crypto.js");
  if (!existsSync(path)) {
    throw new Error(`The test fixtures need @cantoo/pdf-lib ${FORK_VERSION}'s cipher module at ${path} (es/core/crypto.js beside the package entry ${entry}); it is not there, so the installed release has moved it. Pin ${FORK_VERSION} or update tests/encryption-fixtures.ts.`);
  }
  return (await import(pathToFileURL(path).href)) as ForkCrypto;
}

async function cipherFactory(): Promise<Factory> {
  return (await forkCrypto()).CipherTransformFactory;
}

function binaryString(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

function hex(text: string): string {
  return Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export async function encryptStrings(bytes: Uint8Array, userPassword = ""): Promise<Uint8Array> {
  const Factory = await cipherFactory();
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const encrypt = pdf.context.lookup(pdf.context.trailerInfo.Encrypt, PDFDict);
  const id = pdf.context.lookup(pdf.context.trailerInfo.ID, PDFArray).lookup(0, PDFHexString).asBytes();
  const factory = new Factory(encrypt, id, userPassword);

  const walk = (value: PDFObject, transform: Transform): PDFObject => {
    if (value instanceof PDFString || value instanceof PDFHexString) {
      return PDFHexString.of(hex(transform.encryptString(binaryString(value.asBytes()))));
    }
    if (value instanceof PDFArray) {
      value.asArray().forEach((entry, index) => value.set(index, walk(entry, transform)));
    } else if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        value.set(key, walk(entry, transform));
      }
    }
    return value;
  };

  const encryptDictRef = pdf.context.trailerInfo.Encrypt;
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (ref === encryptDictRef || (object instanceof PDFRawStream && object.dict.lookup(PDFName.of("Type")) === PDFName.of("XRef"))) {
      continue;
    }
    const transform = factory.createCipherTransform(ref.objectNumber, ref.generationNumber);
    walk(object instanceof PDFStream ? object.dict : object, transform);
  }
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

/** A one-page AcroForm (a text field `Name`, a check box `Agree`, with `xfa` an XFA packet too), encrypted as asked, or not at all. */
export async function formTemplate(
  security: SecurityOptions | undefined,
  save: { useObjectStreams: boolean } = { useObjectStreams: false },
  options: { xfa?: boolean } = {}
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([300, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  form.createTextField("Name").addToPage(page, { x: 20, y: 240, width: 200, height: 20, font });
  form.createCheckBox("Agree").addToPage(page, { x: 20, y: 200, width: 14, height: 14 });
  if (options.xfa) {
    // The static XFA of a Service Canada form: a packet beside the AcroForm the kernel strips.
    form.acroForm.dict.set(PDFName.of("XFA"), pdf.context.register(pdf.context.stream("<xdp:xdp xmlns:xdp=\"http://ns.adobe.com/xdp/\"/>")));
  }
  // Saving would refresh the field appearances through `getForm()`, which strips the XFA just put in.
  const saved = { ...save, objectsPerTick: Infinity, updateFieldAppearances: !options.xfa };
  if (!security) {
    return pdf.save(saved);
  }
  pdf.encrypt(security);
  const bytes = await pdf.save(saved);
  // Strings inside object streams are covered by the stream's own encryption; only the strings of objects the file holds on their own need it.
  return save.useObjectStreams ? bytes : encryptStrings(bytes, security.userPassword ?? "");
}

/** The padding string of ISO 32000-1 Algorithm 2: what an empty password pads out to. */
const PASSWORD_PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

const md5 = (...parts: Uint8Array[]): Buffer => createHash("md5").update(Buffer.concat(parts)).digest();

/**
 * An AES-128 (revision 4) template whose Encrypt dictionary says `/EncryptMetadata false` and
 * whose XMP is stored in the clear, deflated, as the specification leaves it. The fork cannot
 * write that: it hashes no 0xFFFFFFFF into the key, and encrypts the metadata. So the key and
 * the user entry are worked out here (Algorithms 2 and 5, empty user password) and given to the
 * fork's own writer, which then encrypts every other stream under them; the metadata stream is
 * put back afterwards, unencrypted.
 */
export async function templateWithClearMetadata(xmp: string): Promise<Uint8Array> {
  const { ARCFourCipher } = await forkCrypto();
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([300, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getForm().createTextField("Name").addToPage(page, { x: 20, y: 240, width: 200, height: 20, font });
  pdf.encrypt({ userPassword: "", ownerPassword: "owner", algorithm: "AES-128", permissions: { fillingForms: true } });

  const context = pdf.context;
  const encrypt = context.lookup(context.trailerInfo.Encrypt, PDFDict);
  const id = context.lookup(context.trailerInfo.ID, PDFArray).lookup(0, PDFHexString).asBytes();
  const owner = encrypt.lookup(PDFName.of("O"), PDFHexString).asBytes();
  const flags = Buffer.alloc(4);
  flags.writeInt32LE(encrypt.lookup(PDFName.of("P"), PDFNumber).asNumber());
  // Algorithm 2 with the 0xFFFFFFFF an unencrypted metadata stream adds, then the 50 rounds of revision 3 and later.
  let key = md5(PASSWORD_PADDING, owner, flags, id, Buffer.from([0xff, 0xff, 0xff, 0xff]));
  for (let round = 0; round < 50; round += 1) {
    key = md5(key.subarray(0, 16));
  }
  key = key.subarray(0, 16);
  // Algorithm 5: the padding and the id, put through RC4 under the key and under it xor-ed with 1 to 19.
  let user: Uint8Array = md5(PASSWORD_PADDING, id);
  for (let round = 0; round < 20; round += 1) {
    user = new ARCFourCipher(Uint8Array.from(key, (byte) => byte ^ round)).encryptBlock(user);
  }
  encrypt.set(PDFName.of("U"), PDFHexString.fromBytes(Buffer.concat([user, PASSWORD_PADDING.subarray(0, 16)])));
  encrypt.set(PDFName.of("EncryptMetadata"), PDFBool.False);
  (context.security as unknown as { encryptionKey: Uint8Array }).encryptionKey = key;

  const saved = await pdf.save({ useObjectStreams: false, objectsPerTick: Infinity, updateFieldAppearances: false });
  const reopened = await PDFDocument.load(saved, { ignoreEncryption: true, updateMetadata: false });
  const metadata = reopened.context.stream(deflateSync(Buffer.from(xmp)), { Type: "Metadata", Subtype: "XML", Filter: "FlateDecode" });
  reopened.catalog.set(PDFName.of("Metadata"), reopened.context.register(metadata));
  const withMetadata = await reopened.save({ useObjectStreams: false, objectsPerTick: Infinity, updateFieldAppearances: false });
  return encryptStrings(withMetadata);
}
