/**
 * debug-slicing2.ts — Find actual chapter start positions using section numbering patterns
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const pdfDir = path.resolve("pdfs");
  const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const pdfPath = path.join(pdfDir, pdfs[0]);

  const buffer = fs.readFileSync(pdfPath);
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  const text = result.text;

  // Look for the actual chapter headers by searching for the first section pattern (N-1) for each chapter
  // Shigley's uses "N–1" section numbering
  console.log("=== First section of each chapter (N-1 pattern) ===\n");
  for (let ch = 1; ch <= 20; ch++) {
    const pattern = new RegExp(`${ch}[–\\-−]1\\s`, "g");
    let match;
    const positions: number[] = [];
    while ((match = pattern.exec(text)) !== null) {
      positions.push(match.index);
    }
    if (positions.length > 0) {
      // Show context around first occurrence
      const pos = positions[0];
      const before = text.slice(Math.max(0, pos - 100), pos).replace(/\n/g, "\\n");
      const after = text.slice(pos, pos + 100).replace(/\n/g, "\\n");
      console.log(`Ch ${ch}: first ${ch}-1 at position ${pos}`);
      console.log(`  before: ...${before.slice(-60)}`);
      console.log(`  after:  ${after.slice(0, 80)}...`);
      console.log();
    }
  }

  // Now look for what text appears right around the actual chapter titles
  // Load divisions
  const divisionsFile = JSON.parse(fs.readFileSync("output/divisions.json", "utf-8"));
  const chapters = divisionsFile.divisions.filter((d: any) => d.type === "chapter");

  console.log("\n=== Trying to find actual chapter content boundaries ===\n");
  for (const ch of chapters) {
    const title = ch.title as string;
    // Try to find the title without the table of contents context
    // Look for patterns like: large number + title, or Part header before it
    const escapedTitle = title
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+")
      .replace(/[−–—\-]/g, "[−\\-–—]");

    // Find ALL occurrences
    const pattern = new RegExp(escapedTitle, "gi");
    let match;
    const positions: number[] = [];
    while ((match = pattern.exec(text)) !== null) {
      positions.push(match.index);
    }

    console.log(`Ch ${ch.number} "${ch.title}": ${positions.length} title matches`);
    for (const pos of positions) {
      const ctx = text.slice(Math.max(0, pos - 40), pos + title.length + 20).replace(/\n/g, "\\n");
      console.log(`  @${pos}: ...${ctx}...`);
    }
    console.log();
  }
}

main().catch(console.error);
