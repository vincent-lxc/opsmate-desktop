import { useParams } from "react-router-dom";

/**
 * Contract placeholder only (foundation stage).
 *
 * Later tasks will implement full server detail with contextual entry points for:
 * - local Terminal (SSH)
 * - AI workspace
 *
 * Route shape is reserved now so navigation scope stays four top-level items.
 */
export function ServerDetailPlaceholder() {
  const { serverId } = useParams<{ serverId: string }>();

  return (
    <section>
      <h1>服务器详情</h1>
      <p data-testid="server-detail-placeholder">
        Server detail placeholder for <code>{serverId ?? "unknown"}</code>.
      </p>
      <p>
        Terminal and AI workspace will be entered from this context in a later
        task; they are not top-level navigation items.
      </p>
    </section>
  );
}
