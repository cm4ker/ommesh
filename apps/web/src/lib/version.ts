/**
 * The app's versions as SemVer orders them: a stable X.Y.Z, and a Dev build
 * X.Y.Z-dev.<run>.<attempt> on the way to it (scripts/release.mjs).
 */

/**
 * SemVer's order: numbers by value, a release after its prereleases, and
 * prerelease parts one by one, so 0.4.0-dev.140.1 follows 0.4.0-dev.99.2 and
 * precedes 0.4.0. Build metadata after "+" is left out.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("+")[0]!.split(/-(.*)/s);
  const [coreB = "", preB] = b.split("+")[0]!.split(/-(.*)/s);
  const numbers = (core: string) => core.split(".").map((part) => Number(part) || 0);
  const x = numbers(coreA);
  const y = numbers(coreB);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  const p = preA.split(".");
  const q = preB.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const m = /^\d+$/.test(p[i]!);
    const n = /^\d+$/.test(q[i]!);
    if (m && n) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0) return Math.sign(d);
    } else if (m !== n) {
      // A number part comes before a word part.
      return m ? -1 : 1;
    } else if (p[i] !== q[i]) {
      return p[i]! < q[i]! ? -1 : 1;
    }
  }
  return 0;
}

/** The version a Dev build leads to: 0.7.0 for 0.7.0-dev.250.1. */
export function baseVersion(version: string): string {
  return version.split(/[-+]/)[0]!;
}
