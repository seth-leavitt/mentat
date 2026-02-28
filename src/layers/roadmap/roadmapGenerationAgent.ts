import { AgentRuntime } from "../../agents/runtime/agentRuntime.js";
import { AgentStageResult } from "../../agents/runtime/stageResult.js";
import {
  AssessmentTarget,
  CourseRoadmap,
  InteractiveVisualizationProposal,
  KnowledgeChapter,
  KnowledgeCorpus,
  QuestionType,
  RoadmapChapter
} from "../../domain/models.js";
import { asObject, asObjectArray, asString, asStringArray } from "../../utils/json.js";
import { createId, extractKeywords, normalizeWhitespace } from "../../utils/text.js";

const DEFAULT_QUESTION_TYPES: QuestionType[] = ["multiple_choice", "short_answer", "application"];

const ROADMAP_SYSTEM_PROMPT = [
  "You are the Roadmap Generation Agent for an autonomous course-construction engine.",
  "Return ONLY valid JSON.",
  "The roadmap must be authoritative and pedagogically coherent.",
  "All key concepts and assessments must remain traceable to source chapter ids.",
  "Output schema:",
  "{",
  '  "courseTitle": string,',
  '  "chapters": [',
  "    {",
  '      "sourceChapterId": string,',
  '      "title": string,',
  '      "summary": string,',
  '      "keyConcepts": string[],',
  '      "memorizeables": string[],',
  '      "interactiveVisualizations": [{ "concept": string, "template": "concept_map|timeline|formula_simulator|comparison_matrix", "teachingGoal": string }],',
  '      "assessmentTargets": [{ "objective": string, "questionTypes": ["multiple_choice|short_answer|application"], "competency": string }]',
  "    }",
  "  ]",
  "}"
].join("\n");

export class RoadmapGenerationAgent {
  constructor(private readonly runtime: AgentRuntime) {}

  async generate(corpus: KnowledgeCorpus): Promise<AgentStageResult<CourseRoadmap>> {
    const run = await this.runtime.runJson<CourseRoadmap>({
      stage: "roadmap",
      agentName: `roadmap-agent-${corpus.source.id}`,
      systemPrompt: ROADMAP_SYSTEM_PROMPT,
      userPrompt: this.buildUserPrompt(corpus),
      parse: (value) => this.parseRoadmap(value, corpus),
      fallback: () => this.buildFallbackRoadmap(corpus)
    });

    return {
      artifact: run.data,
      traces: [run.trace],
      rawResponses: run.rawText
        ? [
            {
              stage: "roadmap",
              agentName: `roadmap-agent-${corpus.source.id}`,
              text: run.rawText
            }
          ]
        : []
    };
  }

  private parseRoadmap(value: unknown, corpus: KnowledgeCorpus): CourseRoadmap {
    const root = asObject(value);
    const chapterLookup = new Map(corpus.chapters.map((chapter) => [chapter.id, chapter]));
    const parsedChapters = asObjectArray(root.chapters)
      .map((chapter, index) => this.parseRoadmapChapter(chapter, index, chapterLookup, corpus.chapters[index]))
      .filter((chapter): chapter is RoadmapChapter => Boolean(chapter));

    const chapters = parsedChapters.length > 0 ? parsedChapters : this.buildFallbackRoadmap(corpus).chapters;

    return {
      id: createId("roadmap", corpus.id),
      courseTitle: asString(root.courseTitle, corpus.source.title) || corpus.source.title,
      sourceCorpusId: corpus.id,
      generatedAt: new Date().toISOString(),
      authoritative: true,
      chapters
    };
  }

  private parseRoadmapChapter(
    value: Record<string, unknown>,
    index: number,
    chapterLookup: Map<string, KnowledgeChapter>,
    indexedFallback?: KnowledgeChapter
  ): RoadmapChapter | null {
    const sourceChapterId = asString(value.sourceChapterId, indexedFallback?.id ?? "");
    const sourceChapter = chapterLookup.get(sourceChapterId) ?? indexedFallback;

    if (!sourceChapter) {
      return null;
    }

    const keyConcepts = asStringArray(value.keyConcepts).slice(0, 12);
    const memorizeables = asStringArray(value.memorizeables).slice(0, 12);
    const interactiveVisualizations = asObjectArray(value.interactiveVisualizations)
      .map((item, visualIndex) => this.parseVisualProposal(item, sourceChapter.id, visualIndex))
      .filter((item): item is InteractiveVisualizationProposal => Boolean(item));
    const assessmentTargets = asObjectArray(value.assessmentTargets)
      .map((target) => this.parseAssessmentTarget(target))
      .filter((target): target is AssessmentTarget => Boolean(target));

    return {
      id: createId("roadmap-chapter", `${index + 1}-${sourceChapter.title}`),
      sourceChapterId: sourceChapter.id,
      title: asString(value.title, sourceChapter.title) || sourceChapter.title,
      summary: asString(value.summary, sourceChapter.summary) || sourceChapter.summary,
      keyConcepts: keyConcepts.length > 0 ? keyConcepts : this.deriveKeyConcepts(sourceChapter),
      memorizeables: memorizeables.length > 0 ? memorizeables : sourceChapter.memorizeables,
      interactiveVisualizations:
        interactiveVisualizations.length > 0
          ? interactiveVisualizations
          : this.buildVisualProposals(sourceChapter.id, this.deriveKeyConcepts(sourceChapter)),
      assessmentTargets:
        assessmentTargets.length > 0
          ? assessmentTargets
          : this.deriveKeyConcepts(sourceChapter).slice(0, 5).map((concept) => ({
              objective: `Demonstrate functional understanding of ${concept}`,
              questionTypes: DEFAULT_QUESTION_TYPES,
              competency: `${concept} mastery`
            }))
    };
  }

  private parseVisualProposal(
    value: Record<string, unknown>,
    chapterId: string,
    index: number
  ): InteractiveVisualizationProposal | null {
    const concept = asString(value.concept);
    const template = asString(value.template);
    if (!concept) {
      return null;
    }

    const safeTemplate = this.coerceTemplate(template, concept);
    return {
      id: createId("visual", `${chapterId}-${index + 1}-${concept}`),
      concept,
      template: safeTemplate,
      teachingGoal:
        asString(value.teachingGoal, `Teach ${concept} through direct manipulation and visual explanation.`) ||
        `Teach ${concept} through direct manipulation and visual explanation.`
    };
  }

  private parseAssessmentTarget(value: Record<string, unknown>): AssessmentTarget | null {
    const objective = asString(value.objective);
    const competency = asString(value.competency);

    if (!objective || !competency) {
      return null;
    }

    const questionTypes = asStringArray(value.questionTypes)
      .map((type) => this.coerceQuestionType(type))
      .filter((type): type is QuestionType => Boolean(type));

    return {
      objective,
      questionTypes: questionTypes.length > 0 ? questionTypes : DEFAULT_QUESTION_TYPES,
      competency
    };
  }

  private coerceTemplate(
    template: string,
    concept: string
  ): InteractiveVisualizationProposal["template"] {
    if (template === "concept_map" || template === "timeline" || template === "formula_simulator" || template === "comparison_matrix") {
      return template;
    }
    return this.chooseTemplate(concept);
  }

  private coerceQuestionType(value: string): QuestionType | null {
    if (value === "multiple_choice" || value === "short_answer" || value === "application") {
      return value;
    }
    return null;
  }

  private buildUserPrompt(corpus: KnowledgeCorpus): string {
    const digest = {
      corpusId: corpus.id,
      sourceTitle: corpus.source.title,
      chapters: corpus.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        summary: chapter.summary,
        memorizeables: chapter.memorizeables,
        sectionHeadings: chapter.sections.map((section) => section.heading).slice(0, 12),
        contentExcerpt: normalizeWhitespace(
          chapter.sections
            .map((section) => section.body)
            .join("\n")
            .slice(0, 1800)
        )
      }))
    };

    return [
      "Create a canonical course roadmap from this source corpus digest.",
      "The roadmap must include each source chapter exactly once.",
      "Do not omit assessment targets or visualization proposals.",
      JSON.stringify(digest, null, 2)
    ].join("\n\n");
  }

  private buildFallbackRoadmap(corpus: KnowledgeCorpus): CourseRoadmap {
    const chapters = corpus.chapters.map((chapter, chapterIndex) => {
      const keyConcepts = this.deriveKeyConcepts(chapter);
      return {
        id: createId("roadmap-chapter", `${chapterIndex + 1}-${chapter.title}`),
        sourceChapterId: chapter.id,
        title: chapter.title,
        summary: chapter.summary,
        keyConcepts,
        memorizeables: chapter.memorizeables,
        interactiveVisualizations: this.buildVisualProposals(chapter.id, keyConcepts),
        assessmentTargets: keyConcepts.slice(0, 5).map((concept) => ({
          objective: `Demonstrate functional understanding of ${concept}`,
          questionTypes: DEFAULT_QUESTION_TYPES,
          competency: `${concept} mastery`
        }))
      };
    });

    return {
      id: createId("roadmap", corpus.id),
      courseTitle: corpus.source.title,
      sourceCorpusId: corpus.id,
      generatedAt: new Date().toISOString(),
      authoritative: true,
      chapters
    };
  }

  private deriveKeyConcepts(chapter: KnowledgeChapter): string[] {
    const chapterText = chapter.sections.map((section) => section.body).join(" ");
    const keywords = extractKeywords(chapterText, 10);
    const memorizeableTerms = chapter.memorizeables
      .flatMap((item) => item.split(/[:=-]/))
      .map((item) => item.trim())
      .filter((item) => item.length > 3)
      .slice(0, 6);

    const concepts = [...new Set([...memorizeableTerms, ...keywords])];

    if (concepts.length > 0) {
      return concepts.slice(0, 10);
    }

    return [chapter.title];
  }

  private buildVisualProposals(
    chapterId: string,
    keyConcepts: string[]
  ): InteractiveVisualizationProposal[] {
    return keyConcepts.slice(0, 4).map((concept, index) => ({
      id: createId("visual", `${chapterId}-${index + 1}-${concept}`),
      concept,
      template: this.chooseTemplate(concept),
      teachingGoal: `Teach ${concept} through direct manipulation and visual explanation.`
    }));
  }

  private chooseTemplate(concept: string): InteractiveVisualizationProposal["template"] {
    if (/equation|formula|rate|probability|force|energy/i.test(concept)) {
      return "formula_simulator";
    }
    if (/timeline|sequence|history|period|era/i.test(concept)) {
      return "timeline";
    }
    if (/compare|versus|tradeoff|difference/i.test(concept)) {
      return "comparison_matrix";
    }
    return "concept_map";
  }
}
