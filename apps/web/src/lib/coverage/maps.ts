/**
 * The community coverage maps a survey can be sent to, each with the
 * protocol it takes, in the order the survey's sheet shows them. Only these
 * addresses are ever sent to: the desktop shell checks the host against its
 * own copy of this list (coverage.rs) for a map it posts to itself.
 */

export interface CoverageMap {
  id: string;
  name: string;
  host: string;
  uploadUrl: string;
  /** Where the reader sees the map. */
  siteUrl: string;
  protocol: "wardrive";
  /** Run by the Ommesh project rather than a third party: the sheet names it so. */
  ours?: boolean;
  /** Answers a page from any site, so the page posts to it itself, a browser tab too. */
  anySite?: boolean;
}

export const COVERAGE_MAPS: CoverageMap[] = [
  {
    id: "ommesh",
    name: "Ommesh",
    host: "agent.ommesh.ru",
    uploadUrl: "https://agent.ommesh.ru/wardrive/samples",
    siteUrl: "https://agent.ommesh.ru/",
    protocol: "wardrive",
    ours: true,
    anySite: true,
  },
  {
    id: "meshcoretel",
    name: "MeshCoreTel",
    host: "meshcoretel.ru",
    uploadUrl: "https://meshcoretel.ru/wardrive/samples",
    siteUrl: "https://meshcoretel.ru/",
    protocol: "wardrive",
  },
];
