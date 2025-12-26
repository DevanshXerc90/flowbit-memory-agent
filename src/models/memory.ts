export type MemoryKind = 'ephemeral' | 'long_term' | 'system';

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  source?: string | undefined;
}

export type LearnedMemoryCategory = 'vendor' | 'correction' | 'resolution' | 'duplicate';

export interface LearnedMemoryContent {
  category: LearnedMemoryCategory;
  vendorName?: string | undefined;
  invoiceNumber?: string | undefined;
  invoiceDate?: string | undefined;
  field?: string | undefined;
  pattern?: string | undefined;
  resolutionStatus?: 'approved' | 'rejected' | undefined;
  confidence: number;
  usageCount: number;
  metadata?: Record<string, unknown> | undefined;
}
