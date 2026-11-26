import type { Json } from "../../observation.js";
import type { ProgramSession } from "./session.js";
import { DEFAULT_ABI_FLOOR } from "../../version.js";

/** The smallest valid definition `__datum_inspect` accepts; the request body is otherwise inert. */
const PROBE_DEFINITION = { id: "abi-probe", root: { id: "root", type: "form", configuration: {}, children: { content: [] } } };

export interface AbiDetection {
  /** `M.m.p` of the program, when it answers. Undefined: the program does not speak `__datum_inspect` of the suite's major (another major, broken, or not a sandbox program). */
  detected?: string;
  /** The version the program names in its own `abi_mismatch` message. */
  messageAbi?: string;
  /** `(M-1).9.0` was refused, as an older major must be. */
  majorBelowRefused: boolean;
  /** `(M+1).0.0` was refused. */
  majorAboveRefused: boolean;
  /** The refusal message names a different version than the search found. */
  messageDisagrees?: boolean;
  probes: number;
  /** Why detection could not complete, when it could not. */
  problem?: string;
}

interface Probe {
  accepted: boolean;
  message?: string;
  problem?: string;
}

async function probe(session: ProgramSession, abi: unknown, op = "public"): Promise<Probe> {
  const result = await session.inspect(JSON.stringify({ abi, op, definition: PROBE_DEFINITION }));
  const observation = result.observation;
  if (observation.kind !== "answer") {
    return { accepted: false, problem: observation.kind === "refusal" ? observation.detail : "no answer" };
  }
  const json = observation.json as { ok?: Json; error?: { code?: Json; message?: Json } };
  if (json.ok === true) {
    return { accepted: true };
  }
  if (json.ok === false && json.error?.code === "abi_mismatch") {
    return { accepted: false, ...(typeof json.error.message === "string" ? { message: json.error.message } : {}) };
  }
  return { accepted: false, problem: `unexpected answer ${JSON.stringify(json).slice(0, 160)}` };
}

/**
 * The only way to read a program's own ABI is to ask it (`kernelInspectAbiAccepts`): a request
 * whose major differs, or that is newer than the program's version, is answered `abi_mismatch`.
 * Asks for `M.0.0` of the suite's major (`DEFAULT_ABI_FLOOR`), binary-searches the highest
 * accepted minor of that major and reads the version out of the refusal message to cross-check.
 * A program that refuses `M.0.0` answers another major: detection reports the version its message
 * names, with the problem, and searches no further. Never trusts the banner.
 */
export async function detectAbi(session: ProgramSession): Promise<AbiDetection> {
  let probes = 0;
  const detection: AbiDetection = { majorBelowRefused: false, majorAboveRefused: false, probes: 0 };
  const major = Number(DEFAULT_ABI_FLOOR.split(".")[0]);
  const first = await probe(session, `${major}.0.0`);
  probes += 1;
  if (first.problem !== undefined) {
    return { ...detection, probes, problem: first.problem };
  }
  if (!first.accepted) {
    const named = /answers sandbox ABI (\d+\.\d+\.\d+)/.exec(first.message ?? "")?.[1];
    return {
      ...detection,
      probes,
      ...(named !== undefined ? { detected: named, messageAbi: named } : {}),
      problem: `the program does not accept ABI ${major}.0.0${named !== undefined ? `; it answers ABI ${named}` : ""}`
    };
  }
  let low = 0;
  let high = 100;
  // Invariant: M.low.0 accepted, M.high.0 refused (100 is far above any real minor).
  const top = await probe(session, `${major}.100.0`);
  probes += 1;
  if (top.accepted) {
    return { ...detection, probes, problem: `the program accepts ABI ${major}.100.0, which no program answers` };
  }
  let message = top.message;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const answer = await probe(session, `${major}.${middle}.0`);
    probes += 1;
    if (answer.problem !== undefined) {
      return { ...detection, probes, problem: answer.problem };
    }
    if (answer.accepted) {
      low = middle;
    } else {
      high = middle;
      message = answer.message ?? message;
    }
  }
  const messageAbi = /answers sandbox ABI (\d+\.\d+\.\d+)/.exec(message ?? "")?.[1];
  const below = await probe(session, `${major - 1}.9.0`);
  const above = await probe(session, `${major + 1}.0.0`);
  probes += 2;
  const agrees = messageAbi === undefined || messageAbi.startsWith(`${major}.${low}.`);
  return {
    detected: messageAbi !== undefined && agrees ? messageAbi : `${major}.${low}.0`,
    ...(messageAbi !== undefined ? { messageAbi } : {}),
    ...(agrees ? {} : { messageDisagrees: true }),
    majorBelowRefused: !below.accepted && below.problem === undefined,
    majorAboveRefused: !above.accepted && above.problem === undefined,
    probes
  };
}

/** `a.b.c` compared by number; negative when `a` < `b`. */
export function compareAbi(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let at = 0; at < 3; at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
