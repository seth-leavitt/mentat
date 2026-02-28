export function parseJsonFromModelText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response.");
  }

  const fenced = extractFencedJson(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {}
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectCandidate = extractDelimitedJson(trimmed, "{", "}");
    if (objectCandidate) {
      return JSON.parse(objectCandidate);
    }

    const arrayCandidate = extractDelimitedJson(trimmed, "[", "]");
    if (arrayCandidate) {
      return JSON.parse(arrayCandidate);
    }

    throw new Error("Model response did not contain valid JSON.");
  }
}

function extractFencedJson(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractDelimitedJson(text: string, start: string, end: string): string | null {
  const startIndex = text.indexOf(start);
  const endIndex = text.lastIndexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  return text.slice(startIndex, endIndex + 1).trim();
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

export function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => {
    return Boolean(item) && typeof item === "object" && !Array.isArray(item);
  });
}
