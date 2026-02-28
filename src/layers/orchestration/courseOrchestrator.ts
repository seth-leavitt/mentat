import { AgentRunTrace } from "../../agents/runtime/agentRuntime.js";
import { createId } from "../../utils/text.js";
import { AssessmentEngine } from "../assessment/assessmentEngine.js";
import { ChapterDecompositionAgent } from "../chapter/chapterDecompositionAgent.js";
import { InputPreprocessingLayer } from "../input/inputPreprocessingLayer.js";
import { LessonGenerationAgent } from "../lesson/lessonGenerationAgent.js";
import { RoadmapGenerationAgent } from "../roadmap/roadmapGenerationAgent.js";
import { CourseAssemblyStore } from "../storage/courseAssemblyStore.js";
import { PipelineArtifactStore } from "./pipelineArtifactStore.js";

export interface CourseOrchestratorDependencies {
  inputLayer: InputPreprocessingLayer;
  roadmapAgent: RoadmapGenerationAgent;
  chapterAgent: ChapterDecompositionAgent;
  lessonAgent: LessonGenerationAgent;
  assessmentEngine: AssessmentEngine;
  storageLayer: CourseAssemblyStore;
  outputDirectory: string;
}

export interface OrchestrationResult {
  runId: string;
  courseId: string;
  courseTitle: string;
  courseOutputPath: string;
  runDirectory: string;
  stageArtifacts: Record<string, string>;
  tracesPath: string;
  mode: "live" | "mock";
}

export class CourseOrchestrator {
  constructor(private readonly dependencies: CourseOrchestratorDependencies) {}

  async run(): Promise<OrchestrationResult[]> {
    const corpora = await this.dependencies.inputLayer.loadKnowledgeCorpora();
    const results: OrchestrationResult[] = [];

    for (const corpus of corpora) {
      const runId = createId("run", `${corpus.source.title}-${Date.now()}`);
      const artifactStore = new PipelineArtifactStore(this.dependencies.outputDirectory, runId);
      const traces: AgentRunTrace[] = [];
      const stageArtifacts: Record<string, string> = {};

      this.log(`[${runId}] Starting orchestration for ${corpus.source.title}`);
      stageArtifacts.input = await artifactStore.persistStageArtifact("input", corpus);

      const roadmapResult = await this.dependencies.roadmapAgent.generate(corpus);
      traces.push(...roadmapResult.traces);
      stageArtifacts.roadmap = await artifactStore.persistStageArtifact("roadmap", roadmapResult.artifact);
      await artifactStore.persistRawResponses("roadmap", roadmapResult.rawResponses);

      const chapterResult = await this.dependencies.chapterAgent.decompose(roadmapResult.artifact);
      traces.push(...chapterResult.traces);
      stageArtifacts.chapterDecomposition = await artifactStore.persistStageArtifact(
        "chapter-decomposition",
        chapterResult.artifact
      );
      await artifactStore.persistRawResponses("chapter-decomposition", chapterResult.rawResponses);

      const lessonResult = await this.dependencies.lessonAgent.generateAll(
        chapterResult.artifact,
        roadmapResult.artifact
      );
      traces.push(...lessonResult.traces);
      stageArtifacts.lessons = await artifactStore.persistStageArtifact("lessons", lessonResult.artifact);
      await artifactStore.persistRawResponses("lessons", lessonResult.rawResponses);

      const assessmentResult = await this.dependencies.assessmentEngine.generate(
        roadmapResult.artifact,
        lessonResult.artifact
      );
      traces.push(...assessmentResult.traces);
      stageArtifacts.assessments = await artifactStore.persistStageArtifact(
        "assessments",
        assessmentResult.artifact
      );
      await artifactStore.persistRawResponses("assessments", assessmentResult.rawResponses);

      const assembledCourse = this.dependencies.storageLayer.assembleCourse(
        roadmapResult.artifact,
        lessonResult.artifact,
        assessmentResult.artifact
      );
      const courseOutputPath = await this.dependencies.storageLayer.persistCourse(assembledCourse);
      stageArtifacts.course = await artifactStore.persistStageArtifact("course", assembledCourse);

      const tracesPath = await artifactStore.persistTraces(traces);
      await artifactStore.persistRunSummary({
        runId,
        sourceDocument: corpus.source,
        courseId: assembledCourse.id,
        stageArtifacts,
        traceCount: traces.length,
        startedAt: traces[0]?.startedAt,
        completedAt: new Date().toISOString()
      });

      const mode = traces.some((trace) => trace.mode === "live") ? "live" : "mock";
      this.log(`[${runId}] Completed in ${mode} mode -> ${courseOutputPath}`);

      results.push({
        runId,
        courseId: assembledCourse.id,
        courseTitle: assembledCourse.title,
        courseOutputPath,
        runDirectory: artifactStore.directoryPath,
        stageArtifacts,
        tracesPath,
        mode
      });
    }

    return results;
  }

  private log(message: string): void {
    console.log(`[orchestrator] ${message}`);
  }
}
