import { ApiError } from "../api/client";

/** User-facing message for API / network failures. */
export function getApiErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return t("common.networkError");
    if (error.message) return error.message;
  }
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return t("common.networkError");
  }
  if (error instanceof Error && error.message) return error.message;
  return t("common.error");
}