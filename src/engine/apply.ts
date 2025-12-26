import type { Memory, LearnedMemoryContent } from '../models/memory';
import type { NormalizedInvoice, ProposedCorrection } from '../models/pipeline';
import type { RecallSummary, ScoredLearnedMemory } from './recall';

export interface ApplyInputContext {
  invoice: NormalizedInvoice;
  rawText: string;
  recall: RecallSummary;
}

export interface AppliedMemoryRecord {
  field: string;
  memoryId: string;
  confidence: number;
  applied: boolean;
  reason: string;
}

export interface ApplyContext {
  input: ApplyInputContext;
  memories: Memory[];
  normalizedInvoice: NormalizedInvoice;
  proposedCorrections: ProposedCorrection[];
  appliedMemories: AppliedMemoryRecord[];
  aggregateConfidence: number;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.8;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.7;

function registerCorrection(
  list: ProposedCorrection[],
  field: string,
  proposedValue: unknown,
  reason: string,
  confidence: number,
  memory?: ScoredLearnedMemory,
  applied = false,
): ProposedCorrection {
  const correction: ProposedCorrection = {
    field,
    proposedValue,
    reason,
    confidence,
    ...(memory ? { memoryId: memory.memory.id } : {}),
    applied,
  };
  list.push(correction);
  return correction;
}

function maybeApplyFieldFromMemory<TField>(
  normalizedInvoice: NormalizedInvoice,
  field: keyof NormalizedInvoice,
  currentValue: TField | undefined,
  memories: ScoredLearnedMemory[],
  proposedCorrections: ProposedCorrection[],
  appliedMemories: AppliedMemoryRecord[],
): { value: TField | undefined; aggregateConfidenceDelta: number } {
  if (currentValue !== undefined && currentValue !== null) {
    return { value: currentValue, aggregateConfidenceDelta: 0 };
  }

  const candidate = memories.find((m) => m.content.field === field);
  if (!candidate) {
    return { value: currentValue, aggregateConfidenceDelta: 0 };
  }

  const confidence = candidate.content.confidence;
  const reason = `Field ${String(
    field,
  )} inferred from learned vendor memory for ${candidate.content.vendorName ?? 'unknown vendor'}.`;

  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    const proposedValue = candidate.content.metadata?.proposedValue as TField | undefined;
    if (proposedValue !== undefined) {
      registerCorrection(
        proposedCorrections,
        String(field),
        proposedValue,
        reason,
        confidence,
        candidate,
        true,
      );
      appliedMemories.push({
        field: String(field),
        memoryId: candidate.memory.id,
        confidence,
        applied: true,
        reason,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      (normalizedInvoice as any)[field] = proposedValue;
      return { value: proposedValue, aggregateConfidenceDelta: confidence };
    }
  } else if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
    const proposedValue = candidate.content.metadata?.proposedValue as TField | undefined;
    if (proposedValue !== undefined) {
      registerCorrection(
        proposedCorrections,
        String(field),
        proposedValue,
        reason,
        confidence,
        candidate,
        false,
      );
      appliedMemories.push({
        field: String(field),
        memoryId: candidate.memory.id,
        confidence,
        applied: false,
        reason,
      });
      return { value: currentValue, aggregateConfidenceDelta: confidence };
    }
  }

  return { value: currentValue, aggregateConfidenceDelta: 0 };
}

function detectVatIncluded(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return (
    text.includes('mwst. inkl') ||
    text.includes('mwst inkl') ||
    text.includes('inkl. mwst') ||
    text.includes('inkl mwst') ||
    text.includes('prices incl. vat') ||
    text.includes('price includes vat')
  );
}

function normalizeCurrencyFromText(rawText: string): string | undefined {
  const text = rawText.toUpperCase();
  if (text.includes(' EUR') || text.includes('€')) return 'EUR';
  if (text.includes(' USD') || text.includes('$')) return 'USD';
  if (text.includes(' CHF')) return 'CHF';
  if (text.includes(' GBP') || text.includes('£')) return 'GBP';
  return undefined;
}

function detectSkontoTerms(rawText: string): string | undefined {
  const text = rawText.toLowerCase();
  const skontoIndex = text.indexOf('skonto');
  if (skontoIndex === -1) return undefined;

  const window = text.slice(Math.max(0, skontoIndex - 40), skontoIndex + 80);
  const percentMatch = window.match(/(\d{1,2})%/);
  if (percentMatch) {
    const percentage = percentMatch[1];
    return `${percentage}% skonto detected`;
  }
  return 'Skonto terms detected';
}

export function applyMemoriesToContext(input: ApplyInputContext): ApplyContext {
  const normalizedInvoice: NormalizedInvoice = { ...input.invoice };
  const proposedCorrections: ProposedCorrection[] = [];
  const appliedMemories: AppliedMemoryRecord[] = [];
  let aggregateConfidence = 0;

  const vendorServiceMemories = input.recall.vendorMemories.filter(
    (m) => m.content.field === 'serviceDate',
  );

  const serviceResult = maybeApplyFieldFromMemory<NormalizedInvoice['serviceDate']>(
    normalizedInvoice,
    'serviceDate',
    normalizedInvoice.serviceDate,
    vendorServiceMemories,
    proposedCorrections,
    appliedMemories,
  );
  aggregateConfidence = Math.max(aggregateConfidence, serviceResult.aggregateConfidenceDelta);

  if (detectVatIncluded(input.rawText)) {
    const vatMem = input.recall.vendorMemories.find((m) => m.content.field === 'vatIncluded');
    const baseConfidence = vatMem?.content.confidence ?? 0.75;

    const reason =
      'VAT inclusion inferred from raw text phrases such as "MwSt. inkl." or "Prices incl. VAT".';

    if (baseConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
      const gross = normalizedInvoice.totalAmount;
      const net = gross / 1.19;
      const taxAmount = gross - net;

      registerCorrection(
        proposedCorrections,
        'taxAmount',
        Number(taxAmount.toFixed(2)),
        reason,
        baseConfidence,
        vatMem,
        true,
      );
      (normalizedInvoice as any).taxAmount = Number(taxAmount.toFixed(2));
      (normalizedInvoice as any).grossAmount = Number(gross.toFixed(2));

      appliedMemories.push({
        field: 'taxAmount',
        memoryId: vatMem?.memory.id ?? 'synthetic-vat-rule',
        confidence: baseConfidence,
        applied: true,
        reason,
      });
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    } else if (baseConfidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      const gross = normalizedInvoice.totalAmount;
      const net = gross / 1.19;
      const taxAmount = gross - net;

      registerCorrection(
        proposedCorrections,
        'taxAmount',
        Number(taxAmount.toFixed(2)),
        reason,
        baseConfidence,
        vatMem,
        false,
      );
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    }
  }

  if (!normalizedInvoice.currency) {
    const currencyFromText = normalizeCurrencyFromText(input.rawText);
    const currencyMem = input.recall.vendorMemories.find((m) => m.content.field === 'currency');
    const baseConfidence = currencyMem?.content.confidence ?? 0.7;

    const candidateCurrency = currencyFromText ?? (currencyMem?.content.metadata?.proposedValue as
      | string
      | undefined);

    if (candidateCurrency) {
      const reason = 'Currency inferred from raw text and vendor-specific memory.';
      if (baseConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
        registerCorrection(
          proposedCorrections,
          'currency',
          candidateCurrency,
          reason,
          baseConfidence,
          currencyMem,
          true,
        );
        (normalizedInvoice as any).currency = candidateCurrency;
        if (currencyMem) {
          appliedMemories.push({
            field: 'currency',
            memoryId: currencyMem.memory.id,
            confidence: baseConfidence,
            applied: true,
            reason,
          });
        }
        aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
      } else if (baseConfidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
        registerCorrection(
          proposedCorrections,
          'currency',
          candidateCurrency,
          reason,
          baseConfidence,
          currencyMem,
          false,
        );
        aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
      }
    }
  }

  for (const item of normalizedInvoice.lineItems) {
    const description = item.description.toLowerCase();
    const looksLikeFreight =
      description.includes('seefracht') ||
      description.includes('shipping') ||
      description.includes('fracht') ||
      description.includes('freight');

    if (!looksLikeFreight) continue;

    const freightMem = input.recall.vendorMemories.find((m) => m.content.field === 'freightSku');
    const baseConfidence = freightMem?.content.confidence ?? 0.75;
    const proposedSku =
      (freightMem?.content.metadata?.proposedValue as string | undefined) ?? 'FREIGHT';

    const reason = 'Freight-related description mapped to freight SKU based on learned vendor memory.';

    if (baseConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
      registerCorrection(
        proposedCorrections,
        `lineItem:${item.id}:sku`,
        proposedSku,
        reason,
        baseConfidence,
        freightMem,
        true,
      );
      (item as any).sku = proposedSku;
      appliedMemories.push({
        field: `lineItem:${item.id}:sku`,
        memoryId: freightMem?.memory.id ?? 'synthetic-freight-rule',
        confidence: baseConfidence,
        applied: true,
        reason,
      });
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    } else if (baseConfidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      registerCorrection(
        proposedCorrections,
        `lineItem:${item.id}:sku`,
        proposedSku,
        reason,
        baseConfidence,
        freightMem,
        false,
      );
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    }
  }

  const skonto = detectSkontoTerms(input.rawText);
  if (skonto) {
    const skontoMem = input.recall.vendorMemories.find((m) => m.content.field === 'skonto');
    const baseConfidence = skontoMem?.content.confidence ?? 0.75;
    const reason = 'Skonto (cash discount) terms detected in raw text.';

    if (baseConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
      registerCorrection(
        proposedCorrections,
        'paymentTermsNormalized',
        skonto,
        reason,
        baseConfidence,
        skontoMem,
        true,
      );
      (normalizedInvoice as any).paymentTermsNormalized = skonto;
      appliedMemories.push({
        field: 'paymentTermsNormalized',
        memoryId: skontoMem?.memory.id ?? 'synthetic-skonto-rule',
        confidence: baseConfidence,
        applied: true,
        reason,
      });
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    } else if (baseConfidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      registerCorrection(
        proposedCorrections,
        'paymentTermsNormalized',
        skonto,
        reason,
        baseConfidence,
        skontoMem,
        false,
      );
      aggregateConfidence = Math.max(aggregateConfidence, baseConfidence);
    }
  }

  return {
    input,
    memories: input.recall.allMemories.map((m) => m.memory),
    normalizedInvoice,
    proposedCorrections,
    appliedMemories,
    aggregateConfidence,
  };
}
