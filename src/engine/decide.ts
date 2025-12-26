import type { ApplyContext } from './apply';

export interface Decision {
  requiresHumanReview: boolean;
  confidenceScore: number;
  reasoning: string;
}

export function decideNextAction(context: ApplyContext): Decision {
  const hasDuplicate = context.input.recall.duplicateDetected;

  const highConfidenceApplied = context.appliedMemories.some(
    (m) => m.applied && m.confidence >= 0.8,
  );

  const mediumConfidenceSuggestions = context.proposedCorrections.filter(
    (c) => !c.applied && c.confidence >= 0.7 && c.confidence < 0.8,
  );

  const aggregateConfidence = context.aggregateConfidence;

  let requiresHumanReview = true;
  const reasoningParts: string[] = [];

  if (hasDuplicate) {
    requiresHumanReview = true;
    reasoningParts.push(
      'Potential duplicate detected based on vendor, invoice number, and invoice date proximity.',
    );
  }

  if (!hasDuplicate && highConfidenceApplied && mediumConfidenceSuggestions.length === 0) {
    requiresHumanReview = false;
    reasoningParts.push(
      'High-confidence learned corrections applied without conflicting suggestions; auto-correction is allowed.',
    );
  }

  if (mediumConfidenceSuggestions.length > 0) {
    requiresHumanReview = true;
    reasoningParts.push(
      'Medium-confidence suggestions present; human review recommended before applying corrections.',
    );
  }

  if (!highConfidenceApplied && mediumConfidenceSuggestions.length === 0 && !hasDuplicate) {
    requiresHumanReview = true;
    reasoningParts.push('No sufficiently confident learned memory found; escalate to human review.');
  }

  const confidenceScore = Math.min(Math.max(aggregateConfidence, 0), 1);

  return {
    requiresHumanReview,
    confidenceScore,
    reasoning: reasoningParts.join(' '),
  };
}
