import type { Invoice } from './invoice';
import type { AuditEventType } from './audit';

export interface NormalizedInvoice extends Invoice {
  vendorName: string;
  invoiceNumber: string;
  rawText?: string;
  serviceDate?: Date | undefined;
  taxAmount?: number;
  grossAmount?: number;
  paymentTermsNormalized?: string;
}

export interface ProposedCorrection {
  field: string;
  proposedValue: unknown;
  reason: string;
  confidence: number;
  memoryId?: string | undefined;
  applied: boolean;
}

export interface MemoryUpdate {
  memoryId: string;
  previousConfidence: number;
  newConfidence: number;
  usageCount: number;
  action: 'reinforce' | 'decay' | 'create';
}

export interface AuditTrailEntry {
  step: AuditEventType;
  timestamp: Date;
  details: Record<string, unknown>;
}

export interface EngineOutputContract {
  normalizedInvoice: NormalizedInvoice;
  proposedCorrections: ProposedCorrection[];
  requiresHumanReview: boolean;
  reasoning: string;
  confidenceScore: number;
  memoryUpdates: MemoryUpdate[];
  auditTrail: AuditTrailEntry[];
}
