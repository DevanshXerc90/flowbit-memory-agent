import { v4 as uuidv4 } from 'uuid';
import type { Memory, LearnedMemoryContent, LearnedMemoryCategory } from '../models/memory';
import type { AuditEvent } from '../models/audit';
import type { MemoryRepository } from '../memory/memoryRepository';

export interface LearningSignal {
  event: AuditEvent;
  feedbackScore?: number;
}

export function learnFromSignal(
  repository: MemoryRepository,
  signal: LearningSignal,
): Memory | undefined {
  const memoryId = signal.event.details.memoryId as string | undefined;
  const approved = signal.event.details.approved as boolean | undefined;
  const field = signal.event.details.field as string | undefined;
  const vendorName = signal.event.details.vendorName as string | undefined;
  const invoiceNumber = signal.event.details.invoiceNumber as string | undefined;
  const invoiceDate = signal.event.details.invoiceDate as string | undefined;
  const resolutionStatus = signal.event.details.resolutionStatus as
    | 'approved'
    | 'rejected'
    | undefined;
  const isDuplicate = signal.event.details.isDuplicate as boolean | undefined;

  if (!memoryId || approved === undefined) {
    return undefined;
  }

  const now = new Date();
  const existing = repository.getMemoryById(memoryId);

  if (!existing) {
    const initialConfidence = approved ? 0.8 : 0.5;

    let category: LearnedMemoryCategory = 'correction';
    let storedField = field;
    if (field === 'taxAmount' || field === 'grossAmount') {
      category = 'vendor';
      storedField = 'vatIncluded';
    }
    if (field && field.startsWith('lineItem:') && field.endsWith(':sku')) {
      category = 'vendor';
      storedField = 'freightSku';
    }

    const baseMetadata: Record<string, unknown> = {
      field,
      value: signal.event.details.value,
    };

    if (storedField === 'freightSku') {
      baseMetadata.proposedValue = signal.event.details.value;
    }

    const content: Partial<LearnedMemoryContent> = {
      category,
      confidence: initialConfidence,
      usageCount: 1,
      metadata: baseMetadata,
    };

    if (storedField !== undefined) {
      content.field = storedField;
    }

    if (vendorName !== undefined) {
      content.vendorName = vendorName;
    }
    if (invoiceNumber !== undefined) {
      content.invoiceNumber = invoiceNumber;
    }
    if (invoiceDate !== undefined) {
      content.invoiceDate = invoiceDate;
    }

    const memory: Memory = {
      id: memoryId ?? uuidv4(),
      kind: 'long_term',
      content: JSON.stringify(content),
      createdAt: now,
      updatedAt: now,
      source: 'learn',
    };

    repository.saveMemory(memory);
    return memory;
  }

  let parsed: Partial<LearnedMemoryContent>;
  try {
    parsed = JSON.parse(existing.content) as Partial<LearnedMemoryContent>;
  } catch {
    parsed = {};
  }

  const currentConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
  const currentUsage = typeof parsed.usageCount === 'number' ? parsed.usageCount : 0;

  let newConfidence = currentConfidence;
  if (approved) {
    const delta = 0.05 * (signal.feedbackScore ?? 1);
    newConfidence = Math.min(currentConfidence + delta, 0.95);
  } else {
    const delta = 0.05 * (signal.feedbackScore ?? 1);
    newConfidence = Math.max(currentConfidence - delta, 0);
  }

  let category: LearnedMemoryCategory = (parsed.category as LearnedMemoryCategory) ?? 'correction';
  let storedField = parsed.field ?? field;
  if (field === 'taxAmount' || field === 'grossAmount') {
    category = 'vendor';
    storedField = 'vatIncluded';
  }
  if (field && field.startsWith('lineItem:') && field.endsWith(':sku')) {
    category = 'vendor';
    storedField = 'freightSku';
  }

  const metadata: Record<string, unknown> = {
    ...(parsed.metadata ?? {}),
    field,
    value: signal.event.details.value,
  };

  if (storedField === 'freightSku') {
    metadata.proposedValue = signal.event.details.value;
  }

  const updated: Partial<LearnedMemoryContent> = {
    category,
    confidence: newConfidence,
    usageCount: currentUsage + 1,
    metadata,
  };

  if (storedField !== undefined) {
    updated.field = storedField;
  }

  const nextVendorName = parsed.vendorName ?? vendorName;
  const nextInvoiceNumber = parsed.invoiceNumber ?? invoiceNumber;
  const nextInvoiceDate = parsed.invoiceDate ?? invoiceDate;

  if (nextVendorName !== undefined) {
    updated.vendorName = nextVendorName;
  }
  if (nextInvoiceNumber !== undefined) {
    updated.invoiceNumber = nextInvoiceNumber;
  }
  if (nextInvoiceDate !== undefined) {
    updated.invoiceDate = nextInvoiceDate;
  }

  const updatedMemory: Memory = {
    ...existing,
    content: JSON.stringify(updated),
    updatedAt: now,
  };

  repository.saveMemory(updatedMemory);
  if (resolutionStatus || isDuplicate) {
    const resolutionContent: LearnedMemoryContent = {
      category: 'resolution',
      vendorName,
      invoiceNumber,
      invoiceDate,
      resolutionStatus: resolutionStatus ?? (isDuplicate ? 'approved' : undefined),
      confidence: approved ? 0.8 : 0.5,
      usageCount: 1,
      metadata: {
        isDuplicate: isDuplicate === true,
      },
    };

    const resolutionMemory: Memory = {
      id: uuidv4(),
      kind: 'long_term',
      content: JSON.stringify(resolutionContent),
      createdAt: now,
      updatedAt: now,
      source: 'learn:resolution',
    };

    repository.saveMemory(resolutionMemory);
  }

  return updatedMemory;
}
