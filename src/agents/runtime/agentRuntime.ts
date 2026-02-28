import { generateText, createGateway, type LanguageModel } from "ai";

import { AgentMode, RuntimeConfig } from "../../config/runtimeConfig.js";
import { parseJsonFromModelText } from "../../utils/json.js";
import { createId } from "../../utils/text.js";

export interface JsonAgentRequest<T> {
  stage: string;
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
  parse: (value: unknown) => T;
  fallback: () => T;
  temperature?: number;
  maxOutputTokens?: number;
  retryCount?: number;
}

export interface AgentRunTrace {
  traceId: string;
  stage: string;
  agentName: string;
  mode: AgentMode;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  attemptCount: number;
  inputTokens: number;
  outputTokens: number;
  fallbackUsed: boolean;
  errorMessage?: string;
}

export interface AgentRunResult<T> {
  data: T;
  trace: AgentRunTrace;
  rawText: string;
}

export class AgentRuntime {
  private readonly model?: LanguageModel;

  constructor(private readonly config: RuntimeConfig) {
    if (config.mode === "live") {
      const gw = createGateway({
        apiKey: config.gatewayApiKey
      });
      this.model = gw(config.gatewayModel);
    }
  }

  async runJson<T>(request: JsonAgentRequest<T>): Promise<AgentRunResult<T>> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    if (this.config.mode === "mock") {
      const data = request.fallback();
      const trace = this.buildTrace({
        request,
        mode: "mock",
        model: "mock-runtime",
        startedAt,
        startedAtMs,
        attemptCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        fallbackUsed: true
      });

      return {
        data,
        trace,
        rawText: ""
      };
    }

    const maxAttempts = Math.max(1, (request.retryCount ?? this.config.retryCount) + 1);
    let lastError: unknown;
    let lastRawText = "";
    let lastInputTokens = 0;
    let lastOutputTokens = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await generateText({
          model: this.model!,
          maxOutputTokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
          temperature: request.temperature ?? this.config.temperature,
          system: request.systemPrompt,
          prompt: request.userPrompt,
          maxRetries: 0,
          timeout: this.config.requestTimeoutMs
        });

        const rawText = result.text.trim();
        const inputTokens = result.usage?.inputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;

        const parsed = request.parse(parseJsonFromModelText(rawText));
        const trace = this.buildTrace({
          request,
          mode: "live",
          model: this.config.gatewayModel,
          startedAt,
          startedAtMs,
          attemptCount: attempt,
          inputTokens,
          outputTokens,
          fallbackUsed: false
        });

        if (this.config.verboseAgentLogs) {
          this.logTrace(trace);
        }

        return {
          data: parsed,
          trace,
          rawText
        };
      } catch (error) {
        lastError = error;
        lastRawText = "";
        lastInputTokens = 0;
        lastOutputTokens = 0;

        if (attempt < maxAttempts) {
          await delay(300 * attempt);
        }
      }
    }

    const fallbackData = request.fallback();
    const trace = this.buildTrace({
      request,
      mode: "live",
      model: this.config.gatewayModel,
      startedAt,
      startedAtMs,
      attemptCount: maxAttempts,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens,
      fallbackUsed: true,
      errorMessage: formatError(lastError)
    });

    if (this.config.verboseAgentLogs) {
      this.logTrace(trace);
    }

    return {
      data: fallbackData,
      trace,
      rawText: lastRawText
    };
  }

  private buildTrace(input: {
    request: JsonAgentRequest<unknown>;
    mode: AgentMode;
    model: string;
    startedAt: string;
    startedAtMs: number;
    attemptCount: number;
    inputTokens: number;
    outputTokens: number;
    fallbackUsed: boolean;
    errorMessage?: string;
  }): AgentRunTrace {
    return {
      traceId: createId("trace", `${input.request.stage}-${input.request.agentName}-${Date.now()}`),
      stage: input.request.stage,
      agentName: input.request.agentName,
      mode: input.mode,
      model: input.model,
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - input.startedAtMs,
      attemptCount: input.attemptCount,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      fallbackUsed: input.fallbackUsed,
      errorMessage: input.errorMessage
    };
  }

  private logTrace(trace: AgentRunTrace): void {
    const modeMarker = trace.mode === "live" ? "live" : "mock";
    const fallbackMarker = trace.fallbackUsed ? "fallback" : "primary";
    console.log(
      `[agent:${trace.stage}] ${trace.agentName} ${modeMarker}/${fallbackMarker} in ${trace.durationMs}ms (${trace.inputTokens}/${trace.outputTokens} tokens)`
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return "Unknown runtime error.";
}
