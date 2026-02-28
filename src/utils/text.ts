const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "because",
  "before",
  "between",
  "could",
  "every",
  "first",
  "from",
  "have",
  "into",
  "lesson",
  "more",
  "must",
  "only",
  "other",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/\t/g, " ").replace(/ {2,}/g, " ").trim();
}

export function splitIntoParagraphs(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error("Chunk size must be positive.");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function sentenceCase(value: string): string {
  if (!value) {
    return value;
  }

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function summarizeParagraphs(paragraphs: string[], maxSentences = 2): string {
  const text = normalizeWhitespace(paragraphs.join(" "));
  if (!text) {
    return "Overview pending deeper content extraction.";
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .slice(0, maxSentences);

  if (sentences.length === 0) {
    return text.slice(0, 220);
  }

  return sentences.join(" ");
}

export function extractKeywords(text: string, maxCount: number): string[] {
  const frequency = new Map<string, number>();
  const normalized = normalizeWhitespace(text).toLowerCase();
  const tokens = normalized
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));

  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxCount)
    .map(([keyword]) => keyword);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function createId(prefix: string, seed: string): string {
  const slug = slugify(seed) || "item";
  return `${prefix}-${slug}`;
}
