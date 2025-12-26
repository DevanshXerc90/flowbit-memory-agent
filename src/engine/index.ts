export * from './recall';
export * from './apply';
export * from './decide';
export * from './learn';

import { v4 as uuidv4 } from 'uuid';
import type { MemoryRepository } from '../memory/memoryRepository';
import type { NormalizedInvoice, EngineOutputContract, AuditTrailEntry, MemoryUpdate } from '../models';
import type { RecallQuery } from './recall';
import { recallMemories } from './recall';
import { applyMemoriesToContext } from './apply';
import { decideNextAction } from './decide';
import { learnFromSignal } from './learn';

export interface HumanFeedbackInput {
	approvedCorrections: string[];
	rejectedCorrections: string[];
}

export async function processInvoiceWithMemory(
	repository: MemoryRepository,
	invoice: NormalizedInvoice,
	rawText: string,
	humanFeedback?: HumanFeedbackInput,
): Promise<EngineOutputContract> {
	const auditTrail: AuditTrailEntry[] = [];

	const recallQuery: RecallQuery = {
		vendorName: invoice.vendorName,
		invoiceNumber: invoice.invoiceNumber,
		invoiceDate: invoice.issuedAt,
		rawText,
	};

	const recallResult = await recallMemories(repository, recallQuery);
	auditTrail.push({
		step: 'recall',
		timestamp: new Date(),
		details: {
			duplicateDetected: recallResult.duplicateDetected,
			duplicateScore: recallResult.duplicateScore,
			vendorMemories: recallResult.vendorMemories.length,
			correctionMemories: recallResult.correctionMemories.length,
			resolutionMemories: recallResult.resolutionMemories.length,
		},
	});

	const applyResult = applyMemoriesToContext({
		invoice,
		rawText,
		recall: recallResult,
	});

	auditTrail.push({
		step: 'apply',
		timestamp: new Date(),
		details: {
			appliedMemories: applyResult.appliedMemories.map((m) => ({
				field: m.field,
				memoryId: m.memoryId,
				confidence: m.confidence,
				applied: m.applied,
			})),
			proposedCorrections: applyResult.proposedCorrections,
		},
	});

	const decision = decideNextAction(applyResult);

	auditTrail.push({
		step: 'decide',
		timestamp: new Date(),
		details: {
			requiresHumanReview: decision.requiresHumanReview,
			confidenceScore: decision.confidenceScore,
			reasoning: decision.reasoning,
			duplicateDetected: recallResult.duplicateDetected,
		},
	});

	const memoryUpdates: MemoryUpdate[] = [];

	if (humanFeedback) {
		for (const correction of applyResult.proposedCorrections) {
			const approved = humanFeedback.approvedCorrections.includes(correction.field);
			const rejected = humanFeedback.rejectedCorrections.includes(correction.field);
			if (!approved && !rejected) continue;

			const signal = {
				event: {
					id: uuidv4(),
					type: 'learn',
					timestamp: new Date(),
						details: {
							memoryId: correction.memoryId ?? uuidv4(),
							approved,
							field: correction.field,
							value: correction.proposedValue,
							vendorName: invoice.vendorName,
							invoiceNumber: invoice.invoiceNumber,
							invoiceDate: invoice.issuedAt.toISOString(),
							resolutionStatus: approved ? 'approved' : 'rejected',
							isDuplicate: recallResult.duplicateDetected,
						},
				},
				feedbackScore: approved ? 1 : -1,
			} as const;

			const beforeMemory =
				correction.memoryId !== undefined
					? repository.getMemoryById(correction.memoryId)
					: undefined;

			let previousConfidence = 0.7;
			let previousUsage = 0;
			if (beforeMemory) {
				try {
					const parsed = JSON.parse(beforeMemory.content) as {
						confidence?: number;
						usageCount?: number;
					};
					if (typeof parsed.confidence === 'number') previousConfidence = parsed.confidence;
					if (typeof parsed.usageCount === 'number') previousUsage = parsed.usageCount;
				} catch {
					// ignore parse errors
				}
			}

			const updated = learnFromSignal(repository, signal);
			if (updated) {
				let newConfidence = previousConfidence;
				let newUsage = previousUsage + 1;
				try {
					const parsed = JSON.parse(updated.content) as {
						confidence?: number;
						usageCount?: number;
					};
					if (typeof parsed.confidence === 'number') newConfidence = parsed.confidence;
					if (typeof parsed.usageCount === 'number') newUsage = parsed.usageCount;
				} catch {
					// ignore parse errors
				}

				memoryUpdates.push({
					memoryId: updated.id,
					previousConfidence,
					newConfidence,
					usageCount: newUsage,
					action: approved ? 'reinforce' : 'decay',
				});
			}
		}

		auditTrail.push({
			step: 'learn',
			timestamp: new Date(),
			details: {
				updates: memoryUpdates,
			},
		});
	} else {
		auditTrail.push({
			step: 'learn',
			timestamp: new Date(),
			details: {
				updates: [],
				reason: 'No human feedback supplied; no learning performed for this invoice.',
			},
		});
	}

	const output: EngineOutputContract = {
		normalizedInvoice: applyResult.normalizedInvoice,
		proposedCorrections: applyResult.proposedCorrections,
		requiresHumanReview: decision.requiresHumanReview || recallResult.duplicateDetected,
		reasoning: decision.reasoning,
		confidenceScore: decision.confidenceScore,
		memoryUpdates,
		auditTrail,
	};

	return output;
}
