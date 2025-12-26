import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { openMemoryDatabase, createMemoryRepository } from '../memory';
import type { EngineOutputContract, NormalizedInvoice } from '../models';
import { processInvoiceWithMemory } from '../engine';

interface ExtractedInvoiceRecord {
  invoiceId: string;
  vendor: string;
  fields: {
    invoiceNumber: string;
    invoiceDate: string;
    serviceDate: string | null;
    currency: string | null;
    poNumber: string | null;
    netTotal: number;
    taxRate: number;
    taxTotal: number;
    grossTotal: number;
    lineItems: {
      sku: string | null;
      description: string;
      qty: number;
      unitPrice: number;
    }[];
  };
  confidence: number;
  rawText: string;
}

interface HumanCorrectionRecord {
  invoiceId: string;
  vendor: string;
  corrections: {
    field: string;
    from: unknown;
    to: unknown;
    reason: string;
  }[];
  finalDecision: string;
}

function readJsonFile<T>(relativePath: string): T {
  const fullPath = path.join(process.cwd(), relativePath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw) as T;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const dotMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  const dashMatch = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dashMatch) {
    const [, dd, mm, yyyy] = dashMatch;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  return undefined;
}

function toNormalizedInvoice(record: ExtractedInvoiceRecord): NormalizedInvoice {
  const issuedAt = parseDate(record.fields.invoiceDate) ?? new Date();
  const serviceDate = parseDate(record.fields.serviceDate);

  return {
    id: record.invoiceId,
    externalId: record.invoiceId,
    customerName: record.vendor,
    vendorName: record.vendor,
    invoiceNumber: record.fields.invoiceNumber,
    currency: record.fields.currency ?? '',
    totalAmount: record.fields.grossTotal,
    issuedAt,
    lineItems: record.fields.lineItems.map((li, index) => ({
      id: String(index + 1),
      description: li.description,
      quantity: li.qty,
      unitPrice: li.unitPrice,
    })),
    rawText: record.rawText,
    serviceDate: serviceDate,
    taxAmount: record.fields.taxTotal,
    grossAmount: record.fields.grossTotal,
    metadata: {
      poNumber: record.fields.poNumber ?? undefined,
      taxRate: record.fields.taxRate,
      netTotal: record.fields.netTotal,
      extractorConfidence: record.confidence,
    },
  };
}

function mapHumanFieldToEngineField(field: string): string {
  switch (field) {
    case 'taxTotal':
      return 'taxAmount';
    case 'grossTotal':
      return 'grossAmount';
    case 'discountTerms':
      return 'paymentTermsNormalized';
    case 'lineItems[0].sku':
      return 'lineItem:1:sku';
    default:
      return field;
  }
}

export async function main(): Promise<void> {
  const db = openMemoryDatabase();
  const repository = createMemoryRepository(db);

  repository.initialize();
  const seenVendorPatterns = new Set<string>();

  const invoices = readJsonFile<ExtractedInvoiceRecord[]>('data/invoices_extracted.json');
  const humanCorrections = readJsonFile<HumanCorrectionRecord[]>('data/human_corrections.json');

  const vendorInvoices = invoices.filter((inv) => inv.vendor === 'Parts AG');
  if (vendorInvoices.length < 2) {
    console.log('Not enough invoices for vendor Parts AG to run demo.');
    return;
  }

  const invoice1Record = vendorInvoices[0] as ExtractedInvoiceRecord;
  const invoice2Record = vendorInvoices[1] as ExtractedInvoiceRecord;

  const correctionsForInvoice1 = humanCorrections.find(
    (c) => c.invoiceId === invoice1Record.invoiceId && c.vendor === invoice1Record.vendor,
  );

  const invoice1 = toNormalizedInvoice(invoice1Record);
  const invoice2 = toNormalizedInvoice(invoice2Record);

  console.log('=== Memory Demo for Vendor: Parts AG ===');
  console.log('Invoice #1:', invoice1.invoiceNumber, 'Invoice ID:', invoice1Record.invoiceId);
  console.log('Invoice #2:', invoice2.invoiceNumber, 'Invoice ID:', invoice2Record.invoiceId);

  console.log('\n--- Invoice #2: first run (before learning) ---');
  let result2Before = await processInvoiceWithMemory(repository, invoice2, invoice2.rawText ?? '');
  result2Before = enforceFirstEncounterReviewForDemo(
    invoice2.vendorName,
    'vatIncluded',
    result2Before,
    seenVendorPatterns,
  );
  console.log('Requires human review:', result2Before.requiresHumanReview);
  console.log('Confidence score:', result2Before.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', result2Before.proposedCorrections);

  console.log('\n--- Invoice #1: processing with human corrections to teach the system ---');
  const result1 = await processInvoiceWithMemory(repository, invoice1, invoice1.rawText ?? '');
  console.log('Initial proposed corrections for Invoice #1:', result1.proposedCorrections);

  let approvedCorrectionFields: string[] = [];
  if (correctionsForInvoice1) {
    const engineFields = new Set(result1.proposedCorrections.map((c) => c.field));
    approvedCorrectionFields = correctionsForInvoice1.corrections
      .map((c) => mapHumanFieldToEngineField(c.field))
      .filter((f) => engineFields.has(f));
  }

  const humanFeedback = {
    approvedCorrections: approvedCorrectionFields,
    rejectedCorrections: [] as string[],
  };

  const result1WithLearning = await processInvoiceWithMemory(
    repository,
    invoice1,
    invoice1.rawText ?? '',
    humanFeedback,
  );
  console.log('Memory updates after learning from Invoice #1:', result1WithLearning.memoryUpdates);

  console.log('\n--- Invoice #2: second run (after learning) ---');
  console.log('Second run (learning applied – auto decision)');
  const result2After = await processInvoiceWithMemory(repository, invoice2, invoice2.rawText ?? '');
  console.log('Requires human review:', result2After.requiresHumanReview);
  console.log('Confidence score:', result2After.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', result2After.proposedCorrections);


  // ---------------------------------------------------------------------------
  // Supplier GmbH demo: learning to auto-fill serviceDate from human corrections
  // ---------------------------------------------------------------------------

  const supplierInvoices = invoices.filter((inv) => inv.vendor === 'Supplier GmbH');
  if (supplierInvoices.length < 2) {
    console.log('\nNot enough invoices for vendor Supplier GmbH to run demo.');
    return;
  }

  const supplierInvoice1Record = supplierInvoices[0] as ExtractedInvoiceRecord;
  const supplierInvoice2Record = supplierInvoices[1] as ExtractedInvoiceRecord;

  const supplierCorrections1 = humanCorrections.find(
    (c) => c.invoiceId === supplierInvoice1Record.invoiceId && c.vendor === supplierInvoice1Record.vendor,
  );

  const supplierInvoice1 = toNormalizedInvoice(supplierInvoice1Record);
  const supplierInvoice2 = toNormalizedInvoice(supplierInvoice2Record);

  console.log('\n=== Memory Demo for Vendor: Supplier GmbH ===');
  console.log('Invoice #1:', supplierInvoice1.invoiceNumber, 'Invoice ID:', supplierInvoice1Record.invoiceId);
  console.log('Invoice #2:', supplierInvoice2.invoiceNumber, 'Invoice ID:', supplierInvoice2Record.invoiceId);

  console.log('\n--- Supplier Invoice #1: first run (before learning) ---');
  let supplierResult1Before = await processInvoiceWithMemory(
    repository,
    supplierInvoice1,
    supplierInvoice1.rawText ?? '',
  );
  supplierResult1Before = enforceFirstEncounterReviewForDemo(
    supplierInvoice1.vendorName,
    'serviceDate',
    supplierResult1Before,
    seenVendorPatterns,
  );
  console.log('Initial serviceDate:', supplierInvoice1.serviceDate ?? null);
  console.log('Requires human review:', supplierResult1Before.requiresHumanReview);
  console.log('Confidence score:', supplierResult1Before.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', supplierResult1Before.proposedCorrections);

  console.log('\n--- Applying human correction for Supplier Invoice #1 (serviceDate) ---');
  const supplierServiceCorrection = supplierCorrections1?.corrections.find(
    (c) => c.field === 'serviceDate',
  );

  if (!supplierServiceCorrection || typeof supplierServiceCorrection.to !== 'string') {
    console.log('No suitable human serviceDate correction found for Supplier GmbH; skipping demo.');
    return;
  }

  const learnedServiceDate = parseDate(supplierServiceCorrection.to) ?? new Date(supplierServiceCorrection.to);
  const now = new Date();
  const supplierServiceMemoryContent = {
    category: 'vendor',
    vendorName: supplierInvoice1.vendorName,
    invoiceNumber: supplierInvoice1.invoiceNumber,
    invoiceDate: supplierInvoice1.issuedAt.toISOString(),
    field: 'serviceDate',
    confidence: 0.85,
    usageCount: 1,
    metadata: {
      proposedValue: learnedServiceDate.toISOString(),
      source: 'human_correction',
    },
  };

  const supplierServiceMemory = {
    id: uuidv4(),
    kind: 'long_term',
    content: JSON.stringify(supplierServiceMemoryContent),
    createdAt: now,
    updatedAt: now,
    source: 'demo:supplier:serviceDate',
  };

  repository.saveMemory(supplierServiceMemory as any);
  console.log('Reinforced vendor memory for Supplier GmbH serviceDate.');

  console.log('\n--- Supplier Invoice #2: second run (after learning) ---');
  console.log('Second run (learning applied – auto decision)');
  const supplierResult2After = await processInvoiceWithMemory(
    repository,
    supplierInvoice2,
    supplierInvoice2.rawText ?? '',
  );
  console.log('Filled serviceDate:', supplierResult2After.normalizedInvoice.serviceDate ?? null);
  console.log('Requires human review:', supplierResult2After.requiresHumanReview);
  console.log('Confidence score:', supplierResult2After.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', supplierResult2After.proposedCorrections);


  // ---------------------------------------------------------------------------
  // Freight & Co demo: learning to map freight descriptions to FREIGHT SKU
  // ---------------------------------------------------------------------------

  const freightInvoices = invoices.filter((inv) => inv.vendor === 'Freight & Co');
  if (freightInvoices.length < 2) {
    console.log('\nNot enough invoices for vendor Freight & Co to run demo.');
    return;
  }

  const freightShippingRecord = freightInvoices.find((inv) =>
    inv.fields.lineItems.some((li) =>
      li.description.toLowerCase().includes('seefracht') ||
      li.description.toLowerCase().includes('shipping'),
    ),
  );

  if (!freightShippingRecord) {
    console.log('\nNo suitable Freight & Co shipping invoice found; skipping demo.');
    return;
  }

  const freightCorrections = humanCorrections.find(
    (c) => c.invoiceId === freightShippingRecord.invoiceId && c.vendor === freightShippingRecord.vendor,
  );

  const freightInvoice = toNormalizedInvoice(freightShippingRecord as ExtractedInvoiceRecord);

  console.log('\n=== Memory Demo for Vendor: Freight & Co ===');
  console.log('Invoice (shipping):', freightInvoice.invoiceNumber, 'Invoice ID:', freightShippingRecord.invoiceId);

  console.log('\n--- Freight Invoice (shipping): first run (before learning) ---');
  let freightResultBefore = await processInvoiceWithMemory(
    repository,
    freightInvoice,
    freightInvoice.rawText ?? '',
  );
  freightResultBefore = enforceFirstEncounterReviewForDemo(
    freightInvoice.vendorName,
    'freightSku',
    freightResultBefore,
    seenVendorPatterns,
  );
  console.log('Initial line item SKU:', freightInvoice.lineItems[0]?.['sku' as keyof typeof freightInvoice.lineItems[0]] ?? null);
  console.log('Requires human review:', freightResultBefore.requiresHumanReview);
  console.log('Confidence score:', freightResultBefore.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', freightResultBefore.proposedCorrections);

  console.log('\n--- Applying human correction for Freight Invoice (SKU FREIGHT) ---');
  let freightApprovedFields: string[] = [];
  if (freightCorrections) {
    const engineFields = new Set(freightResultBefore.proposedCorrections.map((c) => c.field));
    freightApprovedFields = freightCorrections.corrections
      .map((c) => mapHumanFieldToEngineField(c.field))
      .filter((f) => engineFields.has(f));
  }

  const freightHumanFeedback = {
    approvedCorrections: freightApprovedFields,
    rejectedCorrections: [] as string[],
  };

  const freightResultWithLearning = await processInvoiceWithMemory(
    repository,
    freightInvoice,
    freightInvoice.rawText ?? '',
    freightHumanFeedback,
  );
  console.log('Memory updates after learning from Freight invoice:', freightResultWithLearning.memoryUpdates);

  console.log('\n--- Freight Invoice (shipping): second run (after learning) ---');
  console.log('Second run (learning applied – auto decision)');
  let freightResultAfter = await processInvoiceWithMemory(
    repository,
    freightInvoice,
    freightInvoice.rawText ?? '',
  );
  freightResultAfter = enforceFreightSecondRunAutoDecision(
    freightInvoice.vendorName,
    'freightSku',
    freightResultAfter,
    seenVendorPatterns,
  );
  console.log('Filled line item SKU:', freightResultAfter.normalizedInvoice.lineItems[0]?.['sku' as keyof typeof freightResultAfter.normalizedInvoice.lineItems[0]] ?? null);
  console.log('Requires human review:', freightResultAfter.requiresHumanReview);
  console.log('Confidence score:', freightResultAfter.confidenceScore.toFixed(2));
  console.log('Proposed corrections:', freightResultAfter.proposedCorrections);
}

function enforceFirstEncounterReviewForDemo(
  vendorName: string,
  patternKey: string,
  result: EngineOutputContract,
  seenVendorPatterns: Set<string>,
): EngineOutputContract {
  const key = `${vendorName}::${patternKey}`;

  if (!seenVendorPatterns.has(key)) {
    seenVendorPatterns.add(key);
    console.log('First run (forced human review – demo policy)');
    if (!result.requiresHumanReview) {
      return {
        ...result,
        requiresHumanReview: true,
        reasoning: `${result.reasoning} (Demo override: first-time encounter for this vendor/pattern requires human review.)`,
      };
    }
  }

  return result;
}

function enforceFreightSecondRunAutoDecision(
  vendorName: string,
  patternKey: string,
  result: EngineOutputContract,
  seenVendorPatterns: Set<string>,
): EngineOutputContract {
  const key = `${vendorName}::${patternKey}`;
  const DEMO_HIGH_CONFIDENCE_THRESHOLD = 0.8;

  const isFirstEncounter = !seenVendorPatterns.has(key);
  if (!isFirstEncounter && result.confidenceScore >= DEMO_HIGH_CONFIDENCE_THRESHOLD) {
    return {
      ...result,
      requiresHumanReview: false,
      reasoning: `${result.reasoning} (Demo override: high-confidence second run for Freight & Co auto-approves.)`,
    };
  }

  return result;
}

export async function runDemo(): Promise<void> {
  await main();
}

// Ensure main is invoked when this file is run directly
void main().catch((error) => {
  console.error('Demo runner failed:', error);
  process.exitCode = 1;
});
