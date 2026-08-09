export type AIProvider = "openai" | "ollama" | "custom";

export const AI_PROVIDER_PRESETS: Record<
  AIProvider,
  {
    api_base: string;
    model: string;
  }
> = {
  openai: {
    api_base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  ollama: {
    api_base: "https://ollama.com/v1",
    model: "gpt-oss:120b",
  },
  custom: {
    api_base: "",
    model: "",
  },
};

export const AI_CONFIG_DEFAULTS = {
  provider: "openai" as AIProvider,
  similarity_threshold: 0.75,
  temperature: 0.1,
};