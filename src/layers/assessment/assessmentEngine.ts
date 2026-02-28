import { AgentRuntime } from "../../agents/runtime/agentRuntime.js";
import { AgentStageResult } from "../../agents/runtime/stageResult.js";
import {
  ChapterAssessmentPlan,
  CourseAssessmentPlan,
  CourseRoadmap,
  GeneratedLesson,
  PracticeQuestion,
  QuestionType
} from "../../domain/models.js";
import { asObject, asObjectArray, asString, asStringArray } from "../../utils/json.js";
import { createId } from "../../utils/text.js";

const ASSESSMENT_SYSTEM_PROMPT = [
  "You are the Assessment Engine Agent.",
  "Return only JSON.",
  "Ensure every roadmap objective is measurable and mapped to generated lessons.",
  "Output schema:",
  "{",
  '  "chapterAssessments": [',
  "    {",
  '      "chapterId": string,',
  '      "objectives": string[],',
  '      "coverageMap": { "competency": string[] },',
  '      "questionBlueprint": [{ "type": "multiple_choice|short_answer|application", "prompt": string, "expectedCompetency": string }]',
  "    }",
  "  ],",
  '  "finalAssessment": [{ "type": "multiple_choice|short_answer|application", "prompt": string, "expectedCompetency": string }]',
  "}"
].join("\n");

export class AssessmentEngine {
  constructor(private readonly runtime: AgentRuntime) {}

  async generate(
    roadmap: CourseRoadmap,
    lessons: GeneratedLesson[]
  ): Promise<AgentStageResult<CourseAssessmentPlan>> {
    const run = await this.runtime.runJson<CourseAssessmentPlan>({
      stage: "assessment",
      agentName: `assessment-agent-${roadmap.id}`,
      systemPrompt: ASSESSMENT_SYSTEM_PROMPT,
      userPrompt: this.buildUserPrompt(roadmap, lessons),
      parse: (value) => this.parseAssessment(value, roadmap, lessons),
      fallback: () => this.buildFallbackAssessment(roadmap, lessons)
    });

    return {
      artifact: run.data,
      traces: [run.trace],
      rawResponses: run.rawText
        ? [
            {
              stage: "assessment",
              agentName: `assessment-agent-${roadmap.id}`,
              text: run.rawText
            }
          ]
        : []
    };
  }

  private buildUserPrompt(roadmap: CourseRoadmap, lessons: GeneratedLesson[]): string {
    const digest = {
      roadmap: {
        id: roadmap.id,
        chapters: roadmap.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          keyConcepts: chapter.keyConcepts,
          assessmentTargets: chapter.assessmentTargets
        }))
      },
      lessons: lessons.map((lesson) => ({
        id: lesson.id,
        chapterId: lesson.chapterId,
        title: lesson.title,
        practiceQuestions: lesson.practiceQuestions.map((question) => ({
          type: question.type,
          expectedCompetency: question.expectedCompetency
        }))
      }))
    };

    return [
      "Generate chapter-level and course-level assessment artifacts.",
      "Coverage maps should reference lesson titles where competencies are practiced.",
      JSON.stringify(digest, null, 2)
    ].join("\n\n");
  }

  private parseAssessment(
    value: unknown,
    roadmap: CourseRoadmap,
    lessons: GeneratedLesson[]
  ): CourseAssessmentPlan {
    const root = asObject(value);
    const chapterAssessments = asObjectArray(root.chapterAssessments)
      .map((chapterAssessment) => this.parseChapterAssessment(chapterAssessment, roadmap))
      .filter((chapterAssessment): chapterAssessment is ChapterAssessmentPlan => Boolean(chapterAssessment));
    const finalAssessment = asObjectArray(root.finalAssessment)
      .map((question, index) => this.parseQuestion(question, `final-${index + 1}`))
      .filter((question): question is PracticeQuestion => Boolean(question));

    if (chapterAssessments.length === 0 || finalAssessment.length === 0) {
      return this.buildFallbackAssessment(roadmap, lessons);
    }

    return {
      courseRoadmapId: roadmap.id,
      chapterAssessments,
      finalAssessment
    };
  }

  private parseChapterAssessment(
    value: Record<string, unknown>,
    roadmap: CourseRoadmap
  ): ChapterAssessmentPlan | null {
    const chapterId = asString(value.chapterId);
    const chapter = roadmap.chapters.find((candidate) => candidate.id === chapterId);
    if (!chapter) {
      return null;
    }

    const coverageRoot = value.coverageMap;
    const coverageMap = this.parseCoverageMap(coverageRoot);
    const objectives = asStringArray(value.objectives);
    const questionBlueprint = asObjectArray(value.questionBlueprint)
      .map((question, questionIndex) => this.parseQuestion(question, `${chapter.id}-${questionIndex + 1}`))
      .filter((question): question is PracticeQuestion => Boolean(question));

    return {
      chapterId: chapter.id,
      objectives: objectives.length > 0 ? objectives : chapter.assessmentTargets.map((target) => target.objective),
      coverageMap,
      questionBlueprint:
        questionBlueprint.length > 0
          ? questionBlueprint
          : chapter.assessmentTargets.map((target, questionIndex) => ({
              id: createId("chapter-assessment", `${chapter.id}-${questionIndex + 1}`),
              type: target.questionTypes[questionIndex % target.questionTypes.length],
              prompt: `Assess ${target.objective} with an evidence-backed response.`,
              expectedCompetency: target.competency
            }))
    };
  }

  private parseCoverageMap(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    const entries = Object.entries(value).map(([key, mappedLessons]) => [key, asStringArray(mappedLessons)] as const);
    return Object.fromEntries(entries);
  }

  private parseQuestion(value: Record<string, unknown>, idSeed: string): PracticeQuestion | null {
    const prompt = asString(value.prompt);
    const expectedCompetency = asString(value.expectedCompetency);
    if (!prompt || !expectedCompetency) {
      return null;
    }

    return {
      id: createId("assessment-question", idSeed),
      type: this.coerceQuestionType(asString(value.type), idSeed),
      prompt,
      expectedCompetency
    };
  }

  private coerceQuestionType(value: string, seed: string): QuestionType {
    if (value === "multiple_choice" || value === "short_answer" || value === "application") {
      return value;
    }

    const hash = seed.split("").reduce((total, character) => total + character.charCodeAt(0), 0);
    const options: QuestionType[] = ["multiple_choice", "short_answer", "application"];
    return options[hash % options.length];
  }

  private buildFallbackAssessment(
    roadmap: CourseRoadmap,
    lessons: GeneratedLesson[]
  ): CourseAssessmentPlan {
    const chapterAssessments = roadmap.chapters.map((chapter) => {
      const chapterLessons = lessons.filter((lesson) => lesson.chapterId === chapter.id);
      const coverageMap: Record<string, string[]> = {};

      for (const target of chapter.assessmentTargets) {
        const matchedLessons = chapterLessons
          .filter((lesson) =>
            lesson.practiceQuestions.some((question) =>
              question.expectedCompetency.toLowerCase().includes(target.competency.split(" ")[0].toLowerCase())
            )
          )
          .map((lesson) => lesson.title);

        coverageMap[target.competency] = matchedLessons;
      }

      const questionBlueprint: PracticeQuestion[] = chapter.assessmentTargets.map((target, index) => ({
        id: createId("chapter-assessment", `${chapter.id}-${index + 1}`),
        type: target.questionTypes[index % target.questionTypes.length],
        prompt: `Assess ${target.objective} with an evidence-backed response.`,
        expectedCompetency: target.competency
      }));

      return {
        chapterId: chapter.id,
        objectives: chapter.assessmentTargets.map((target) => target.objective),
        coverageMap,
        questionBlueprint
      };
    });

    const finalAssessment = roadmap.chapters
      .flatMap((chapter, chapterIndex) =>
        chapter.keyConcepts.slice(0, 2).map((concept, conceptIndex) => ({
          id: createId("final", `${chapter.id}-${chapterIndex + 1}-${conceptIndex + 1}`),
          type: "application" as const,
          prompt: `Integrate ${concept} with concepts from another chapter and justify your reasoning.`,
          expectedCompetency: `${concept} transfer`
        }))
      )
      .slice(0, 12);

    return {
      courseRoadmapId: roadmap.id,
      chapterAssessments,
      finalAssessment
    };
  }
}
