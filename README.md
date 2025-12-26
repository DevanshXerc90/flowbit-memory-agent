# Flowbit Invoice Memory Agent

## 1. Project Overview

Modern invoice extraction systems repeatedly fix the same classes of errors (e.g., VAT already included, missing service dates, freight line item SKUs). These human corrections are usually **not reused**, so downstream automation does not improve and operators keep reviewing similar issues.

This project adds a **learned memory layer** on top of an invoice extraction pipeline. The agent:

- Observes proposed corrections and human feedback.
- Stores structured memories in SQLite.
- Uses those memories on later invoices to **auto-apply** or **suggest** corrections with an explicit confidence score and audit trail.

The goal is to show how a narrow, explainable "memory" can reduce repetitive human work while remaining debuggable and safe.

## 2. Key Concepts

### Learned Memory

Memories are small JSON objects persisted per vendor / invoice pattern. Two main categories are used:

- **Vendor Memory** – stable patterns specific to a supplier, for example:
  - `Supplier GmbH` consistently putting **Leistungsdatum** in the body → `serviceDate` on the normalized invoice.
  - `Parts AG` invoices where totals **already include VAT**.
- **Correction Memory** – per-field corrections derived from human approval, for example:
  - Mapping a particular freight description to SKU `FREIGHT`.
  - Correcting `taxAmount` / `grossAmount` when the extractor misinterprets VAT.

Each memory carries a `confidence` and `usageCount` that are updated as feedback arrives.

### Confidence-Based Decision Making

When processing a new invoice, the engine:

1. **Recalls** relevant memories for the vendor / invoice (by text search + scoring).
2. **Applies** memories conditionally to propose corrections.
3. **Decides** whether to auto-apply or escalate based on confidence bands.

This confidence drives whether a correction is:

- Escalated to a human (low confidence).
- Suggested but not auto-applied (medium confidence).
- Auto-applied (high confidence).

### Explainability and Auditability

Every run produces a structured **audit trail**:

- What memories were recalled.
- Which ones affected proposed corrections.
- Why a decision did or did not require human review.

This makes it possible to inspect *why* an invoice was auto-corrected (or not) and trace it back to prior feedback.

## 3. Architecture

- **Language / Runtime**: TypeScript (strict mode), Node.js.
- **Persistence**: SQLite via `better-sqlite3` (file: `data/memory.db`).
- **Entry point**: `src/demo/demoRunner.ts`.

Core flow (implemented in `src/engine`):

1. `recall()` – search and score learned memories for the current invoice.
2. `apply()` – apply or suggest corrections based on those memories and heuristics.
3. `decide()` – set `requiresHumanReview` and overall `confidenceScore`.
4. `learn()` – update memory confidence and create new memories from human feedback.

The SQLite database is reused across runs, so the agent **remembers** approved corrections and improves automation over time.

## 4. Memory Types Implemented

- **Vendor Memory**
  - Captures vendor-specific rules like:
    - `Supplier GmbH`: map **Leistungsdatum** → normalized `serviceDate`.
    - `Parts AG`: treat indicated totals as VAT-included.
  - Stored with `category: 'vendor'` and vendor / invoice context.

- **Correction Memory**
  - Captures specific field corrections (e.g., `lineItem:1:sku` → `FREIGHT`).
  - Derived from human-approved corrections; used to drive future suggestions or vendor-level rules.

- **Confidence Reinforcement and Decay**
  - When a human **approves** a correction, the associated memory confidence is incremented.
  - When a correction is **rejected**, confidence is decremented.
  - Confidence is bounded in `[0, 0.95]` so no single pattern can dominate forever.

- **Resolution / Duplicate Memory**
  - When feedback indicates resolution or potential duplicates, a compact `resolution` memory is stored to support duplicate detection and auditing.

## 5. Decision Logic

The core decision logic (in `src/engine/decide.ts`) uses confidence bands to determine the action:

- **Low confidence**
  - No trustworthy memory or conflicting signals.
  - Result: `requiresHumanReview = true`.

- **Medium confidence**
  - The engine proposes a correction but **does not auto-apply** it.
  - Result: suggestion surfaced via `proposedCorrections`; human review recommended.

- **High confidence**
  - A stable, reinforced memory with no conflicting suggestions.
  - Result: correction is **auto-applied** and reflected in the normalized invoice.

### Demo-Only First-Run Policy

For **demo clarity only**, `src/demo/demoRunner.ts` adds a thin layer on top of the engine:

- The first encounter of a given **vendor + pattern** (e.g. `Parts AG + VAT`, `Supplier GmbH + serviceDate`, `Freight & Co + freightSku`) is forced to `requiresHumanReview = true`, even if the underlying engine would auto-approve.
- The second run for the same vendor-pattern shows the **unmodified engine decision**, making the improvement visible: first run → review, second run → auto-correct where confidence is high.

This policy lives only in the demo and does not affect the core engine behavior.

## 6. Demo Scenarios Covered

All demos are driven by static JSONs in `data/` and executed from `src/demo/demoRunner.ts`.

- **Parts AG – VAT-Included Learning**
  - First invoice shows that totals already include VAT; human correction reinforces a vendor memory for VAT handling.
  - Subsequent invoice from `Parts AG` with similar text:
    - Automatically recomputes `taxAmount` from the VAT-included total.
    - Moves from "requires human review" to high-confidence auto-correction.

- **Supplier GmbH – Service Date Inference**
  - Human corrections provide the missing `serviceDate` derived from **Leistungsdatum** in the raw text.
  - A vendor memory is written so future `Supplier GmbH` invoices can infer `serviceDate` automatically.

- **Freight & Co – Description → SKU `FREIGHT`**
  - Invoices with descriptions like "Seefracht / Shipping" start with `sku = null`.
  - Human-approved correction maps that description to SKU `FREIGHT`.
  - A vendor-level memory is created; on the next similar invoice, the engine proposes and (at high confidence) auto-applies `FREIGHT`.

Across these scenarios, the demo logs clearly show:

1. First run: forced review (demo policy) with proposed or applied corrections.
2. Learning step: memory updates written to SQLite.
3. Second run: higher confidence and more automation.

## 7. How to Run

From the repository root:

```bash
# 1. Install dependencies
npm install

# 2. (Optional) reset memory to start fresh
eq data/memory.db && rm -f data/memory.db || true

# 3. Run the demo
npx tsx src/demo/demoRunner.ts
```

The demo prints each scenario, the first and second runs, confidence scores, and the memory updates applied.

## 8. Output Contract

The core engine (see `src/engine/index.ts`) returns an `EngineOutputContract` for each invoice with the following fields:

- `normalizedInvoice` – the possibly corrected invoice object.
- `proposedCorrections` – array of `{ field, proposedValue, reason, confidence, memoryId?, applied }`.
- `requiresHumanReview` – boolean flag used by the UI / workflow.
- `reasoning` – human-readable explanation of the decision.
- `confidenceScore` – aggregate confidence (0–1) for the decision.
- `memoryUpdates` – list of memory reinforcements/decays applied in this run.
- `auditTrail` – ordered steps (`recall`, `apply`, `decide`, `learn`) with details for explainability.

This structure is what the assignment expects as the agent’s output contract.

## 9. Notes for Evaluators

- **Persistence**: All learned memories are stored in `data/memory.db` (SQLite) and reused across invocations.
- **Demo reset**: Deleting `data/memory.db` resets the agent to a cold start; the demo scripts handle the rest.
- **No ML training**: The system is deliberately **heuristic-based**, using simple scoring, thresholds, and feedback-driven updates for confidence—no external ML models are involved.

The intent is to demonstrate a narrow, explainable memory layer that can be inspected, reasoned about, and safely extended for production invoice processing scenarios.
