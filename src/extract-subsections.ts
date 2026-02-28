/**
 * extract-subsections.ts
 *
 * Phase 2: Takes the divisions from extract-divisions.ts and runs
 * concurrent AI agents (one per chapter) to extract subsections,
 * key concepts, memorizeables, and assessment targets.
 *
 * Usage: npx tsx src/extract-subsections.ts
 *
 * Prerequisites: output/divisions.json must exist (run extract-divisions.ts first)
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGateway, generateText, type LanguageModel } from "ai";

// ── Types ─────────────────────────────────────────────────────────────

interface Division {
  type: "part" | "chapter" | "appendix" | "preface" | "index";
  number: string | null;
  title: string;
  pageNumber: string | null;
}

interface DivisionsFile {
  bookTitle: string;
  divisions: Division[];
}

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

// ── Config ────────────────────────────────────────────────────────────

const API_KEY = process.env.AI_GATEWAY_API_KEY?.trim();
const MODEL = process.env.AI_GATEWAY_MODEL?.trim() || "google/gemini-2.5-flash-lite";
const CONCURRENCY = parseInt(process.env.MENTAT_LESSON_CONCURRENCY || "2", 10);
const MAX_RETRIES = parseInt(process.env.MENTAT_RETRY_COUNT || "6", 10);
const INITIAL_BACKOFF_MS = 5_000; // 5s base backoff
const INTER_REQUEST_DELAY_MS = 2_000; // 2s pause between requests to avoid triggering rate limits

if (!API_KEY) {
  console.error("ERROR: AI_GATEWAY_API_KEY is not set in .env");
  process.exit(1);
}

// ── PDF Text Extraction ───────────────────────────────────────────────

async function extractPdfText(pdfPath: string): Promise<string> {
  const buffer = fs.readFileSync(pdfPath);
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  return result.text;
}

// ── Find PDF ──────────────────────────────────────────────────────────

function resolvePdf(): string {
  const pdfDir = path.resolve("pdfs");
  const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) {
    console.error("No PDF files found in pdfs/");
    process.exit(1);
  }
  return path.join(pdfDir, pdfs[0]);
}

// ── Text Slicing ──────────────────────────────────────────────────────

/**
 * Find chapter boundaries by locating the "Chapter Outline" header that
 * precedes each chapter's section listing. Every chapter in Shigley's has
 * a "Chapter Outline" block followed by "N–1 Title PageNum\nN–2 Title..."
 *
 * This is far more reliable than matching bare "N–1" patterns, which also
 * appear in homework problem numbers at the end of each chapter and in
 * the Appendix B answer key.
 *
 * Strategy:
 * 1. Find ALL "Chapter Outline" occurrences in the text.
 * 2. For each one, read the text immediately after to determine which
 *    chapter it belongs to (by matching the "N–1" pattern that follows).
 * 3. Map each chapter division to its corresponding "Chapter Outline" anchor.
 * 4. Slice text between consecutive anchors.
 */
function sliceChapterTexts(
  fullText: string,
  divisions: Division[]
): Map<number, string> {
  const chapterTexts = new Map<number, string>();

  // Collect chapter divisions with their index
  const chapters = divisions
    .map((div, idx) => ({ div, idx }))
    .filter(({ div }) => div.type === "chapter");

  if (chapters.length === 0) return chapterTexts;

  interface Anchor {
    divIndex: number;
    chapterNumber: number;
    position: number;
  }

  // Find all "Chapter Outline" occurrences and determine which chapter each belongs to
  const outlinePattern = /Chapter\s+Outline\s*/gm;
  const outlineMatches: Array<{ position: number; chapterNumber: number }> = [];

  let match;
  while ((match = outlinePattern.exec(fullText)) !== null) {
    const pos = match.index;
    // Look at the text immediately after "Chapter Outline\n" to find "N–1"
    const after = fullText.slice(pos + match[0].length, pos + match[0].length + 30);
    const sectionMatch = after.match(/^(\d+)[–\-−—]1/);
    if (sectionMatch) {
      outlineMatches.push({
        position: pos,
        chapterNumber: parseInt(sectionMatch[1], 10),
      });
    }
  }

  console.log(`  Found ${outlineMatches.length} "Chapter Outline" markers in text.`);

  // Map each chapter division to its "Chapter Outline" anchor
  const anchors: Anchor[] = [];
  for (const { div, idx } of chapters) {
    const chNum = parseInt(div.number!, 10);
    if (isNaN(chNum)) continue;

    const outline = outlineMatches.find((o) => o.chapterNumber === chNum);
    if (outline) {
      anchors.push({ divIndex: idx, chapterNumber: chNum, position: outline.position });
    } else {
      console.log(`  [warn] No "Chapter Outline" found for Ch ${chNum}: ${div.title}`);
    }
  }

  // Sort anchors by position in text (should already be in order)
  anchors.sort((a, b) => a.position - b.position);

  // Validate: anchors should be in chapter-number order
  let prevChNum = 0;
  for (const anchor of anchors) {
    if (anchor.chapterNumber < prevChNum) {
      console.log(
        `  [warn] Chapter ordering anomaly: Ch ${anchor.chapterNumber} ` +
          `appears after Ch ${prevChNum} in text (position ${anchor.position})`
      );
    }
    prevChNum = anchor.chapterNumber;
  }

  // Log anchor positions for debugging
  for (const anchor of anchors) {
    const div = divisions[anchor.divIndex];
    const ctx = fullText
      .slice(anchor.position, anchor.position + 80)
      .replace(/\n/g, "\\n");
    console.log(
      `  [anchor] Ch ${div.number} @ position ${anchor.position}: ${ctx}`
    );
  }

  // Slice text between consecutive anchors
  const MAX_CHAPTER_CHARS = 20_000;
  for (let a = 0; a < anchors.length; a++) {
    const anchor = anchors[a];
    const startPos = anchor.position;
    const endPos =
      a + 1 < anchors.length ? anchors[a + 1].position : fullText.length;

    const text = fullText.slice(
      startPos,
      Math.min(startPos + MAX_CHAPTER_CHARS, endPos)
    );

    chapterTexts.set(anchor.divIndex, text);
  }

  return chapterTexts;
}

// ── Concurrent Agent Execution ────────────────────────────────────────

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
      if (idx > 0) await sleep(INTER_REQUEST_DELAY_MS); // pace requests
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── Retry with Exponential Backoff ────────────────────────────────────

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
        // Exponential backoff: 3s, 6s, 12s, 24s, 48s + jitter
        const delayMs = baseMs * Math.pow(2, attempt) + Math.random() * 1000;
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

// ── AI Agent: Extract Subsections ─────────────────────────────────────

const SYSTEM_PROMPT = `You are a textbook structure analyzer and pedagogical planner.
Given the text of a single textbook chapter, identify its internal structure and educational content.

Return ONLY valid JSON (no markdown fences, no explanation) in this exact format:

{
  "summary": "A 2-3 sentence summary of what this chapter covers",
  "subsections": [
    {
      "number": "section number like '3.1' or null if not numbered",
      "title": "exact section title from the text",
      "keyConcepts": ["concept1", "concept2"],
      "memorizeables": ["formula: F = ma", "definition: Stress is force per unit area"]
    }
  ],
  "assessmentTargets": [
    {
      "objective": "what the student should be able to do",
      "questionTypes": ["multiple_choice", "short_answer", "application"],
      "competency": "the skill being measured"
    }
  ]
}

Rules:
- Identify ALL subsections/sections within the chapter. Look for numbered sections (e.g., 3-1, 3.1, 3–1).
- Preserve exact section titles from the text.
- keyConcepts: the 2-5 most important ideas in that section.
- memorizeables: formulas, definitions, key facts a student MUST remember. Prefix with "formula:", "definition:", or "fact:" as appropriate.
- assessmentTargets: 3-6 things a student should be tested on after completing this chapter.
- Be thorough but concise. Quality over quantity for memorizeables.`;

async function extractChapterSubsections(
  model: LanguageModel,
  division: Division,
  chapterText: string
): Promise<ChapterBreakdown> {
  const label = `Ch ${division.number}: ${division.title}`;
  const startMs = Date.now();

  try {
    const result = await withRetry(label, () =>
      generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: `Analyze this chapter and extract its subsections, key concepts, memorizeables, and assessment targets.\n\nChapter ${division.number}: ${division.title}\n\n${chapterText}`,
        maxOutputTokens: 4096,
        temperature: 0.1,
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
      chapterNumber: division.number,
      chapterTitle: division.title,
      summary: parsed.summary || `Chapter ${division.number}: ${division.title}`,
      subsections: (parsed.subsections || []).map((s: any) => ({
        number: s.number || null,
        title: s.title || "Untitled Section",
        keyConcepts: Array.isArray(s.keyConcepts) ? s.keyConcepts : [],
        memorizeables: Array.isArray(s.memorizeables) ? s.memorizeables : [],
      })),
      assessmentTargets: (parsed.assessmentTargets || []).map((a: any) => ({
        objective: a.objective || "",
        questionTypes: Array.isArray(a.questionTypes) ? a.questionTypes : ["multiple_choice"],
        competency: a.competency || "",
      })),
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.log(`  [FAIL] ${label} — ${(durationMs / 1000).toFixed(1)}s — ${err instanceof Error ? err.message : "unknown error"}`);

    return {
      chapterNumber: division.number,
      chapterTitle: division.title,
      summary: `Failed to analyze: ${division.title}`,
      subsections: [],
      assessmentTargets: [],
    };
  }
}

function parseJsonResponse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    // Try stripping markdown fences
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1].trim());

    // Try finding a JSON object
    const braceStart = raw.indexOf("{");
    const braceEnd = raw.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      return JSON.parse(raw.slice(braceStart, braceEnd + 1));
    }

    throw new Error("Could not parse JSON from response");
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  // 1. Load divisions
  const divisionsPath = path.resolve("output/divisions.json");
  if (!fs.existsSync(divisionsPath)) {
    console.error("ERROR: output/divisions.json not found. Run extract-divisions.ts first.");
    process.exit(1);
  }

  const divisionsFile: DivisionsFile = JSON.parse(fs.readFileSync(divisionsPath, "utf-8"));
  const chapters = divisionsFile.divisions.filter((d) => d.type === "chapter");

  console.log(`\n${divisionsFile.bookTitle}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Chapters to process: ${chapters.length}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  // 2. Extract PDF text
  const pdfPath = resolvePdf();
  console.log("Extracting PDF text...");
  const fullText = await extractPdfText(pdfPath);
  console.log(`  ${fullText.length.toLocaleString()} characters extracted.\n`);

  // 3. Slice text per chapter
  console.log("Slicing text by chapter...");
  const chapterTexts = sliceChapterTexts(fullText, divisionsFile.divisions);
  console.log(`  Found text boundaries for ${chapterTexts.size}/${chapters.length} chapters.\n`);

  // Build work items: only chapters that have text
  const workItems: Array<{ division: Division; text: string; divIndex: number }> = [];

  // Load existing results so we can skip already-completed chapters
  const outPath = path.join(path.resolve("output"), "course-structure.json");
  let existingResults = new Map<string, ChapterBreakdown>();
  if (fs.existsSync(outPath)) {
    try {
      const existing: CourseStructure = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      for (const ch of existing.chapters) {
        if (ch.subsections.length > 0) {
          existingResults.set(ch.chapterNumber || ch.chapterTitle, ch);
        }
      }
      console.log(`  Loaded ${existingResults.size} previously completed chapters (will skip them).\n`);
    } catch {
      // ignore parse errors
    }
  }

  for (const [divIndex, text] of chapterTexts) {
    const div = divisionsFile.divisions[divIndex];
    const key = div.number || div.title;
    if (existingResults.has(key)) {
      console.log(`  [skip] Ch ${div.number}: ${div.title} — already completed`);
      continue;
    }
    workItems.push({
      division: div,
      text,
      divIndex,
    });
  }

  if (workItems.length === 0 && existingResults.size === 0) {
    console.error("No chapter text could be extracted. Check PDF and division data.");
    process.exit(1);
  }

  if (workItems.length === 0) {
    console.log("\nAll chapters already completed! No new work to do.\n");
  }

  // 4. Create gateway model
  const gw = createGateway({ apiKey: API_KEY });
  const model = gw(MODEL);

  // 5. Run concurrent subsection agents
  let results: ChapterBreakdown[] = [];
  let totalDuration = "0";

  if (workItems.length > 0) {
    console.log(`Launching ${workItems.length} subsection agents (concurrency=${CONCURRENCY})...\n`);
    const startMs = Date.now();

    results = await mapWithConcurrency(workItems, CONCURRENCY, async (item) => {
      return extractChapterSubsections(model, item.division, item.text);
    });

    totalDuration = ((Date.now() - startMs) / 1000).toFixed(1);
  }

  // 6. Assemble final structure — merge existing completed + new results
  //    Build full chapter list in original order
  const allChapterResults: ChapterBreakdown[] = [];
  let newResultIdx = 0;
  for (const [divIndex] of chapterTexts) {
    const div = divisionsFile.divisions[divIndex];
    const key = div.number || div.title;
    if (existingResults.has(key)) {
      allChapterResults.push(existingResults.get(key)!);
    } else if (newResultIdx < results.length) {
      allChapterResults.push(results[newResultIdx++]);
    }
  }

  const courseStructure: CourseStructure = {
    bookTitle: divisionsFile.bookTitle,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    chapters: allChapterResults,
  };

  // 7. Stats
  const totalSubsections = allChapterResults.reduce((sum, ch) => sum + ch.subsections.length, 0);
  const totalConcepts = allChapterResults.reduce(
    (sum, ch) => sum + ch.subsections.reduce((s, sub) => s + sub.keyConcepts.length, 0),
    0
  );
  const totalMemorizeables = allChapterResults.reduce(
    (sum, ch) => sum + ch.subsections.reduce((s, sub) => s + sub.memorizeables.length, 0),
    0
  );
  const failedChapters = allChapterResults.filter((ch) => ch.subsections.length === 0).length;

  console.log("\n" + "═".repeat(70));
  console.log(`  Done in ${totalDuration}s`);
  console.log("═".repeat(70));
  console.log(`  Chapters processed: ${allChapterResults.length}`);
  console.log(`  Subsections found:  ${totalSubsections}`);
  console.log(`  Key concepts:       ${totalConcepts}`);
  console.log(`  Memorizeables:      ${totalMemorizeables}`);
  console.log(`  Failed chapters:    ${failedChapters}`);
  console.log("═".repeat(70));

  // 8. Pretty-print summary
  console.log();
  for (const ch of allChapterResults) {
    const status = ch.subsections.length > 0 ? "OK" : "FAILED";
    console.log(`[${status}] Ch ${ch.chapterNumber}: ${ch.chapterTitle} — ${ch.subsections.length} subsections`);
    for (const sub of ch.subsections) {
      const num = sub.number ? `${sub.number} ` : "";
      console.log(`      ${num}${sub.title} (${sub.keyConcepts.length} concepts, ${sub.memorizeables.length} memorizeables)`);
    }
  }

  // 9. Save output
  const outDir = path.resolve("output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(outPath, JSON.stringify(courseStructure, null, 2));
  console.log(`\nSaved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
