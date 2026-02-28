export type AgentMode = "live" | "mock";

export interface RuntimeConfig {
  mode: AgentMode;
  gatewayApiKey?: string;
  gatewayModel: string;
  maxOutputTokens: number;
  temperature: number;
  retryCount: number;
  requestTimeoutMs: number;
  lessonAgentConcurrency: number;
  verboseAgentLogs: boolean;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

export function loadRuntimeConfig(): RuntimeConfig {
  const gatewayApiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const mode = resolveMode(gatewayApiKey);

  if (mode === "live" && !gatewayApiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY is required for live agent mode. Set MENTAT_AGENT_MODE=mock to run without API calls."
    );
  }

  return {
    mode,
    gatewayApiKey,
    gatewayModel: readString("AI_GATEWAY_MODEL", DEFAULT_MODEL),
    maxOutputTokens: readNumber("MENTAT_MAX_OUTPUT_TOKENS", 4096, 256),
    temperature: readNumber("MENTAT_TEMPERATURE", 0.2, 0),
    retryCount: readNumber("MENTAT_RETRY_COUNT", 2, 0),
    requestTimeoutMs: readNumber("MENTAT_REQUEST_TIMEOUT_MS", 90000, 1000),
    lessonAgentConcurrency: readNumber("MENTAT_LESSON_CONCURRENCY", 4, 1),
    verboseAgentLogs: readBoolean("MENTAT_VERBOSE_AGENT_LOGS", true)
  };
}

function resolveMode(apiKey: string | undefined): AgentMode {
  const raw = readString("MENTAT_AGENT_MODE", "auto").toLowerCase();

  if (raw === "live") {
    return "live";
  }
  if (raw === "mock") {
    return "mock";
  }

  return apiKey ? "live" : "mock";
}

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number greater than or equal to ${min}. Received: ${raw}`);
  }

  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false). Received: ${raw}`);
}
