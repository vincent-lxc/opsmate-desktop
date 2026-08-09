/** Shared with dependency topology graph — keep in sync. */
export const CATEGORY_COLORS: Record<string, string> = {
  entry_external: "#fa541c",
  entry_internal: "#597ef7",
  application: "#1677ff",
  database: "#722ed1",
  cache: "#fa8c16",
  middleware: "#13c2c2",
  message_queue: "#eb2f96",
  container_runtime: "#595959",
  host_resources: "#52c41a",
  system_service: "#8c8c8c",
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? "#8c8c8c";
}