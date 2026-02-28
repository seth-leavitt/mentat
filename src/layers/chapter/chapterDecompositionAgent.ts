import { AgentRuntime } from "../../agents/runtime/agentRuntime.js";
import { AgentStageResult } from "../../agents/runtime/stageResult.js";
import {
  CourseRoadmap,
  InteractiveVisualizationProposal,
  LessonSpecification,
  RoadmapChapter
} from "../../domain/models.js";
import { asObject, asObjectArray, asString, asStringArray } from "../../utils/json.js";
import { chunkArray, createId } from "../../utils/text.js";

const CHAPTER_SYSTEM_PROMPT = [
  "You are the Chapter Decomposition Agent.",
  "Return only JSON.",
  "Convert each roadmap chapter into lesson specifications.",
  "Every chapter concept must appear in exactly one lesson assignedLearnables list.",
  "Output schema:",
  "{",
  '  "lessons": [',
  "    {",
  '      "chapterId": string,',
  '      "title": string,',
  '      "objectives": string[],',
  '      "assignedLearnables": string[],',
  '      "memorizeables": string[],',
  '      "prerequisites": string[],',
  '      "requiredInteractiveComponentIds": string[],',
  '      "assessmentAlignment": string[],',
  '      "metadata": object',
  "    }",
  "  ]",
  "}"
].join("\n");

export class ChapterDecompositionAgent {
  constructor(private readonly runtime: AgentRuntime) {}

  async decompose(roadmap: CourseRoadmap): Promise<AgentStageResult<LessonSpecification[]>> {
    const run = await this.runtime.runJson<LessonSpecification[]>({
      stage: "chapter_decomposition",
      agentName: `chapter-agent-${roadmap.id}`,
      systemPrompt: CHAPTER_SYSTEM_PROMPT,
      userPrompt: this.buildUserPrompt(roadmap),
      parse: (value) => this.parseLessons(value, roadmap),
      fallback: () => this.buildFallbackLessons(roadmap)
    });

    const normalized = this.enforceCoverage(run.data, roadmap);

    return {
      artifact: normalized,
      traces: [run.trace],
      rawResponses: run.rawText
        ? [
            {
              stage: "chapter_decomposition",
              agentName: `chapter-agent-${roadmap.id}`,
              text: run.rawText
            }
          ]
        : []
    };
  }

  private parseLessons(value: unknown, roadmap: CourseRoadmap): LessonSpecification[] {
    const root = asObject(value);
    const lessonsRaw = asObjectArray(root.lessons);
    const chapterLookup = new Map(roadmap.chapters.map((chapter) => [chapter.id, chapter]));

    const lessons = lessonsRaw
      .map((lesson, index) => this.parseLesson(lesson, index, chapterLookup))
      .filter((lesson): lesson is LessonSpecification => Boolean(lesson));

    return lessons.length > 0 ? lessons : this.buildFallbackLessons(roadmap);
  }

  private parseLesson(
    value: Record<string, unknown>,
    index: number,
    chapterLookup: Map<string, RoadmapChapter>
  ): LessonSpecification | null {
    const chapterId = asString(value.chapterId);
    const chapter = chapterLookup.get(chapterId);

    if (!chapter) {
      return null;
    }

    const assignedLearnables = asStringArray(value.assignedLearnables);
    if (assignedLearnables.length === 0) {
      return null;
    }

    const componentIds = asStringArray(value.requiredInteractiveComponentIds);
    const requiredInteractiveComponents = this.resolveVisuals(chapter, componentIds, assignedLearnables);
    const metadata = this.safeObject(value.metadata);

    return {
      id: createId("lesson-spec", `${chapter.id}-${index + 1}-${asString(value.title, "lesson")}`),
      chapterId: chapter.id,
      title: asString(value.title, `${chapter.title} - Lesson ${index + 1}`),
      objectives: asStringArray(value.objectives),
      assignedLearnables,
      memorizeables: asStringArray(value.memorizeables),
      prerequisites: asStringArray(value.prerequisites),
      requiredInteractiveComponents,
      assessmentAlignment: asStringArray(value.assessmentAlignment),
      metadata: this.normalizeMetadata(metadata)
    };
  }

  private resolveVisuals(
    chapter: RoadmapChapter,
    componentIds: string[],
    learnables: string[]
  ): InteractiveVisualizationProposal[] {
    const byId = chapter.interactiveVisualizations.filter((visual) => componentIds.includes(visual.id));
    if (byId.length > 0) {
      return byId;
    }

    const byConcept = chapter.interactiveVisualizations.filter((visual) =>
      learnables.some((learnable) => visual.concept.toLowerCase().includes(learnable.toLowerCase()))
    );
    if (byConcept.length > 0) {
      return byConcept;
    }

    return chapter.interactiveVisualizations.slice(0, 1);
  }

  private normalizeMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean> {
    const normalizedEntries = Object.entries(metadata)
      .map(([key, value]) => {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return [key, value] as const;
        }
        return null;
      })
      .filter((entry): entry is readonly [string, string | number | boolean] => Boolean(entry));

    return Object.fromEntries(normalizedEntries);
  }

  private safeObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private enforceCoverage(lessons: LessonSpecification[], roadmap: CourseRoadmap): LessonSpecification[] {
    const normalized = [...lessons];

    for (const chapter of roadmap.chapters) {
      const chapterLessons = normalized.filter((lesson) => lesson.chapterId === chapter.id);
      if (chapterLessons.length === 0) {
        normalized.push(...this.buildFallbackLessons({ ...roadmap, chapters: [chapter] }));
        continue;
      }

      const assigned = new Set(chapterLessons.flatMap((lesson) => lesson.assignedLearnables));
      const missingLearnables = chapter.keyConcepts.filter((concept) => !assigned.has(concept));

      if (missingLearnables.length > 0) {
        const targetLesson = chapterLessons[chapterLessons.length - 1];
        targetLesson.assignedLearnables = [...targetLesson.assignedLearnables, ...missingLearnables];
        targetLesson.objectives = [
          ...targetLesson.objectives,
          ...missingLearnables.map((concept) => `Explain and apply ${concept}`)
        ];
      }
    }

    return normalized;
  }

  private buildUserPrompt(roadmap: CourseRoadmap): string {
    const digest = {
      roadmapId: roadmap.id,
      chapters: roadmap.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        keyConcepts: chapter.keyConcepts,
        memorizeables: chapter.memorizeables,
        visualComponentIds: chapter.interactiveVisualizations.map((visual) => ({
          id: visual.id,
          concept: visual.concept,
          template: visual.template
        })),
        assessmentObjectives: chapter.assessmentTargets.map((target) => target.objective)
      }))
    };

    return [
      "Decompose this canonical roadmap into executable lessons.",
      "Ensure no chapter concepts are left unassigned.",
      JSON.stringify(digest, null, 2)
    ].join("\n\n");
  }

  private buildFallbackLessons(roadmap: CourseRoadmap): LessonSpecification[] {
    const lessonSpecs: LessonSpecification[] = [];

    for (const chapter of roadmap.chapters) {
      const conceptGroups = chunkArray(chapter.keyConcepts.length > 0 ? chapter.keyConcepts : [chapter.title], 3);

      conceptGroups.forEach((conceptGroup, lessonIndex) => {
        const priorConceptGroup = conceptGroups[lessonIndex - 1] ?? [];
        const requiredInteractiveComponents = chapter.interactiveVisualizations.filter((visual) =>
          conceptGroup.includes(visual.concept)
        );

        lessonSpecs.push({
          id: createId("lesson-spec", `${chapter.id}-${lessonIndex + 1}`),
          chapterId: chapter.id,
          title: `${chapter.title} - Lesson ${lessonIndex + 1}`,
          objectives: conceptGroup.map((concept) => `Explain and apply ${concept}`),
          assignedLearnables: conceptGroup,
          memorizeables: chapter.memorizeables.filter((memorizeable) =>
            conceptGroup.some((concept) => memorizeable.toLowerCase().includes(concept.toLowerCase()))
          ),
          prerequisites: priorConceptGroup,
          requiredInteractiveComponents:
            requiredInteractiveComponents.length > 0
              ? requiredInteractiveComponents
              : chapter.interactiveVisualizations.slice(0, 1),
          assessmentAlignment: chapter.assessmentTargets.map((target) => target.objective).slice(0, 4),
          metadata: {
            chapterTitle: chapter.title,
            lessonOrder: lessonIndex + 1,
            learnableCount: conceptGroup.length,
            canonicalRoadmap: true
          }
        });
      });
    }

    return lessonSpecs;
  }
}
