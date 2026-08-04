/**
 * Server-detail navigation contract (foundation stage).
 *
 * Terminal and AI workspace are **contextual** under My Servers — not top-level
 * product navigation. A later task will implement full detail UI and entry points.
 *
 * Reserved route shape: `/servers/:serverId`
 */
export const SERVER_DETAIL_ROUTE = "/servers/:serverId" as const;

export const SERVER_DETAIL_CONTEXTUAL_FEATURES = [
  "terminal",
  "ai-workspace",
] as const;

export type ServerDetailContextualFeature =
  (typeof SERVER_DETAIL_CONTEXTUAL_FEATURES)[number];
