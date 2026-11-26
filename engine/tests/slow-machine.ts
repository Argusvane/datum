/**
 * How much slower than the development machine this one is right now (1 = as fast or faster, capped
 * at 20): a fixed CPU spin against its time there. Wall-clock bounds in tests are multiplied by it, so
 * a loaded runner gets room while a regression of an order of magnitude still fails. It is sampled
 * once at import from the machine itself; no environment variable sets it.
 */
const REFERENCE_SPIN_MS = 60;

function spin(): number {
  const started = performance.now();
  let s = 0;
  for (let i = 0; i < 10e6; i += 1) {
    s = (s + i * 7) % 1000003;
  }
  return performance.now() - started + (s < 0 ? 1 : 0);
}

export const SLOW_FACTOR: number = Math.min(20, Math.max(1, Math.min(spin(), spin(), spin()) / REFERENCE_SPIN_MS));
