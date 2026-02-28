import { AgentRunTrace } from "./agentRuntime.js";

export interface StageRawResponse {
  stage: string;
  agentName: string;
  text: string;
}

export interface AgentStageResult<T> {
  artifact: T;
  traces: AgentRunTrace[];
  rawResponses: StageRawResponse[];
}
