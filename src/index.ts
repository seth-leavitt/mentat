import "dotenv/config";

import path from "node:path";

import { AgentRuntime } from "./agents/runtime/agentRuntime.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { AssessmentEngine } from "./layers/assessment/assessmentEngine.js";
import { ChapterDecompositionAgent } from "./layers/chapter/chapterDecompositionAgent.js";
import { InteractiveGraphicsEngine } from "./layers/graphics/interactiveGraphicsEngine.js";
import { InputPreprocessingLayer } from "./layers/input/inputPreprocessingLayer.js";
import { LessonGenerationAgent } from "./layers/lesson/lessonGenerationAgent.js";
import { CourseOrchestrator } from "./layers/orchestration/courseOrchestrator.js";
import { RoadmapGenerationAgent } from "./layers/roadmap/roadmapGenerationAgent.js";
import { CourseAssemblyStore } from "./layers/storage/courseAssemblyStore.js";

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeConfig();
  const runtime = new AgentRuntime(runtimeConfig);

  const pdfDirectory = path.resolve(process.cwd(), process.argv[2] ?? "pdfs");
  const outputDirectory = path.resolve(process.cwd(), "output");

  console.log(
    `[bootstrap] Mentat starting in ${runtimeConfig.mode} mode (${runtimeConfig.gatewayModel}) with lesson concurrency ${runtimeConfig.lessonAgentConcurrency}`
  );

  const orchestrator = new CourseOrchestrator({
    inputLayer: new InputPreprocessingLayer(pdfDirectory),
    roadmapAgent: new RoadmapGenerationAgent(runtime),
    chapterAgent: new ChapterDecompositionAgent(runtime),
    lessonAgent: new LessonGenerationAgent(
      runtime,
      new InteractiveGraphicsEngine(),
      runtimeConfig.lessonAgentConcurrency
    ),
    assessmentEngine: new AssessmentEngine(runtime),
    storageLayer: new CourseAssemblyStore(outputDirectory),
    outputDirectory
  });

  const results = await orchestrator.run();

  if (results.length === 0) {
    console.log(`No PDFs found in ${pdfDirectory}. Add files and rerun npm run dev.`);
    return;
  }

  console.log(`Generated ${results.length} course package(s):`);
  for (const result of results) {
    console.log(`- ${result.courseTitle}`);
    console.log(`  Course: ${result.courseOutputPath}`);
    console.log(`  Run artifacts: ${result.runDirectory}`);
    console.log(`  Agent traces: ${result.tracesPath}`);
    console.log(`  Mode: ${result.mode}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`Pipeline failed: ${error.message}`);
  } else {
    console.error("Pipeline failed due to an unknown error.");
  }

  process.exitCode = 1;
});
