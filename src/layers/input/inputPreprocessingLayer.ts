import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { KnowledgeChapter, KnowledgeCorpus, KnowledgeSection } from "../../domain/models.js";
import {
  chunkArray,
  createId,
  normalizeWhitespace,
  sentenceCase,
  splitIntoParagraphs,
  summarizeParagraphs
} from "../../utils/text.js";

export class InputPreprocessingLayer {
  constructor(private readonly pdfDirectory: string) {}

  async loadKnowledgeCorpora(): Promise<KnowledgeCorpus[]> {
    await mkdir(this.pdfDirectory, { recursive: true });

    const entries = await readdir(this.pdfDirectory, { withFileTypes: true });
    const pdfPaths = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => path.join(this.pdfDirectory, entry.name));

    if (pdfPaths.length === 0) {
      return [];
    }

    return Promise.all(pdfPaths.map((pdfPath) => this.buildCorpusFromPdf(pdfPath)));
  }

  private async buildCorpusFromPdf(pdfPath: string): Promise<KnowledgeCorpus> {
    const sourceTitle = path.basename(pdfPath, path.extname(pdfPath));
    const extractedText = await this.extractPdfText(pdfPath);
    const chapters = this.buildChapters(extractedText, sourceTitle);

    return {
      id: createId("corpus", sourceTitle),
      source: {
        id: createId("source", sourceTitle),
        title: sourceTitle,
        filePath: pdfPath,
        importedAt: new Date().toISOString(),
        textLength: extractedText.length
      },
      chapters,
      createdAt: new Date().toISOString()
    };
  }

  private async extractPdfText(pdfPath: string): Promise<string> {
    const fileName = path.basename(pdfPath);
    const MIN_USEFUL_TEXT_LENGTH = 200;

    try {
      const pdfBuffer = await readFile(pdfPath);
      const pdfParse = (await import("pdf-parse")).default;
      const extracted = await pdfParse(pdfBuffer);
      const text = normalizeWhitespace(extracted.text ?? "");

      if (text.length >= MIN_USEFUL_TEXT_LENGTH) {
        return text;
      }

      if (text.length > 0) {
        console.warn(
          `[input] PDF "${fileName}" yielded only ${text.length} characters — likely a scanned/image-based PDF. ` +
          `Text extraction requires digitally authored PDFs. Using metadata-augmented fallback.`
        );

        const metadataContext = this.buildMetadataFallback(fileName, extracted.numpages, extracted.info, text);
        return metadataContext;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(
        `[input] PDF "${fileName}" could not be parsed: ${message}. Using fallback content.`
      );
      return `Imported PDF "${fileName}" could not be parsed (${message}), but the source is available for downstream testing.`;
    }

    return `Imported PDF "${fileName}" has no extractable text. This is likely a scanned or image-based PDF.`;
  }

  private buildMetadataFallback(
    fileName: string,
    numPages: number | undefined,
    info: Record<string, unknown> | undefined,
    partialText: string
  ): string {
    const lines: string[] = [];
    lines.push(`Source document: ${fileName}`);

    if (numPages && numPages > 0) {
      lines.push(`Number of pages: ${numPages}`);
    }

    if (info) {
      const title = info.Title ?? info.title;
      const author = info.Author ?? info.author;
      const subject = info.Subject ?? info.subject;

      if (typeof title === "string" && title.length > 0) {
        lines.push(`Title: ${title}`);
      }
      if (typeof author === "string" && author.length > 0) {
        lines.push(`Author: ${author}`);
      }
      if (typeof subject === "string" && subject.length > 0) {
        lines.push(`Subject: ${subject}`);
      }
    }

    if (partialText.length > 0) {
      lines.push(`Partial extracted text: ${partialText}`);
    }

    lines.push(
      "Note: Full text extraction was insufficient. Downstream agents should generate content based on available metadata and partial text."
    );

    return lines.join("\n");
  }

  private buildChapters(text: string, sourceTitle: string): KnowledgeChapter[] {
    const paragraphs = splitIntoParagraphs(text);
    const sourceParagraphs =
      paragraphs.length > 0 ? paragraphs : [`${sourceTitle} imported successfully for downstream agents.`];
    const chapterParagraphs = chunkArray(sourceParagraphs, 8);

    return chapterParagraphs.map((paragraphChunk, chapterIndex) => {
      const sectionItems = this.buildSections(paragraphChunk, chapterIndex);
      const chapterTitle = sectionItems[0]?.heading ?? `Chapter ${chapterIndex + 1}`;

      return {
        id: createId("chapter", `${sourceTitle}-${chapterIndex + 1}`),
        title: chapterTitle,
        summary: summarizeParagraphs(paragraphChunk, 2),
        sections: sectionItems,
        memorizeables: this.extractMemorizeables(paragraphChunk)
      };
    });
  }

  private buildSections(paragraphs: string[], chapterIndex: number): KnowledgeSection[] {
    return paragraphs.map((paragraph, sectionIndex) => {
      const heading = this.deriveHeading(paragraph, chapterIndex, sectionIndex);

      return {
        id: createId("section", `${chapterIndex + 1}-${sectionIndex + 1}-${heading}`),
        heading,
        body: paragraph,
        formulas: this.extractFormulas(paragraph),
        diagrams: this.extractDiagramHints(paragraph)
      };
    });
  }

  private deriveHeading(paragraph: string, chapterIndex: number, sectionIndex: number): string {
    const firstSentence = paragraph.split(/(?<=[.!?])\s+/)[0] ?? "";
    const words = normalizeWhitespace(firstSentence)
      .split(/\s+/)
      .slice(0, 8)
      .join(" ")
      .trim();

    if (words.length === 0) {
      return `Chapter ${chapterIndex + 1} Section ${sectionIndex + 1}`;
    }

    return sentenceCase(words);
  }

  private extractFormulas(paragraph: string): string[] {
    const matches = paragraph.match(/[A-Za-z][A-Za-z0-9_ ]{0,24}\s*=\s*[^.;,\n]{1,48}/g) ?? [];
    return this.unique(matches);
  }

  private extractDiagramHints(paragraph: string): string[] {
    const hints: string[] = [];

    if (/diagram|figure|chart|graph/i.test(paragraph)) {
      hints.push("diagram-reference");
    }
    if (/pipeline|process|cycle|flow/i.test(paragraph)) {
      hints.push("process-flow");
    }

    return hints;
  }

  private extractMemorizeables(paragraphs: string[]): string[] {
    const combined = paragraphs.join("\n");
    const formulas = this.extractFormulas(combined);
    const definitions = combined.match(/\b[A-Z][A-Za-z0-9\s-]{3,40}\s+(?:is|means|refers to)\s+[^.]{10,120}/g) ?? [];

    return this.unique([...formulas, ...definitions]).slice(0, 12);
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.map((value) => normalizeWhitespace(value)).filter((value) => value.length > 0))];
  }
}
