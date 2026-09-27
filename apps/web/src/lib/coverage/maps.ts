/**
 * The community coverage maps a survey can be sent to, each with the
 * protocol it takes. Only these addresses are ever sent to: the desktop
 * shell checks the host against its own copy of this list (coverage.rs).
 */

export interface CoverageMap {
  id: string;
  name: string;
  host: string;
  uploadUrl: string;
  /** Where the reader sees the map. */
  siteUrl: string;
  protocol: "wardrive";
}

export const COVERAGE_MAPS: CoverageMap[] = [
  {
    id: "meshcoretel",
    name: "MeshCoreTel",
    host: "meshcoretel.ru",
    uploadUrl: "https://meshcoretel.ru/wardrive/samples",
    siteUrl: "https://meshcoretel.ru/",
    protocol: "wardrive",
  },
];
