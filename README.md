# mentat
## Vision Statement

We envision a future where any static knowledge base can be transformed into a dynamic, engaging learning journey. Powered entirely by Claude’s APIs, our platform autonomously ingests textbooks and readable PDFs, then orchestrates a network of specialized agents to generate comprehensive, interactive courses.

By combining generative AI, structured pedagogy, and consistent visual design, we aim to convert dense information into intuitive learning pathways—making mastery faster, deeper, and more engaging for learners anywhere in the world.

Our system does not simply summarize content; it reconstructs knowledge into teachable structures, interactive representations, and measurable learning outcomes. The goal is scalable, agent-driven course creation that feels intentionally designed rather than automatically assembled.

---

## General Architecture Summary

### 1. Input & Preprocessing Layer

**Purpose:** Convert static knowledge into structured data.

- Accepts a readable PDF knowledge base.
- Extracts structured text (chapters, sections, headings, formulas, diagrams).
- Normalizes content into a machine-readable internal representation.
- Outputs a structured knowledge corpus to the Roadmap Agent.

---

### 2. Roadmap Generation Agent

**Purpose:** Design the full pedagogical structure of the course.

The Roadmap Agent analyzes the entire knowledge base holistically and generates a complete course blueprint.

For each chapter, it produces:

- Chapter title
- Chapter summary
- Key concepts
- Important memorizeables (formulas, definitions, core facts)
- Proposed interactive visualizations that *teach* core ideas
- End-of-subdivision assessment targets:
  - What must be tested
  - Types of questions
  - Competency objectives

**Output Artifact:**  
A complete Course Roadmap object that defines structure, teaching strategy, and evaluation logic.

This roadmap is the canonical source of truth for downstream agents.

---

### 3. Chapter Decomposition Agent

**Purpose:** Convert roadmap chapters into executable lesson units.

For each chapter:

- Subdivides into lessons.
- Assigns every “learnable” concept to a specific lesson.
- Ensures no concept is unassigned and no redundancy occurs.
- Tracks:
  - Prerequisites
  - Learning objectives
  - Memorizeables
  - Associated interactive components
- Stores all “learnables” in structured lesson metadata.

**Output Artifact:**  
A set of Lesson Specifications containing:

- Lesson objectives
- Assigned learnables
- Required interactive components
- Assessment alignment
- Metadata schema

---

### 4. Lesson Generation Agents (Parallelizable)

**Purpose:** Generate full lesson experiences.

Each lesson is assigned to a dedicated Lesson Agent.

Each Lesson Agent:

- Generates explanatory instructional text.
- Integrates interactive graphics as specified.
- Builds practice questions and reinforcement loops.
- Aligns content with roadmap-defined learning goals.
- Embeds consistent UX components.

Lesson Agents operate in parallel but follow strict shared schemas to ensure coherence.

---

### 5. Interactive Graphics Engine

**Purpose:** Maintain consistent aesthetics and functional patterns.

This is a centralized module responsible for:

- Rendering all interactive graphs and simulations.
- Enforcing consistent:
  - Color systems
  - Typography
  - Interaction patterns
  - Animation behaviors
- Accepting structured parameters from Lesson Agents.
- Returning reusable interactive components.

Interactive elements are not ad hoc; they are generated from standardized templates to maintain cross-course consistency.

---

### 6. Assessment Engine

**Purpose:** Enforce measurable learning.

- Aligns all lesson exercises with roadmap-defined testable objectives.
- Tracks competency coverage.
- Ensures chapter-level and course-level assessments reflect roadmap design.

---

### 7. Orchestration Layer

**Purpose:** Coordinate agentic workflows at scale.

The Orchestrator:

- Spawns and monitors agents.
- Passes artifacts between layers.
- Enforces:
  - Metadata standards
  - Naming conventions
  - Style guides
  - Version control
- Maintains global course integrity.

All generation calls are powered through Claude’s APIs to ensure consistency of reasoning and tone.

---

### 8. Storage & Course Assembly Layer

**Purpose:** Deliver a unified learner experience.

- Stores structured course objects.
- Links roadmap → chapters → lessons → assessments.
- Assembles a coherent course interface.
- Ensures consistent navigation and interaction across all courses.

---

# Coordination Principles for Agentic Workflows

For 20 parallel agents to remain aligned:

1. The Roadmap is authoritative.
2. All “learnables” must be traceable to a roadmap node.
3. All interactive components must use the centralized graphics system.
4. All metadata must follow the shared schema.
5. No agent modifies upstream artifacts without orchestration approval.

---

# System Identity

This is not a summarization tool.

It is an autonomous course-construction engine.

It transforms knowledge into structured pedagogy, interactive representation, and measurable mastery—at scale.

---

## TypeScript Agentic Pipeline

The repository now includes a full TypeScript agentic pipeline that mirrors the design above and executes each generation layer as an explicit agent step.

- `src/layers/input/inputPreprocessingLayer.ts` for PDF ingestion and normalized corpus output
- `src/agents/runtime/agentRuntime.ts` for Claude API calls, retries, JSON parsing, and trace metadata
- `src/layers/roadmap/roadmapGenerationAgent.ts` for canonical roadmap generation via Claude
- `src/layers/chapter/chapterDecompositionAgent.ts` for lesson specification decomposition via Claude
- `src/layers/lesson/lessonGenerationAgent.ts` for parallelized lesson subagent generation via Claude
- `src/layers/graphics/interactiveGraphicsEngine.ts` for standardized visual component payloads
- `src/layers/assessment/assessmentEngine.ts` for competency-aligned assessment planning via Claude
- `src/layers/orchestration/courseOrchestrator.ts` for lifecycle coordination and artifact routing
- `src/layers/orchestration/pipelineArtifactStore.ts` for run-level artifact persistence
- `src/layers/storage/courseAssemblyStore.ts` for assembly and persistence

### Local Run

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
2. Put PDFs in `pdfs/`.
3. Install dependencies with `npm install` (or `npm.cmd install` in PowerShell with script policy restrictions).
4. Run pipeline with `npm run dev`.

Output locations:

- Assembled course packages: `output/courses/`
- Per-run stage artifacts and raw model outputs: `output/runs/<run-id>/`
- Agent traces: `output/runs/<run-id>/agent-traces.json`

### Runtime Modes

- `MENTAT_AGENT_MODE=live` always uses Claude APIs.
- `MENTAT_AGENT_MODE=mock` skips API calls and uses deterministic fallbacks.
- `MENTAT_AGENT_MODE=auto` uses live mode when `ANTHROPIC_API_KEY` is set, otherwise mock mode.
