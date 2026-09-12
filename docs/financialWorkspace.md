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

Foreign income retains its original amount/currency and reported INR-per-unit rate, rate date
and INR deduction. The backend calculates net INR with decimal arithmetic and rounds once to
paise. Missing rates or fees stay unknown; enter zero explicitly for no fee. Estimated source
amounts or conversion terms remain conditional income, not dependable funds. No live rate lookup
or currency conversion transaction is performed.

Schedules support daily, weekly, fortnightly and monthly occurrences, an inclusive `endDate`,
and a finite `count`. Ordered `amounts` generate varying occurrences from the same cadence and
start date; they replace the scalar amount and stop at the list length. Replacement list entries
must include `conversion: null` for INR or complete foreign-source terms. Variable required debt
payments cannot share a scalar intended-payment target.

`monthlyBudget` represents an explicitly chosen even-daily calendar-month spending forecast.
It uses each month's actual length, including leap years, with deterministic paise allocation.
Only days within the start/end and plan window count; clipped days are not redistributed.
Its daily entries are estimates, not contractual bills. For this schedule, `count` means calendar
months. Budget and variable occurrences are not eligible for spending-change proposals.

There is no bank access, payment execution, mandate cancellation, provider contact, credit approval,
new-borrowing recommendation, investment selection or tax/legal determination. Provider reports
are not independently verified approval. Never invent lender rules, fees or offers. Minimum,
intended total payment and outstanding debt are separate; planning does not establish repayment.

## Conversation companion

The backend determines membership; a fresh session has **no cards**. Cards have stable IDs,
states and references to facts, issues, occurrences and results. A shared summary shows the
financial consequence and one eligible next step; four compact patterns hold the supporting facts.

| Pattern | Information and when it exists | Consumer decision |
| --- | --- | --- |
| Cash & timing | Reported opening cash, relevant reserve and qualified calculated closing figure | Check starting funds; positive closing never hides the summary's earlier gap |
| Next & commitments | Four prioritized name/amount/date rows: exposed need, current concern, correction and receipt | Inspect relevant items without duplicate category/timeline rows; expand for remaining records |
| Important uncertainty | One material unresolved detail not already represented on visible rows | Clarify the fact that changes the decision, without an on-screen questionnaire |
| Plan changes | Actual preview, saved assumptions and invalidations together | Review exact amounts/removals and first-shortfall impact before unconditional consent |

Known, estimated, uncertain, missing, conflicting, proposed, accepted and unresolved remain distinct.
Only changed values receive a brief highlight; unchanged values retain their position and focus.
Missing fields stay on their relevant row. Named exclusions, amounts and reasons accompany
calculated figures. The summary and next action survive End without a completion wizard.
Money retains detailed review, printing and a direct download beside the actual expiry time.
Retention remains configured separately from the 30-day projection window.

Ordinary recurring rows select the earliest occurrence on or after evaluation, while a prioritized
exposed occurrence keeps its original date. Elapsed items are never inferred paid. Focused editors
retain their row order until focus leaves; saving a correction updates dependent results together.

Click a source amount, date or name to edit in place; Enter saves and Escape cancels. Source certainty,
foreign conversion terms and selected occurrence amounts retain their original meaning. Generated
balances, shortfalls, net INR and budget-day allocations remain read-only. Repeating dates edit the
series start, not an invented individual occurrence. Failed saves retain the draft; stale revisions
cannot overwrite newer facts. All proposal changes and removals must be visible before consent.

Inline edits submit `updateFacts` with `source: "humanCardEdit"` outside `changes`. The store stamps
`latestChange.source` / `workspace.change.source` with `kind`, authenticated `actorId`, and server `at`.
The change's command ID, revision and before/after field references persist in the same SQLite
transaction and idempotency receipt. Neither the client nor the LLM supplies the actor or timestamp.
Voice tool arguments do not accept this source label.

Isha receives the same source metadata in canonical `change`; external edits refresh the snapshot
and invalidate obsolete model/tool/audio generations. The agent is instructed to recognize a manual
correction without replaying its mutation or claiming it was spoken. No card-local financial ledger
or browser arithmetic is introduced.

## Validated lifecycle

HTTP `updateFacts` and voice `update_facts` share `FactsPatch`, its reducer and the store transaction.
Command and patch carry `expectedRevision`; inputs use decimal **rupee strings**, or original
currency amounts when `conversion` is supplied. The backend normalizes to INR integer paise while
retaining foreign source terms. Idempotent command IDs support retries; stale revisions cannot overwrite.

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
`timingRisks` separates pre-receipt exposure from the funding gap remaining after included same-day
receipts. Timing advice is deferrable, not an answerable ordering field; it cannot change money,
dates, reliability or automatic-debit assumptions. First buffer-breach amounts retain their own dates,
separately from the largest buffer shortfall.

Results expose value/state, rule, date/window, contributing/excluded IDs, per-result exclusion
reasons, named `qualifications`, witness occurrences, unresolved issues and assumptions. Contributions reference source
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
    [inline fields](../frontend/src/CardField.tsx), [source edits](../frontend/src/cardFields.ts),
    [detailed evidence](../frontend/src/WorkspaceDetails.tsx).
- [Backend regressions](../backend/tests/test_workspace.py),
    [card membership](../backend/tests/test_companion.py),
    [provenance and voice invalidation](../backend/tests/test_card_edits.py),
    [browser HTTP/SSE companion journey](../frontend/tests/e2e/companion.spec.ts).
- [Consumer financial-flow regressions](../backend/tests/test_financial_flow.py),
    [summary presentation](../frontend/tests/PlanSummary.test.tsx),
    [browser corrections, timing, expiry and export](../frontend/tests/e2e/financialFlow.spec.ts).

Run the standard checks in [../README.md](../README.md). Scripted model/provider boundaries verify
commands, state, UI and orchestration—not natural-language accuracy. Real recognition and human
conversational acceptance require the separate [live checks](releaseChecks.md).