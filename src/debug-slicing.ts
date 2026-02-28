/**
 * debug-slicing.ts — Quick diagnostic to see how chapter headers appear in PDF text
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const pdfDir = path.resolve("pdfs");
  const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const pdfPath = path.join(pdfDir, pdfs[0]);

  console.log("Extracting PDF text...");
  const buffer = fs.readFileSync(pdfPath);
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  const text = result.text;
  console.log(`  ${text.length.toLocaleString()} chars\n`);

  // Search for patterns like "Chapter 1", "Chapter 2", etc.
  const chapterPattern = /Chapter\s+(\d+)/gi;
  let match;
  const seen = new Map<string, number[]>();
  while ((match = chapterPattern.exec(text)) !== null) {
    const num = match[1];
    if (!seen.has(num)) seen.set(num, []);
    seen.get(num)!.push(match.index);
  }

  console.log("=== 'Chapter N' occurrences in PDF text ===\n");
  for (const [num, positions] of [...seen.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`Chapter ${num}: ${positions.length} occurrences`);
    for (const pos of positions.slice(0, 5)) {
      const ctx = text.slice(Math.max(0, pos - 20), pos + 80).replace(/\n/g, "\\n");
      console.log(`  @${pos}: ...${ctx}...`);
    }
    if (positions.length > 5) console.log(`  ... and ${positions.length - 5} more`);
    console.log();
  }

  // Also check: what appears near the beginning of each numbered section pattern
  // Check Shigley's pattern: sections like "1–1", "3–1", etc.
  console.log("\n=== Section numbering patterns (N-N or N–N) ===\n");
  const sectionPattern = /(\d+)[–\-−](\d+)\s+([A-Z][^\n]{5,40})/g;
  const sectionMatches: Array<{ pos: number; full: string; ch: string; sec: string }> = [];
  while ((match = sectionPattern.exec(text)) !== null) {
    sectionMatches.push({
      pos: match.index,
      full: match[0].trim(),
      ch: match[1],
      sec: match[2],
    });
  }
  // Show first occurrence per chapter
  const seenChSec = new Set<string>();
  for (const s of sectionMatches) {
    const key = `${s.ch}-${s.sec}`;
    if (seenChSec.has(key)) continue;
    seenChSec.add(key);
    if (parseInt(s.sec) <= 2) {
      console.log(`  @${s.pos}: ${s.full}`);
    }
  }
}

main().catch(console.error);
