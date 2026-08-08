import { api } from "./client";

export type AgentKind = "ops" | "security";

export type PlatformProvider = {
  id: string;
  name: string;
  source: string;
  provider: "openai" | "ollama" | "custom";
  api_base: string;
  model: string;
  api_key_configured: boolean;
  is_enabled: boolean;
};

export type PlatformSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  compatible_kinds: AgentKind[];
  body_md: string;
  has_scripts: boolean;
  permissions: string[];
  source: string;
  version: number;
  is_enabled: boolean;
  files?: string[];
};

export type PlatformAgent = {
  id: string;
  kind: AgentKind;
  name: string;
  provider_id: string;
  is_enabled: boolean;
  skill_ids: string[];
};

export const platformAiApi = {
  listProviders: () =>
    api<{ items: PlatformProvider[] }>("/api/platform/ai/providers"),
  createProvider: (body: Record<string, unknown>) =>
    api<PlatformProvider>("/api/platform/ai/providers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProvider: (id: string, body: Record<string, unknown>) =>
    api<PlatformProvider>(`/api/platform/ai/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProvider: (id: string) =>
    api<void>(`/api/platform/ai/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    api<{ ok: boolean; model: string; latency_ms: number; error?: string }>(
      `/api/platform/ai/providers/${id}/test`,
      { method: "POST", body: "{}" },
    ),

  listSkills: () => api<{ items: PlatformSkill[] }>("/api/platform/ai/skills"),
  getSkill: (id: string) =>
    api<PlatformSkill>(`/api/platform/ai/skills/${id}`),
  uploadSkill: (files: Record<string, string>) =>
    api<PlatformSkill>("/api/platform/ai/skills/upload", {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
  exportSkill: (id: string) =>
    api<{ files: Record<string, string> }>(
      `/api/platform/ai/skills/${id}/export`,
    ),
  patchSkillMeta: (id: string, body: Record<string, unknown>) =>
    api<PlatformSkill>(`/api/platform/ai/skills/${id}/meta`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  putSkillBody: (id: string, body_md: string) =>
    api<PlatformSkill>(`/api/platform/ai/skills/${id}/body`, {
      method: "PUT",
      body: JSON.stringify({ body_md }),
    }),
  getSkillFile: (id: string, path: string) =>
    api<{ path: string; content: string }>(
      `/api/platform/ai/skills/${id}/files?path=${encodeURIComponent(path)}`,
    ),
  putSkillFile: (id: string, path: string, content: string) =>
    api<PlatformSkill>(`/api/platform/ai/skills/${id}/files`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  deleteSkillFile: (id: string, path: string) =>
    api<PlatformSkill>(
      `/api/platform/ai/skills/${id}/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  renameSkillFile: (id: string, from: string, to: string) =>
    api<PlatformSkill>(`/api/platform/ai/skills/${id}/files`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    }),

  listAgents: () => api<{ items: PlatformAgent[] }>("/api/platform/ai/agents"),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    api<PlatformAgent>(`/api/platform/ai/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};
