import type { ServerRecord } from "./ServerFormDrawer";
import { ServerTerminalView, TERMINAL_PANEL_HEIGHT } from "./ServerTerminalView";

type ServerTerminalPanelProps = {
  server: ServerRecord;
  active?: boolean;
  height?: number | string;
};

export function ServerTerminalPanel({
  server,
  active = true,
  height = TERMINAL_PANEL_HEIGHT,
}: ServerTerminalPanelProps) {
  return <ServerTerminalView server={server} active={active} height={height} showHeader />;
}