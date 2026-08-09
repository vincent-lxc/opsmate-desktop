import type { ReferencedComponent } from "./monitoring-types";

const BENIGN_UPDATE_RECOMMENDATION = "当前版本暂无已知漏洞，可继续使用";
const OPTIONAL_OUTDATED_RECOMMENDATION_PREFIX = "当前非最新，可考虑升级";

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function versionsDiffer(current: string | null | undefined, latest: string | null | undefined): boolean {
  const a = normalizeVersion(current);
  const b = normalizeVersion(latest);
  if (!a || !b) return false;
  return a !== b;
}

export function isActionableUpdateRecommendation(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  if (trimmed === BENIGN_UPDATE_RECOMMENDATION) return false;
  if (trimmed.startsWith(OPTIONAL_OUTDATED_RECOMMENDATION_PREFIX)) return false;
  return true;
}

/** Non-benign update text shown in the update-recommendation column (incl. optional upgrade hints). */
export function hasDisplayableUpdateRecommendation(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return trimmed !== BENIGN_UPDATE_RECOMMENDATION;
}

/** Lower rank = higher priority (shown first). */
export function referencedComponentIssueRank(component: ReferencedComponent): number {
  if (component.has_known_vulnerabilities) return 0;
  if (isActionableUpdateRecommendation(component.update_recommendation)) return 1;
  if (isReferencedComponentOutdated(component)) return 2;
  return 3;
}

export function sortReferencedComponentsByIssue(
  components: ReferencedComponent[],
): ReferencedComponent[] {
  return [...components].sort((a, b) => {
    const rankDiff = referencedComponentIssueRank(a) - referencedComponentIssueRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });
}

export function isReferencedComponentOutdated(component: ReferencedComponent): boolean {
  return versionsDiffer(component.version, component.latest_version);
}

export function hasReferencedComponentKnownIssue(component: ReferencedComponent): boolean {
  return component.has_known_vulnerabilities || isReferencedComponentOutdated(component);
}

export function hasReferencedComponentAnyIssue(component: ReferencedComponent): boolean {
  return referencedComponentIssueRank(component) < 3;
}

export function countReferencedComponentVulnerabilities(components: ReferencedComponent[]): number {
  return components.filter((c) => c.has_known_vulnerabilities).length;
}

export function countReferencedComponentUpdateRecommendations(
  components: ReferencedComponent[],
): number {
  return components.filter((c) => hasDisplayableUpdateRecommendation(c.update_recommendation)).length;
}

export function countReferencedComponentOutdatedVersions(components: ReferencedComponent[]): number {
  return components.filter((c) => isReferencedComponentOutdated(c)).length;
}

export type ReferencedComponentIssueCounts = {
  vulnerabilities: number;
  updateRecommendations: number;
  outdatedVersions: number;
};

export function summarizeReferencedComponentIssues(
  components: ReferencedComponent[],
): ReferencedComponentIssueCounts {
  return {
    vulnerabilities: countReferencedComponentVulnerabilities(components),
    updateRecommendations: countReferencedComponentUpdateRecommendations(components),
    outdatedVersions: countReferencedComponentOutdatedVersions(components),
  };
}