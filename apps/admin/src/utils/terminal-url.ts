const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export function buildServerTerminalWsUrl(serverId: string, token?: string): string {
  if (API_BASE) {
    const url = new URL(API_BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/servers/${serverId}/terminal`;
    url.search = "";
    if (token) url.searchParams.set("token", token);
    url.hash = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/api/servers/${serverId}/terminal`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
