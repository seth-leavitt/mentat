/**
 * extract-divisions.ts
 *
 * Minimal script: parse a PDF textbook and make ONE AI call
 * to extract the top-level divisions (parts, chapters, sections).
 *
 * Usage: npx tsx src/extract-divisions.ts [path-to-pdf]
 *        Defaults to the first .pdf found in ./pdfs/
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGateway, generateText } from "ai";

// ── Config ────────────────────────────────────────────────────────────
const API_KEY = process.env.AI_GATEWAY_API_KEY?.trim();
const MODEL = process.env.AI_GATEWAY_MODEL?.trim() || "google/gemini-2.5-flash-lite";

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
  const explicit = process.argv[2];
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  const pdfDir = path.resolve("pdfs");
  if (!fs.existsSync(pdfDir)) {
    console.error("No pdfs/ directory found and no PDF path provided.");
    process.exit(1);
  }

  const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) {
    console.error("No PDF files found in pdfs/");
    process.exit(1);
  }

  return path.join(pdfDir, pdfs[0]);
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const pdfPath = resolvePdf();
  const pdfName = path.basename(pdfPath);
  console.log(`\n📄 PDF: ${pdfName}`);
  console.log(`🤖 Model: ${MODEL}\n`);

  // 1. Extract text
  console.log("Extracting text from PDF...");
  const fullText = await extractPdfText(pdfPath);
  console.log(`  Extracted ${fullText.length.toLocaleString()} characters.\n`);

  // 2. Build a condensed excerpt for the AI
  //    We send the first ~15,000 chars (table of contents is usually at the front)
  //    plus a tail sample for context.
  const HEAD_CHARS = 15_000;
  const TAIL_CHARS = 3_000;

  let excerpt = fullText.slice(0, HEAD_CHARS);
  if (fullText.length > HEAD_CHARS + TAIL_CHARS) {
    excerpt += "\n\n[... middle of textbook omitted ...]\n\n";
    excerpt += fullText.slice(-TAIL_CHARS);
  }

  // 3. Make the AI call
  console.log("Calling AI to extract top-level divisions...\n");

  const gw = createGateway({ apiKey: API_KEY });
  const model = gw(MODEL);

  const systemPrompt = `You are a textbook structure analyzer. Given the text content of a textbook (primarily its table of contents and front/back matter), identify ALL top-level divisions.

Return ONLY valid JSON, no markdown fences, no explanation. Use this exact format:

{
  "bookTitle": "The full title of the textbook",
  "divisions": [
    {
      "type": "part | chapter | appendix | preface | index",
      "number": "the number if present, e.g. '1', 'I', 'A', or null",
      "title": "the title of this division",
      "pageNumber": "page number if identifiable, or null"
    }
  ]
}

Rules:
- Include every part, chapter, and appendix you can identify.
- Use "part" for major book divisions that contain chapters (e.g. "Part I: Fundamentals").
- Use "chapter" for individual chapters.
- Use "appendix" for appendices.
- Use "preface" for preface, foreword, introduction sections that precede Chapter 1.
- Use "index" for the index at the end.
- Preserve the exact titles from the book — do not rephrase.
- Order them as they appear in the book.`;

  const userPrompt = `Here is the extracted text from the textbook. Identify all top-level divisions (parts, chapters, appendices, etc.):\n\n${excerpt}`;

  const startMs = Date.now();

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: 8192,
    temperature: 0.1,
    maxRetries: 2,
    timeout: 120_000,
  });

  const durationMs = Date.now() - startMs;
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;

  console.log(`  Done in ${(durationMs / 1000).toFixed(1)}s (${inputTokens} input / ${outputTokens} output tokens)\n`);

  // 4. Parse and display the result
  const rawText = result.text.trim();

  // Try to extract JSON from the response
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Maybe it's wrapped in markdown fences
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      // Try to find a JSON object in the text
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart >= 0 && braceEnd > braceStart) {
        parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
      } else {
        console.error("Failed to parse JSON from response. Raw text:");
        console.error(rawText);
        process.exit(1);
      }
    }
  }

  const data = parsed as {
    bookTitle: string;
    divisions: Array<{
      type: string;
      number: string | null;
      title: string;
      pageNumber: string | null;
    }>;
  };

  // 5. Pretty-print
  console.log("═".repeat(70));
  console.log(`  ${data.bookTitle}`);
  console.log("═".repeat(70));
  console.log();

  for (const div of data.divisions) {
    const num = div.number ? `${div.number}. ` : "";
    const pg = div.pageNumber ? `  (p. ${div.pageNumber})` : "";
    const prefix = div.type === "part" ? "▌ " : div.type === "appendix" ? "  ◆ " : "  ";
    console.log(`${prefix}[${div.type.toUpperCase()}] ${num}${div.title}${pg}`);
  }

  console.log(`\nTotal divisions: ${data.divisions.length}`);

  // 6. Save raw result
  const outDir = path.resolve("output");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "divisions.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nSaved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
