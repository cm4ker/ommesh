/**
 * Mini-app Store catalog.
 *
 * Ships with the official offline-installable reference bundles (`ommesh.chess`
 * and `ommesh.lora-calc`) so they work without internet and can be installed,
 * uninstalled, and re-installed identically to third-party `.omapp` packages.
 */

import { encodeOmapp, type MiniAppPackage } from "@ommesh/miniapp-sdk";
import { battleshipPackage } from "./battleshipBundle.js";
import { checkersPackage } from "./checkersBundle.js";
import { chessPackage } from "./chessBundle.js";
import { loraCalcPackage } from "./loraCalcBundle.js";

export interface CatalogEntry {
  pkg: MiniAppPackage;
  sizeBytes: number;
  verified: boolean;
}

const BUILTIN_PACKAGES: MiniAppPackage[] = [chessPackage, checkersPackage, battleshipPackage, loraCalcPackage];

export const STORE_CATALOG: CatalogEntry[] = BUILTIN_PACKAGES.map((pkg) => ({
  pkg,
  sizeBytes: encodeOmapp(pkg).length,
  verified: true,
}));

export function findCatalogById(id: string): CatalogEntry | null {
  return STORE_CATALOG.find((c) => c.pkg.manifest.id === id) ?? null;
}

export function findCatalogByAppId(appId: number): CatalogEntry | null {
  if (appId === 0) return null;
  return STORE_CATALOG.find((c) => c.pkg.manifest.appId === appId) ?? null;
}
