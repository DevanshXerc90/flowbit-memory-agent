import type { Memory, LearnedMemoryContent, LearnedMemoryCategory } from '../models/memory';
import type { MemoryRepository } from '../memory/memoryRepository';

export interface RecallQuery {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: Date;
  rawText?: string;
  limit?: number;
}

export interface ScoredLearnedMemory {
  memory: Memory;
  content: LearnedMemoryContent;
  score: number;
}

export interface RecallSummary {
  vendorMemories: ScoredLearnedMemory[];
  correctionMemories: ScoredLearnedMemory[];
  resolutionMemories: ScoredLearnedMemory[];
  duplicateDetected: boolean;
  duplicateScore: number;
  duplicateReason?: string | undefined;
  allMemories: ScoredLearnedMemory[];
}

function parseLearnedContent(memory: Memory): LearnedMemoryContent | undefined {
  try {
    const parsed = JSON.parse(memory.content) as Partial<LearnedMemoryContent>;
    if (typeof parsed.confidence === 'number' && typeof parsed.usageCount === 'number' && parsed.category) {
      return parsed as LearnedMemoryContent;
    }
  } catch {
    // Non-JSON or incompatible content is ignored for learned memory logic.
  }
  return undefined;
}

function scoreMemory(
  content: LearnedMemoryContent,
  vendorName: string,
  invoiceNumber: string,
  invoiceDate: Date,
): number {
  let score = content.confidence;

  if (content.vendorName && content.vendorName.toLowerCase() === vendorName.toLowerCase()) {
    score += 0.05;
  }

  if (content.invoiceNumber && content.invoiceNumber === invoiceNumber) {
    score += 0.05;
  }

  if (content.invoiceDate) {
    const storedDate = new Date(content.invoiceDate);
    const diffMs = Math.abs(storedDate.getTime() - invoiceDate.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= 2) {
      score += 0.05;
    }
  }

  return Math.min(score, 1);
}

function filterByCategory(
  memories: ScoredLearnedMemory[],
  category: LearnedMemoryCategory,
): ScoredLearnedMemory[] {
  return memories
    .filter((m) => m.content.category === category)
    .sort((a, b) => b.score - a.score);
}

export async function recallMemories(
  repository: MemoryRepository,
  query: RecallQuery,
): Promise<RecallSummary> {
  const limit = query.limit ?? 50;
  const byVendor = repository.searchMemories(query.vendorName, limit);
  const byInvoiceNumber = repository.searchMemories(query.invoiceNumber, limit);

  const combined = new Map<string, Memory>();
  for (const m of [...byVendor, ...byInvoiceNumber]) {
    combined.set(m.id, m);
  }

  const scored: ScoredLearnedMemory[] = [];
  for (const memory of combined.values()) {
    const content = parseLearnedContent(memory);
    if (!content) continue;
    const score = scoreMemory(content, query.vendorName, query.invoiceNumber, query.invoiceDate);
    scored.push({ memory, content, score });
  }

  const vendorMemories = filterByCategory(scored, 'vendor');
  const correctionMemories = filterByCategory(scored, 'correction');
  const resolutionMemories = filterByCategory(scored, 'resolution');

  let duplicateDetected = false;
  let duplicateScore = 0;
  let duplicateReason: string | undefined;

  const duplicateCandidates = resolutionMemories.filter((m) =>
    m.content.vendorName?.toLowerCase() === query.vendorName.toLowerCase() &&
    m.content.invoiceNumber === query.invoiceNumber &&
    m.content.invoiceDate,
  );

  if (duplicateCandidates.length > 0) {
    const best = duplicateCandidates[0]!;
    duplicateDetected = true;
    duplicateScore = best.score;
    duplicateReason =
      'Potential duplicate invoice based on vendor, invoice number and close invoice date.';
  }

  return {
    vendorMemories,
    correctionMemories,
    resolutionMemories,
    duplicateDetected,
    duplicateScore,
    ...(duplicateReason !== undefined ? { duplicateReason } : {}),
    allMemories: scored,
  };
}
