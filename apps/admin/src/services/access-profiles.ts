import { api } from "../api/client";
import type { FeatureKey, FeatureMatrix } from "./entitlements";

export type AccessProfile = {
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  menu_paths: string[];
  features: FeatureMatrix;
  updated_at: string;
};

export type TelegramMenuSyncResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

export type AccessProfileUpdateResult = AccessProfile & {
  telegram_sync: TelegramMenuSyncResult;
};

export function fetchFreeAccessProfile(): Promise<AccessProfile> {
  return api<AccessProfile>("/api/platform/access-profiles/free");
}

export function updateFreeAccessProfile(input: {
  menu_paths: string[];
  features: Partial<Record<FeatureKey, boolean>>;
}): Promise<AccessProfileUpdateResult> {
  return api<AccessProfileUpdateResult>("/api/platform/access-profiles/free", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function syncFreeTelegramMenu(): Promise<TelegramMenuSyncResult> {
  return api<TelegramMenuSyncResult>("/api/platform/access-profiles/free/sync-telegram", {
    method: "POST",
  });
}
