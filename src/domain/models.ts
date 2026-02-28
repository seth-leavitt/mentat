export type QuestionType = "multiple_choice" | "short_answer" | "application";

export interface SourceDocument {
  id: string;
  title: string;
  filePath: string;
  importedAt: string;
  textLength: number;
}

export interface KnowledgeSection {
  id: string;
  heading: string;
  body: string;
  formulas: string[];
  diagrams: string[];
}

export interface KnowledgeChapter {
  id: string;
  title: string;
  summary: string;
  sections: KnowledgeSection[];
  memorizeables: string[];
}

export interface KnowledgeCorpus {
  id: string;
  source: SourceDocument;
  chapters: KnowledgeChapter[];
  createdAt: string;
}

export type VisualizationTemplate =
  | "concept_map"
  | "timeline"
  | "formula_simulator"
  | "comparison_matrix";

export interface InteractiveVisualizationProposal {
  id: string;
  concept: string;
  template: VisualizationTemplate;
  teachingGoal: string;
}

export interface AssessmentTarget {
  objective: string;
  questionTypes: QuestionType[];
  competency: string;
}

export interface RoadmapChapter {
  id: string;
  sourceChapterId: string;
  title: string;
  summary: string;
  keyConcepts: string[];
  memorizeables: string[];
  interactiveVisualizations: InteractiveVisualizationProposal[];
  assessmentTargets: AssessmentTarget[];
}

export interface CourseRoadmap {
  id: string;
  courseTitle: string;
  sourceCorpusId: string;
  generatedAt: string;
  authoritative: true;
  chapters: RoadmapChapter[];
}

export interface LessonSpecification {
  id: string;
  chapterId: string;
  title: string;
  objectives: string[];
  assignedLearnables: string[];
  memorizeables: string[];
  prerequisites: string[];
  requiredInteractiveComponents: InteractiveVisualizationProposal[];
  assessmentAlignment: string[];
  metadata: Record<string, string | number | boolean>;
}

export interface GraphicsStyleProfile {
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    surface: string;
    ink: string;
  };
  typography: {
    heading: string;
    body: string;
    mono: string;
  };
  motionPreset: "calm_reveal" | "guided_focus";
}

export interface InteractiveComponent {
  id: string;
  template: VisualizationTemplate;
  title: string;
  payload: Record<string, unknown>;
  styleProfile: GraphicsStyleProfile;
}

export interface PracticeQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  expectedCompetency: string;
}

export interface GeneratedLesson {
  id: string;
  specId: string;
  chapterId: string;
  title: string;
  instructionalText: string;
  interactiveComponents: InteractiveComponent[];
  practiceQuestions: PracticeQuestion[];
  reinforcementLoop: string[];
}

export interface ChapterAssessmentPlan {
  chapterId: string;
  objectives: string[];
  coverageMap: Record<string, string[]>;
  questionBlueprint: PracticeQuestion[];
}

export interface CourseAssessmentPlan {
  courseRoadmapId: string;
  chapterAssessments: ChapterAssessmentPlan[];
  finalAssessment: PracticeQuestion[];
}

export interface AssembledCourse {
  id: string;
  title: string;
  roadmap: CourseRoadmap;
  lessons: GeneratedLesson[];
  assessments: CourseAssessmentPlan;
  createdAt: string;
  navigation: Array<{
    chapterId: string;
    lessonIds: string[];
  }>;
}
