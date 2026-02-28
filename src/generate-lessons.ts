/**
 * generate-lessons.ts
 *
 * Phase 3: Takes the course structure from extract-subsections.ts and
 * generates full lesson content for every subsection using AI.
 *
 * Each subsection becomes a lesson with:
 *  - Structured instructional text (explanation, examples, intuition)
 *  - Practice questions (multiple choice, short answer, application)
 *  - Memorizeables drill (flashcard-style Q&A for formulas/definitions)
 *  - Key takeaways
 *
 * Saves incrementally per chapter so partial runs can resume.
 *
 * Usage: npx tsx src/generate-lessons.ts
 *
 * Prerequisites: output/course-structure.json must exist
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGateway, generateText, type LanguageModel } from "ai";

// ── Input Types (from course-structure.json) ──────────────────────────

interface Subsection {
  number: string | null;
  title: string;
  keyConcepts: string[];
  memorizeables: string[];
}

interface ChapterBreakdown {
  chapterNumber: string | null;
  chapterTitle: string;
  summary: string;
  subsections: Subsection[];
  assessmentTargets: Array<{
    objective: string;
    questionTypes: string[];
    competency: string;
  }>;
}

interface CourseStructure {
  bookTitle: string;
  generatedAt: string;
  model: string;
  chapters: ChapterBreakdown[];
}

// ── Output Types ──────────────────────────────────────────────────────

interface PracticeQuestion {
  type: "multiple_choice" | "short_answer" | "application";
  question: string;
  choices?: string[];     // for multiple_choice
  answer: string;
  explanation: string;
}

interface MemorizableDrill {
  prompt: string;         // e.g. "What is the formula for..."
  answer: string;         // the formula/definition/fact
  category: "formula" | "definition" | "fact";
}

interface GeneratedLesson {
  sectionNumber: string | null;
  sectionTitle: string;
  chapterNumber: string | null;
  chapterTitle: string;

  // Core instructional content
  overview: string;                 // 1-2 sentence hook
  instructionalText: string;       // main lesson body (markdown)
  workedExamples: string[];        // step-by-step examples
  keyTakeaways: string[];          // 3-5 bullet points

  // Assessment
  practiceQuestions: PracticeQuestion[];
  memorizeableDrills: MemorizableDrill[];
}

interface ChapterLessons {
  chapterNumber: string | null;
  chapterTitle: string;
  summary: string;
  lessons: GeneratedLesson[];
  generatedAt: string;
  model: string;
}

interface LessonsOutput {
  bookTitle: string;
  generatedAt: string;
  model: string;
  totalLessons: number;
  totalQuestions: number;
  totalDrills: number;
  chapters: ChapterLessons[];
}

// ── Config ────────────────────────────────────────────────────────────

const API_KEY = process.env.AI_GATEWAY_API_KEY?.trim();
const MODEL =
  process.env.AI_GATEWAY_MODEL?.trim() || "google/gemini-2.5-flash-lite";
const CONCURRENCY = parseInt(
  process.env.MENTAT_LESSON_CONCURRENCY || "1",
  10
);
const MAX_RETRIES = parseInt(process.env.MENTAT_RETRY_COUNT || "6", 10);
const INITIAL_BACKOFF_MS = 5_000;
const INTER_REQUEST_DELAY_MS = 2_000;

if (!API_KEY) {
  console.error("ERROR: AI_GATEWAY_API_KEY is not set in .env");
  process.exit(1);
}

// ── Retry / Concurrency Helpers ───────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("free credits temporarily") ||
    msg.includes("resource exhausted") ||
    msg.includes("quota")
  );
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseMs: number = INITIAL_BACKOFF_MS
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRateLimitError(err)) {
        const delayMs =
          baseMs * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(
          `  [rate-limit] ${label} — retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`
        );
        await sleep(delayMs);
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.min(concurrency, items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      if (idx > 0) await sleep(INTER_REQUEST_DELAY_MS);
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── AI Prompt ─────────────────────────────────────────────────────────

const LESSON_SYSTEM_PROMPT = `You are an expert engineering educator creating detailed lesson content for a university-level textbook section.

Given a section's title, key concepts, and memorizeables, generate a complete lesson.

Return ONLY valid JSON (no markdown fences, no explanation) in this exact format:

{
  "overview": "A compelling 1-2 sentence hook that motivates why this topic matters.",
  "instructionalText": "Detailed instructional content in markdown. Cover all key concepts thoroughly. Use clear explanations, analogies where helpful, and build from simpler to more complex ideas. Include relevant equations in LaTeX notation (e.g., $F = ma$). Aim for 400-800 words.",
  "workedExamples": [
    "Step-by-step worked example showing how to apply the concepts. Use actual numbers and units."
  ],
  "keyTakeaways": [
    "Concise bullet point summarizing the most important idea"
  ],
  "practiceQuestions": [
    {
      "type": "multiple_choice",
      "question": "Clear question testing understanding",
      "choices": ["A) first option", "B) second option", "C) third option", "D) fourth option"],
      "answer": "A) first option",
      "explanation": "Why this answer is correct and others aren't"
    },
    {
      "type": "short_answer",
      "question": "Question requiring a brief written response",
      "answer": "Expected answer",
      "explanation": "What a good answer should include"
    },
    {
      "type": "application",
      "question": "A problem requiring calculation or application of concepts",
      "answer": "Worked solution with final answer",
      "explanation": "Step-by-step reasoning"
    }
  ],
  "memorizeableDrills": [
    {
      "prompt": "What is the formula for X?",
      "answer": "X = Y / Z",
      "category": "formula"
    }
  ]
}

Rules:
- overview: Motivate the section in 1-2 sentences. Why should the student care?
- instructionalText: Thorough explanation in markdown. Cover ALL listed key concepts. Use subsections (##) if the content is long.
- workedExamples: At least 1 worked example with real numbers. More for complex topics.
- keyTakeaways: 3-5 bullet points a student should remember.
- practiceQuestions: Generate 2-4 questions. Mix types. Make them educational, not trivial.
- memorizeableDrills: Create a flashcard-style drill for EACH memorizable provided. Match the category (formula/definition/fact).
- Be precise with engineering terminology. Use proper units and notation.
- Quality over quantity — every element should genuinely help a student learn.
- CRITICAL: Your output must be valid JSON. When writing LaTeX/math in strings, use DOUBLE backslashes (e.g., "\\sigma", "\\frac{a}{b}", "\\tau") because single backslashes are escape characters in JSON.`;

// ── Lesson Generation ─────────────────────────────────────────────────

async function generateLesson(
  model: LanguageModel,
  chapter: ChapterBreakdown,
  subsection: Subsection,
  subsectionIndex: number,
  totalSubsections: number
): Promise<GeneratedLesson> {
  const sectionLabel = subsection.number
    ? `§${subsection.number}`
    : `#${subsectionIndex + 1}`;
  const label = `Ch ${chapter.chapterNumber} ${sectionLabel}: ${subsection.title}`;
  const startMs = Date.now();

  try {
    const userPrompt = buildLessonPrompt(chapter, subsection);

    const result = await withRetry(label, () =>
      generateText({
        model,
        system: LESSON_SYSTEM_PROMPT,
        prompt: userPrompt,
        maxOutputTokens: 8192,
        temperature: 0.3,
        maxRetries: 1,
        timeout: 120_000,
      })
    );

    const durationMs = Date.now() - startMs;
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;

    console.log(
      `  [done] ${label} — ${(durationMs / 1000).toFixed(1)}s (${inputTokens}/${outputTokens} tokens)`
    );

    const parsed = parseJsonResponse(result.text.trim());

    return {
      sectionNumber: subsection.number,
      sectionTitle: subsection.title,
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.chapterTitle,
      overview: parsed.overview || "",
      instructionalText: parsed.instructionalText || "",
      workedExamples: Array.isArray(parsed.workedExamples)
        ? parsed.workedExamples
        : [],
      keyTakeaways: Array.isArray(parsed.keyTakeaways)
        ? parsed.keyTakeaways
        : [],
      practiceQuestions: (parsed.practiceQuestions || []).map((q: any) => ({
        type: q.type || "short_answer",
        question: q.question || "",
        choices: Array.isArray(q.choices) ? q.choices : undefined,
        answer: q.answer || "",
        explanation: q.explanation || "",
      })),
      memorizeableDrills: (parsed.memorizeableDrills || []).map((d: any) => ({
        prompt: d.prompt || "",
        answer: d.answer || "",
        category: d.category || "fact",
      })),
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.log(
      `  [FAIL] ${label} — ${(durationMs / 1000).toFixed(1)}s — ${err instanceof Error ? err.message : "unknown error"}`
    );

    // Return a minimal fallback lesson
    return {
      sectionNumber: subsection.number,
      sectionTitle: subsection.title,
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.chapterTitle,
      overview: `Section on ${subsection.title}.`,
      instructionalText: `This section covers: ${subsection.keyConcepts.join("; ")}.`,
      workedExamples: [],
      keyTakeaways: subsection.keyConcepts.slice(0, 3),
      practiceQuestions: [],
      memorizeableDrills: subsection.memorizeables.map((m) => {
        const [catPart, ...rest] = m.split(": ");
        const cat = catPart.toLowerCase() as "formula" | "definition" | "fact";
        return {
          prompt: `What is the ${cat}: ${rest.join(": ").slice(0, 50)}...?`,
          answer: rest.join(": "),
          category: ["formula", "definition", "fact"].includes(cat)
            ? cat
            : "fact",
        };
      }),
    };
  }
}

function buildLessonPrompt(
  chapter: ChapterBreakdown,
  subsection: Subsection
): string {
  const parts: string[] = [
    `Generate a complete lesson for this textbook section.`,
    ``,
    `Book: Shigley's Mechanical Engineering Design, 8th Edition`,
    `Chapter ${chapter.chapterNumber}: ${chapter.chapterTitle}`,
    `Chapter Summary: ${chapter.summary}`,
    ``,
    `Section: ${subsection.number || "(unnumbered)"} — ${subsection.title}`,
    ``,
    `Key Concepts to cover:`,
    ...subsection.keyConcepts.map((c, i) => `  ${i + 1}. ${c}`),
  ];

  if (subsection.memorizeables.length > 0) {
    parts.push(``, `Memorizeables (create drills for each):`);
    for (const m of subsection.memorizeables) {
      parts.push(`  - ${m}`);
    }
  }

  return parts.join("\n");
}

// ── JSON Parsing ──────────────────────────────────────────────────────

/**
 * Sanitize invalid backslash escapes in JSON strings.
 *
 * The model frequently outputs LaTeX notation like \sigma, \tau, \frac{},
 * \Delta, etc. inside JSON string values. In JSON, only these escape
 * sequences are valid: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX.
 * Everything else (e.g., \s, \S, \d, \D, \p, \a, \l, \c, \T, \F, etc.)
 * causes a parse error.
 *
 * Strategy: walk through the string and when we find a backslash that
 * is NOT followed by a valid JSON escape character, double it so it
 * becomes a literal backslash in the parsed output.
 */
function sanitizeJsonBackslashes(raw: string): string {
  // Valid JSON escape chars after a backslash
  const validEscapes = new Set([
    '"', "\\", "/", "b", "f", "n", "r", "t", "u",
  ]);

  const chars = [...raw];
  const result: string[] = [];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] === "\\" && i + 1 < chars.length) {
      const next = chars[i + 1];
      if (validEscapes.has(next)) {
        // Valid escape — pass through as-is
        result.push(chars[i], chars[i + 1]);
        i += 2;
      } else {
        // Invalid escape — double the backslash so JSON sees \\
        result.push("\\", "\\");
        i += 1; // only advance past the backslash, keep the next char
      }
    } else {
      result.push(chars[i]);
      i += 1;
    }
  }

  return result.join("");
}

/**
 * Attempt to repair truncated JSON (from hitting the token limit).
 *
 * Strategy:
 * 1. If the string ends mid-value (unterminated string), find the last
 *    complete JSON property/value and truncate there.
 * 2. Close any open arrays and objects by counting brackets.
 */
function repairTruncatedJson(raw: string): string {
  let s = raw;

  // Step 1: If we're mid-string, back up to the last complete string value.
  // Find the last properly closed string (ending with unescaped quote).
  // We repeatedly trim from the end until we get valid bracket closure.

  // Remove trailing incomplete string content — find last `"` that closes a value
  // Walk backward to find a point where we have a balanced-ish structure.
  // Strategy: chop from the end to the last `"` that is preceded by non-backslash,
  // then try to close brackets.

  // First, strip any trailing partial content after the last complete key-value pair.
  // A complete pair ends with: `"..."` or a number or `]` or `}` or `true`/`false`/`null`
  // followed optionally by `,` or whitespace.

  // Find the last occurrence of `"` that could close a string
  for (let attempts = 0; attempts < 20; attempts++) {
    const lastQuote = s.lastIndexOf('"');
    if (lastQuote < 0) break;

    // Check if this quote is escaped
    let backslashCount = 0;
    let idx = lastQuote - 1;
    while (idx >= 0 && s[idx] === "\\") {
      backslashCount++;
      idx--;
    }
    if (backslashCount % 2 !== 0) {
      // This quote is escaped, chop it and try again
      s = s.slice(0, lastQuote);
      continue;
    }

    // This quote closes a string — keep everything up to and including it
    s = s.slice(0, lastQuote + 1);
    break;
  }

  // Step 2: Remove any trailing comma
  s = s.replace(/,\s*$/, "");

  // Step 3: Count open brackets and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") openBraces++;
      else if (ch === "}") openBraces--;
      else if (ch === "[") openBrackets++;
      else if (ch === "]") openBrackets--;
    }
  }

  // Close open arrays first, then objects
  for (let i = 0; i < openBrackets; i++) s += "]";
  for (let i = 0; i < openBraces; i++) s += "}";

  return s;
}

function parseJsonResponse(raw: string): any {
  // First, extract the JSON payload
  let jsonStr = raw;

  // Strip markdown fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    jsonStr = fenced[1].trim();
  } else {
    // Try finding a JSON object
    const braceStart = raw.indexOf("{");
    const braceEnd = raw.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonStr = raw.slice(braceStart, braceEnd + 1);
    }
  }

  // Try parsing directly first (fast path)
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Sanitize LaTeX backslashes and retry
    const sanitized = sanitizeJsonBackslashes(jsonStr);
    try {
      return JSON.parse(sanitized);
    } catch {
      // Attempt truncation repair (for token-limit cutoffs)
      const repaired = repairTruncatedJson(sanitized);
      try {
        return JSON.parse(repaired);
      } catch (e) {
        throw new Error(
          `Could not parse JSON from response: ${e instanceof Error ? e.message : "unknown"}`
        );
      }
    }
  }
}

// ── Incremental Save / Load ───────────────────────────────────────────

const OUT_DIR = path.resolve("output");
const LESSONS_PATH = path.join(OUT_DIR, "lessons.json");

function isFallbackLesson(lesson: GeneratedLesson): boolean {
  return lesson.instructionalText.startsWith("This section covers:");
}

function loadExistingLessons(): Map<string, ChapterLessons> {
  const existing = new Map<string, ChapterLessons>();
  if (fs.existsSync(LESSONS_PATH)) {
    try {
      const data: LessonsOutput = JSON.parse(
        fs.readFileSync(LESSONS_PATH, "utf-8")
      );
      for (const ch of data.chapters) {
        const key = ch.chapterNumber || ch.chapterTitle;
        if (ch.lessons.length > 0) {
          existing.set(key, ch);
        }
      }
    } catch {
      // ignore
    }
  }
  return existing;
}

function saveAllLessons(
  bookTitle: string,
  chapterResults: Map<string, ChapterLessons>
): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const chapters = [...chapterResults.values()].sort((a, b) => {
    const na = parseInt(a.chapterNumber || "0", 10);
    const nb = parseInt(b.chapterNumber || "0", 10);
    return na - nb;
  });

  let totalLessons = 0;
  let totalQuestions = 0;
  let totalDrills = 0;
  for (const ch of chapters) {
    totalLessons += ch.lessons.length;
    for (const l of ch.lessons) {
      totalQuestions += l.practiceQuestions.length;
      totalDrills += l.memorizeableDrills.length;
    }
  }

  const output: LessonsOutput = {
    bookTitle,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    totalLessons,
    totalQuestions,
    totalDrills,
    chapters,
  };

  fs.writeFileSync(LESSONS_PATH, JSON.stringify(output, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  // 1. Load course structure
  const structurePath = path.resolve("output/course-structure.json");
  if (!fs.existsSync(structurePath)) {
    console.error(
      "ERROR: output/course-structure.json not found. Run extract-subsections.ts first."
    );
    process.exit(1);
  }

  const courseStructure: CourseStructure = JSON.parse(
    fs.readFileSync(structurePath, "utf-8")
  );

  const totalSubsections = courseStructure.chapters.reduce(
    (sum, ch) => sum + ch.subsections.length,
    0
  );

  console.log(`\n${courseStructure.bookTitle}`);
  console.log(`Model: ${MODEL}`);
  console.log(
    `Chapters: ${courseStructure.chapters.length} | Subsections: ${totalSubsections}`
  );
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  // 2. Load existing lessons (for incremental resume)
  const existingLessons = loadExistingLessons();
  if (existingLessons.size > 0) {
    console.log(
      `Loaded ${existingLessons.size} previously completed chapters (will skip them).\n`
    );
  }

  // 3. Create gateway model
  const gw = createGateway({ apiKey: API_KEY });
  const model = gw(MODEL);

  // 4. Process chapters one at a time; within each chapter, subsections run at CONCURRENCY
  const allResults = new Map<string, ChapterLessons>(existingLessons);
  let chaptersProcessed = 0;
  let chaptersSkipped = 0;

  const startMs = Date.now();

  for (const chapter of courseStructure.chapters) {
    const key = chapter.chapterNumber || chapter.chapterTitle;

    if (chapter.subsections.length === 0) {
      console.log(
        `[skip] Ch ${chapter.chapterNumber}: ${chapter.chapterTitle} — no subsections`
      );
      continue;
    }

    const existingChapter = existingLessons.get(key);
    if (existingChapter) {
      const failedLessons = existingChapter.lessons.filter(isFallbackLesson);

      if (failedLessons.length === 0) {
        // All lessons succeeded — skip entirely
        console.log(
          `[skip] Ch ${chapter.chapterNumber}: ${chapter.chapterTitle} — ${existingChapter.lessons.length} lessons all OK`
        );
        chaptersSkipped++;
        continue;
      }

      // Some lessons failed — re-process only the failed subsections
      const failedSectionIds = new Set(
        failedLessons.map((l) => l.sectionNumber || l.sectionTitle)
      );
      const subsToRetry = chapter.subsections.filter((sub) =>
        failedSectionIds.has(sub.number || sub.title)
      );

      console.log(
        `\n[retry] Ch ${chapter.chapterNumber}: ${chapter.chapterTitle} — retrying ${subsToRetry.length}/${existingChapter.lessons.length} failed lessons`
      );

      const retriedLessons = await mapWithConcurrency(
        subsToRetry,
        CONCURRENCY,
        async (sub, idx) =>
          generateLesson(model, chapter, sub, idx, subsToRetry.length)
      );

      // Merge: replace failed lessons with retried ones
      const retriedMap = new Map<string, GeneratedLesson>();
      for (const rl of retriedLessons) {
        retriedMap.set(rl.sectionNumber || rl.sectionTitle, rl);
      }

      const mergedLessons = existingChapter.lessons.map((existing) => {
        const id = existing.sectionNumber || existing.sectionTitle;
        return retriedMap.get(id) ?? existing;
      });

      const chapterLessons: ChapterLessons = {
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        summary: chapter.summary,
        lessons: mergedLessons,
        generatedAt: new Date().toISOString(),
        model: MODEL,
      };

      allResults.set(key, chapterLessons);
      chaptersProcessed++;

      saveAllLessons(courseStructure.bookTitle, allResults);

      const stillFailed = mergedLessons.filter(isFallbackLesson).length;
      console.log(
        `  [saved] Ch ${chapter.chapterNumber}: retried ${subsToRetry.length}, still failed: ${stillFailed}`
      );
      continue;
    }

    // Brand new chapter — process all subsections
    console.log(
      `\n[processing] Ch ${chapter.chapterNumber}: ${chapter.chapterTitle} (${chapter.subsections.length} subsections)`
    );

    const lessons = await mapWithConcurrency(
      chapter.subsections,
      CONCURRENCY,
      async (sub, idx) =>
        generateLesson(model, chapter, sub, idx, chapter.subsections.length)
    );

    const chapterLessons: ChapterLessons = {
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.chapterTitle,
      summary: chapter.summary,
      lessons,
      generatedAt: new Date().toISOString(),
      model: MODEL,
    };

    allResults.set(key, chapterLessons);
    chaptersProcessed++;

    // Incremental save after each chapter
    saveAllLessons(courseStructure.bookTitle, allResults);

    const lessonCount = lessons.length;
    const questionCount = lessons.reduce(
      (s, l) => s + l.practiceQuestions.length,
      0
    );
    const drillCount = lessons.reduce(
      (s, l) => s + l.memorizeableDrills.length,
      0
    );
    const failedCount = lessons.filter(isFallbackLesson).length;

    console.log(
      `  [saved] Ch ${chapter.chapterNumber}: ${lessonCount} lessons, ${questionCount} questions, ${drillCount} drills${failedCount > 0 ? `, ${failedCount} FAILED` : ""}`
    );
  }

  const totalDuration = ((Date.now() - startMs) / 1000).toFixed(1);

  // 5. Final stats
  let totalLessons = 0;
  let totalQuestions = 0;
  let totalDrills = 0;
  let totalFailed = 0;
  let totalWorkedExamples = 0;

  for (const ch of allResults.values()) {
    totalLessons += ch.lessons.length;
    for (const l of ch.lessons) {
      totalQuestions += l.practiceQuestions.length;
      totalDrills += l.memorizeableDrills.length;
      totalWorkedExamples += l.workedExamples.length;
      if (isFallbackLesson(l)) totalFailed++;
    }
  }

  console.log("\n" + "═".repeat(70));
  console.log(`  Lesson Generation Complete — ${totalDuration}s`);
  console.log("═".repeat(70));
  console.log(`  Chapters processed:   ${chaptersProcessed} (${chaptersSkipped} skipped)`);
  console.log(`  Total lessons:        ${totalLessons}`);
  console.log(`  Worked examples:      ${totalWorkedExamples}`);
  console.log(`  Practice questions:   ${totalQuestions}`);
  console.log(`  Memorizable drills:   ${totalDrills}`);
  console.log(`  Failed lessons:       ${totalFailed}`);
  console.log("═".repeat(70));

  // 6. Per-chapter summary
  console.log();
  for (const ch of [...allResults.values()].sort(
    (a, b) =>
      parseInt(a.chapterNumber || "0", 10) -
      parseInt(b.chapterNumber || "0", 10)
  )) {
    const qCount = ch.lessons.reduce(
      (s, l) => s + l.practiceQuestions.length,
      0
    );
    const dCount = ch.lessons.reduce(
      (s, l) => s + l.memorizeableDrills.length,
      0
    );
    const eCount = ch.lessons.reduce(
      (s, l) => s + l.workedExamples.length,
      0
    );
    console.log(
      `  Ch ${ch.chapterNumber}: ${ch.chapterTitle} — ${ch.lessons.length} lessons, ${eCount} examples, ${qCount} questions, ${dCount} drills`
    );
  }

  console.log(`\nSaved to: ${LESSONS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
