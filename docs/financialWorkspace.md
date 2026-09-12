<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Financial workspace

Cards are the shared working picture between the consumer and Isha, not a dashboard.
`Facts` is the writable financial source. The backend derives calculations, issues, choices and
`Snapshot.workspace`; neither the browser nor the LLM maintains another financial ledger.

**Completed turn → interpreted intent → validated command → deterministic calculation →
workspace/SSE update → grounded explanation.**

## Responsibility boundary

| Isha | Financial backend | Consumer interface |
| --- | --- | --- |
| Understand concern, identify the item, distinguish correction from conflict | Validate identity, money, dates, revisions, conflicts and consent | Show exact reported facts and their certainty |
| Choose a useful question and phrase it naturally | Identify material missing information, decision relevance and deadlines | Keep unresolved issues visible without repeating a questionnaire |
| Explain results using references, exclusions and assumptions | Calculate dated balances, shortages and eligible changes | Support inspecting why and correcting the same state |
| Recognize explicit acceptance, rejection or inability to answer | Enforce eligibility and invalidate affected consent | Separate proposals, accepted assumptions and actual facts |

Scope is **reported INR cash flow for a fixed 30-day window**, including usable cash, expected
income, essential/optional spending, loans, cards and other payment obligations. Dates use
Asia/Kolkata. Opening cash corrects the original starting position, not a live bank balance.
Paid expenses and income already in that position must not be counted again.

There is no bank access, payment execution, mandate cancellation, provider contact, credit approval,
new-borrowing recommendation, investment selection or tax/legal determination. Provider reports
are not independently verified approval. Never invent lender rules, fees or offers. Minimum,
intended total payment and outstanding debt are separate; planning does not establish repayment.

## Card templates

The backend determines membership; a fresh session has **no cards**. Cards have stable IDs,
sections, states and references to facts, issues, occurrences and results. Related items share a
card rather than exposing every internal object as a widget.

| Template | Information and when it exists | Consumer decision |
| --- | --- | --- |
| Available cash | Opening amount/certainty and date, relevant reserve; supplied cash, conflict or reserve | Correct usable starting funds; reserve is not spending |
| Income | Named receipts, amount, recurrence, availability date and certainty; appears when discussed | Confirm timing/reliability or retain conditional income |
| Essential spending | Unpaid living costs, amount/date certainty, recurrence, commitment/auto-debit | Protect needs and identify incomplete obligations |
| Optional spending | Named future spending, amount/date and changeability | Explore an eligible reduction; deleting a mistaken fact is not cancellation |
| Loans/other debt | Required instalment, next unpaid date, recurrence, type, optional outstanding | Correct obligations and identify exposed deadlines |
| Credit cards | Required minimum, intended payment including minimum, outstanding, debit/changeability | Compare a supported target reduction without implying payoff |
| Information needing attention | Material missing/uncertain/conflicting details and why they matter; alternatives stay visible | Clarify an exact detail or leave it explicitly unresolved |
| Timeline | Dated receipts/obligations, conservative ordering and requirements balances | See when money is needed, not just the final remainder |
| Gap/timing risk | First/largest deficit, reserve exposure and causal occurrences | Identify the deadline and whether a change actually helps |
| Proposal | Whole assumption set, replacements/removals and calculated effects | Accept unconditionally, reject, or close exploration |
| Accepted assumptions | Consented amounts/dates/effects, separate from facts | See dependencies; accepted never means executed |
| Invalidation | Affected assumptions and reasons they no longer apply | Obtain fresh consent rather than carrying obsolete advice |
| Outlook/plan | Covered/uncovered commitments, qualifications, next step and revisit conditions | Reach a qualified or reviewed conclusion without false completeness |

Known, estimated, uncertain, missing, conflicting, proposed, accepted and unresolved remain distinct.
Missing fields stay on relevant fact/issue cards. Resolved conflicts and deleted items disappear;
successful corrections/decisions remain in the change summary. No empty category placeholders.

## Validated lifecycle

HTTP `updateFacts` and voice `update_facts` share `FactsPatch`, its reducer and the store transaction.
Command and patch carry `expectedRevision`; inputs use decimal **rupee strings**, normalized by the
backend to integer paise. Idempotent command IDs support retries; stale revisions cannot overwrite.

| Intent | Operation and validation |
| --- | --- |
| Create | Omit ID. Kind/label allow a partial record. Repeated normalized names require the existing ID or explicit separate-item confirmation. |
| Update/correct | Exact existing ID and changed fields only. Omission means unchanged; a clear correction is not a competing report. |
| Delete | Exact ID and `delete: true`. Other similar items remain; dependencies are reassessed. No external cancellation. |
| Mark uncertain | Money `status: estimate/unknown`; approximate date `schedule.certainty: estimate`. Unknown money/date is null. |
| Dispute | `conflicts` retains concrete competing values and certainty. Nested record conflicts allow disputed new items plus clear facts in one turn. Disputed fields become unknown, not duplicate obligations or arbitrary winners. |
| Resolve | `resolutions` names the exact conflict and explicitly clarified value/certainty. Selecting an estimate keeps it estimated unless the consumer explicitly confirms it. Reusing a value ID with a different amount/date fails. Ordinary/full edits cannot bypass conflicts. |
| Merge | `merges` requires exact source/target IDs, `confirmed: true` and the consumer's reason. Compatible same-kind facts only; never sum amounts or choose differing known values. Consent is not transferred. |
| Propose | `previewAdjustments` evaluates the complete eligible assumption set without changing active facts/plan. |
| Accept | `acceptPreview`: current preview ID, strict `confirmed: true`, `consentScope: unconditional`, confirmed controllability. |
| Reject/close | `rejectPreview` records refusal and suppresses that dependency-valid proposal. `discardPreview` only closes exploration. |
| Retract/invalidate | `clearAccepted` retracts assumptions. Relevant corrections invalidate dependent consent/reports; unaffected assumptions remain. |

Proposals support controllable optional reductions and eligible one-time credit-card targets no
lower than the exact minimum. Essentials, ordinary loans, automatic debits, past occurrences and
uncertain terms cannot be silently cut or rescheduled. “Only if salary arrives” is not unconditional
consent. User-reported lender terms never imply that the service contacted a lender or executed a change.

## Calculation evidence and questions

`finance.reconcile` is the common kernel for baseline, accepted, proposed and conditional results.
Same-day payments precede receipts conservatively; actual bank processing is not asserted. Unknown
opening yields unknown balances. Estimated/uncertain receipts are excluded from assurance.
Undated obligations are excluded from dated totals **with a limitation**, not treated as zero.

Results expose value/state, rule, date/window, contributing/excluded IDs, per-result exclusion
reasons, witness occurrences, unresolved issues and assumptions. Contributions reference source
facts and kernel balances. Gap evidence stops at the deficit-producing occurrence, before a later
same-day receipt. First gap means largest deficit on the earliest affected date; peak means largest
overall deficit, **not their sum**. Positive closing is not spending permission or an early-gap fix.

`workspace.questions` contains only currently answerable material candidates, bounded by
`workspace_max_questions` in [../config.toml](../config.toml). `workspace.issues` also retains
deferred/non-askable problems. Actions/choices are bounded by `workspace_max_actions`. Isha chooses
the useful question and its wording; inability to answer never resolves the underlying risk.

Workspace projections rebuild on creation, reads, clock refresh and commands; caches are never
authoritative. Full-snapshot SSE preserves ordering without another delta ledger. Server change
sets link corrected facts to affected results/cards. The browser displays deltas, preserves
focus/scroll and respects reduced motion. Stale state disables writes and voice continuation.

## Implementation and checks

- [Models](../backend/app/models.py), [fact reducer](../backend/app/facts.py),
  [workspace/evidence](../backend/app/workspace.py), [store](../backend/app/store.py).
- [Isha tools/scope](../backend/app/voice_tools.py), [cards](../frontend/src/FinancialContext.tsx),
  [corrections/conflicts/evidence](../frontend/src/WorkspaceDetails.tsx).
- [Backend regressions](../backend/tests/test_workspace.py),
  [voice integration](../backend/tests/test_voice_workspace.py),
  [browser HTTP/SSE journey](../frontend/tests/e2e/workspace.spec.ts).

Run the standard checks in [../README.md](../README.md). Scripted model/provider boundaries verify
commands, state, UI and orchestration—not natural-language accuracy. Real recognition and human
conversational acceptance require the separate [live checks](releaseChecks.md).