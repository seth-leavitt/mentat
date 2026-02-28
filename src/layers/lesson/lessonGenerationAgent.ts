import { AgentRuntime, AgentRunTrace } from "../../agents/runtime/agentRuntime.js";
import { AgentStageResult, StageRawResponse } from "../../agents/runtime/stageResult.js";
import {
  CourseRoadmap,
  GeneratedLesson,
  LessonSpecification,
  PracticeQuestion,
  QuestionType,
  RoadmapChapter
} from "../../domain/models.js";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import { asObject, asObjectArray, asString, asStringArray } from "../../utils/json.js";
import { createId } from "../../utils/text.js";
import { InteractiveGraphicsEngine } from "../graphics/interactiveGraphicsEngine.js";

const QUESTION_ROTATION: QuestionType[] = ["multiple_choice", "short_answer", "application"];

const LESSON_SYSTEM_PROMPT = [
  "You are a Lesson Generation Agent in a multi-agent pipeline.",
  "Return only JSON.",
  "Build instructional content aligned to lesson objectives and assessment targets.",
  "Output schema:",
  "{",
  '  "instructionalText": string,',
  '  "practiceQuestions": [',
  "    {",
  '      "type": "multiple_choice|short_answer|application",',
  '      "prompt": string,',
  '      "expectedCompetency": string',
  "    }",
  "  ],",
  '  "reinforcementLoop": string[]',
  "}"
].join("\n");

interface LessonAgentPayload {
  instructionalText: string;
  practiceQuestions: PracticeQuestion[];
  reinforcementLoop: string[];
}

export class LessonGenerationAgent {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly graphicsEngine: InteractiveGraphicsEngine,
    private readonly lessonConcurrency: number
  ) {}

  async generateAll(
    specifications: LessonSpecification[],
    roadmap: CourseRoadmap
  ): Promise<AgentStageResult<GeneratedLesson[]>> {
    const chapterLookup = new Map(roadmap.chapters.map((chapter) => [chapter.id, chapter]));
    const traces: AgentRunTrace[] = [];
    const rawResponses: StageRawResponse[] = [];

    const generatedLessons = await mapWithConcurrency(
      specifications,
      this.lessonConcurrency,
      async (specification, index) => {
        const chapterContext = chapterLookup.get(specification.chapterId);
        const run = await this.runtime.runJson<LessonAgentPayload>({
          stage: "lesson_generation",
          agentName: `lesson-agent-${specification.id}`,
          systemPrompt: LESSON_SYSTEM_PROMPT,
          userPrompt: this.buildUserPrompt(specification, chapterContext),
          parse: (value) => this.parseLessonPayload(value, specification),
          fallback: () => this.buildFallbackPayload(specification)
        });

        traces.push(run.trace);
        if (run.rawText) {
          rawResponses.push({
            stage: "lesson_generation",
            agentName: `lesson-agent-${specification.id}`,
            text: run.rawText
          });
        }

        return this.composeGeneratedLesson(specification, run.data, index);
      }
    );

    return {
      artifact: generatedLessons,
      traces,
      rawResponses
    };
  }

  private buildUserPrompt(specification: LessonSpecification, chapter?: RoadmapChapter): string {
    const digest = {
      lesson: {
        id: specification.id,
        title: specification.title,
        chapterId: specification.chapterId,
        objectives: specification.objectives,
        assignedLearnables: specification.assignedLearnables,
        memorizeables: specification.memorizeables,
        prerequisites: specification.prerequisites,
        assessmentAlignment: specification.assessmentAlignment,
        requiredInteractiveComponents: specification.requiredInteractiveComponents.map((component) => ({
          id: component.id,
          concept: component.concept,
          template: component.template,
          teachingGoal: component.teachingGoal
        }))
      },
      chapterContext: chapter
        ? {
            title: chapter.title,
            summary: chapter.summary,
            keyConcepts: chapter.keyConcepts
          }
        : null
    };

    return [
      "Generate a complete lesson payload for this lesson specification.",
      "Practice questions must map directly to assigned learnables.",
      JSON.stringify(digest, null, 2)
    ].join("\n\n");
  }

  private parseLessonPayload(value: unknown, specification: LessonSpecification): LessonAgentPayload {
    const root = asObject(value);
    const instructionalText = asString(root.instructionalText);
    const practiceQuestions = asObjectArray(root.practiceQuestions)
      .map((question, index) => this.parseQuestion(question, specification, index))
      .filter((question): question is PracticeQuestion => Boolean(question));
    const reinforcementLoop = asStringArray(root.reinforcementLoop);

    return {
      instructionalText: instructionalText || this.buildFallbackPayload(specification).instructionalText,
      practiceQuestions: practiceQuestions.length > 0 ? practiceQuestions : this.buildFallbackQuestions(specification),
      reinforcementLoop:
        reinforcementLoop.length > 0
          ? reinforcementLoop
          : this.buildFallbackPayload(specification).reinforcementLoop
    };
  }

  private parseQuestion(
    value: Record<string, unknown>,
    specification: LessonSpecification,
    index: number
  ): PracticeQuestion | null {
    const prompt = asString(value.prompt);
    if (!prompt) {
      return null;
    }

    return {
      id: createId("question", `${specification.id}-${index + 1}`),
      type: this.coerceQuestionType(asString(value.type), index),
      prompt,
      expectedCompetency:
        asString(value.expectedCompetency, specification.assignedLearnables[index] ?? "concept mastery") ||
        "concept mastery"
    };
  }

  private coerceQuestionType(value: string, index: number): QuestionType {
    if (value === "multiple_choice" || value === "short_answer" || value === "application") {
      return value;
    }
    return QUESTION_ROTATION[index % QUESTION_ROTATION.length];
  }

  private composeGeneratedLesson(
    specification: LessonSpecification,
    payload: LessonAgentPayload,
    index: number
  ): GeneratedLesson {
    const interactiveComponents = specification.requiredInteractiveComponents.map((proposal) =>
      this.graphicsEngine.createComponent(proposal)
    );

    return {
      id: createId("lesson", `${specification.id}-${index + 1}`),
      specId: specification.id,
      chapterId: specification.chapterId,
      title: specification.title,
      instructionalText: payload.instructionalText,
      interactiveComponents,
      practiceQuestions: payload.practiceQuestions,
      reinforcementLoop: payload.reinforcementLoop
    };
  }

  private buildFallbackPayload(specification: LessonSpecification): LessonAgentPayload {
    return {
      instructionalText: this.buildFallbackInstructionalText(specification),
      practiceQuestions: this.buildFallbackQuestions(specification),
      reinforcementLoop: [
        `Quick recall: restate each concept from ${specification.title} in one sentence.`,
        "Deliberate practice: solve one new scenario using the lesson's visuals.",
        "Reflection: identify one misconception and rewrite the correct model."
      ]
    };
  }

  private buildFallbackInstructionalText(specification: LessonSpecification): string {
    const objectiveLine = `This lesson targets: ${specification.objectives.join("; ")}.`;
    const prereqLine =
      specification.prerequisites.length > 0
        ? `Before starting, revisit: ${specification.prerequisites.join(", ")}.`
        : "No formal prerequisite review is required for this lesson.";
    const learnableExplanations = specification.assignedLearnables.map(
      (learnable) =>
        `${learnable}: define the concept, walk through a practical scenario, and connect it to chapter-level outcomes.`
    );

    return [objectiveLine, prereqLine, ...learnableExplanations].join("\n\n");
  }

  private buildFallbackQuestions(specification: LessonSpecification): PracticeQuestion[] {
    return specification.assignedLearnables.map((learnable, index) => ({
      id: createId("question", `${specification.id}-${index + 1}-${learnable}`),
      type: QUESTION_ROTATION[index % QUESTION_ROTATION.length],
      prompt: `Show that you can apply ${learnable} in a realistic context from this chapter.`,
      expectedCompetency: `${learnable} practical application`
    }));
  }
}
