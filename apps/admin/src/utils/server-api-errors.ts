import { ApiError } from "../api/client";

type ServerConflictBody = {
  error?: string;
  code?: string;
  field?: "name" | "ip";
};

export function getServerSaveErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  if (error instanceof ApiError) {
    const body = error.body as ServerConflictBody | undefined;
    if (body?.code === "SERVER_NAME_CONFLICT" || body?.field === "name") {
      return t("servers.conflict.name");
    }
    if (body?.code === "SERVER_IP_CONFLICT" || body?.field === "ip") {
      return t("servers.conflict.ip");
    }
    if (body?.error) return body.error;
  }
  return t("common.error");
}