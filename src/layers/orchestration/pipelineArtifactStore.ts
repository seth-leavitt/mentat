import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentRunTrace } from "../../agents/runtime/agentRuntime.js";
import { StageRawResponse } from "../../agents/runtime/stageResult.js";

export class PipelineArtifactStore {
  private readonly runDirectory: string;

  constructor(outputDirectory: string, private readonly runId: string) {
    this.runDirectory = path.join(outputDirectory, "runs", runId);
  }

  get directoryPath(): string {
    return this.runDirectory;
  }

  async persistStageArtifact(stage: string, artifact: unknown): Promise<string> {
    await mkdir(this.runDirectory, { recursive: true });
    const filePath = path.join(this.runDirectory, `${stage}.artifact.json`);
    await writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
    return filePath;
  }

  async persistRawResponses(stage: string, rawResponses: StageRawResponse[]): Promise<string | null> {
    if (rawResponses.length === 0) {
      return null;
    }

    await mkdir(this.runDirectory, { recursive: true });
    const filePath = path.join(this.runDirectory, `${stage}.raw-responses.json`);
    await writeFile(filePath, JSON.stringify(rawResponses, null, 2), "utf8");
    return filePath;
  }

  async persistTraces(traces: AgentRunTrace[]): Promise<string> {
    await mkdir(this.runDirectory, { recursive: true });
    const filePath = path.join(this.runDirectory, "agent-traces.json");
    await writeFile(filePath, JSON.stringify(traces, null, 2), "utf8");
    return filePath;
  }

  async persistRunSummary(summary: unknown): Promise<string> {
    await mkdir(this.runDirectory, { recursive: true });
    const filePath = path.join(this.runDirectory, "run-summary.json");
    await writeFile(filePath, JSON.stringify(summary, null, 2), "utf8");
    return filePath;
  }
}
