<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Conversation-quality checks

## Scope and reproduction

The 12 September 2026 evaluation used the configured `gpt-5.6-luna`, production prompt,
tool schemas, validated commands, temporary SQLite storage and deterministic financial engine.
All consumers and figures below are synthetic inputs, not actual customer information.
The fixed plan anchor is 12 September 2026. No financial-engine changes were made for this work.

Run from the backend directory: `uv run --locked python -m scripts.verify_dialogue
--allow-billable --output /tmp/dialogue.json`. Select a case with `--case timing`, `unknown`,
`enough`, `difficult` or `understanding`. This incurs Azure model usage, capped at 40 requests
per run and the configured per-turn tool budget. It never opens Daily, STT or TTS.
Outputs retain input, actual response, tool arguments/error codes, canonical snapshots, model,
prompt hash and provider-reported token usage. `completed` means the replay ran, not semantic approval.

This is text-to-model-to-real-tools evidence, not microphone recognition, physical audio interruption,
human comprehension, authenticated memory recall or a statistical accuracy/latency measurement.
Existing offline pipeline tests separately cover interruption/cancellation, actual framework
message handling, restored context and account-scoped memory with provider doubles.

## Changes and observed reasons

| Observed problem | Bounded change |
| --- | --- |
| Competing instructions about following the current action versus answering the actual user | Prioritize direct questions, misunderstandings and corrections before intake; choose financial follow-ups from the voice shortlist |
| Generic understanding instructions produced no check or a leading yes/no question | On expressed confusion, explain one point and ask about one action or condition; acknowledge an accurate restatement without another check |
| Monthly rent became an unsupported month-end pattern; rejected commands were followed by advice | Clarify recurrence versus pattern; return safe validation paths; require a bounded repair or state check after `invalidFacts` before allowing speech |
| No income became an unknown placeholder; an unavailable action was confused with landlord refusal | Explicit absence uses category `none`; reported refusals use the existing provider-response ledger |
| A successful correction was described as not saved in one iteration | Successful write receipts explicitly carry `saved:true`; post-tool guidance distinguishes success from failure |
| The calculated lowest balance became an invented cash reserve recommendation | Explicitly distinguish a low-point metric from the user's reserve or a supported allocation |
| Reconnected dialogue lost its interrupted flag | Restore an adjacent developer annotation for interrupted assistant prefixes without editing stored transcript text |
| Quiet-pause continuation always instructed a question | Ask only a useful unanswered question, otherwise finish the explanation or give the next step |

No new dialogue database, keyword-based intent parser, financial calculation or automatic consent
was introduced. Model wording and extraction remain probabilistic. Do not replace validation
with assurances that a stronger prompt will always be obeyed.

## Representative observations

Quoted excerpts are actual model outputs from the bounded implementation replays. Runs occurred
at successive revisions; they are not presented as one perfect final conversation. Numerical
claims below were checked against the corresponding captured canonical snapshots.

### 1. A useful explanation, not unnecessary follow-ups

Input: ₹5,000 available; ₹2,000 groceries on 13 September; committed ₹8,000 rent on 15 September;
reliable ₹20,000 salary available on 20 September. The consumer explicitly rules out other
income, unpaid spending and debts.

Observed: “You have a shortfall before payday: after groceries on September 13, rent on
September 15 would leave you INR 5,000 short; your salary arrives only on September 20.”
It then suggests asking the landlord about a different date/amount and checking agreed terms.

Decision: the engine reports an early ₹5,000 gap despite ₹15,000 closing cash. There is no
useful missing-input question; providing the next step is better than another category interview.
The baseline already explained this case reasonably; it was not treated as a failure.

### 2. The right follow-up when timing is missing

Input: ₹10,000 available, ₹30,000 monthly rent, other costs not yet listed, no rent-day pattern.

Before: the model attempted an unsupported month-end pattern twice, both rejected, leaving
revision zero and no saved facts, yet explained a shortfall from the unsaved statement.

Observed after: “If rent falls within the next 30 days, the current plan is short by
INR 20,000, before your other costs or any income are included. Do you know the usual day
of the month when rent is due?”

Decision: save cash and rent together; use the engine's separate undated-payment what-if.
The source date/pattern stay unknown. Timing can materially change period membership and advice.

### 3. A natural amount correction

After case 1: “Actually, that eight thousand should be six thousand.”

Observed: “Rent is now saved as INR 6,000, reducing the September 15 shortfall to INR 3,000.
The salary on September 20 still arrives after that shortfall.”

Decision: the previously discussed ₹8,000 uniquely identifies rent. Its existing record changes
once; there remain exactly three records. The engine changes the gap from ₹5,000 to ₹3,000
and closing from ₹15,000 to ₹17,000. No new intake or repeated landlord instruction is needed.

### 4. An interruption containing a correction

The text harness retains only a ten-word assistant prefix, then supplies:
“No, wait—salary comes on the fourteenth, not the twentieth.”

Observed: “Salary is now saved for September 14, 2026. With that timing, the reported
groceries and rent fit without a calculated shortfall; the lowest balance is INR 3,000
before salary arrives.”

Decision: “No, wait” interrupts the explanation, not the request to change salary timing.
The engine removes the gap; closing stays ₹17,000. This demonstrates transcript semantics,
not acoustic barge-in. Framework tests verify cancellation and that incomplete spoken segments
cannot commit while the user is still speaking.

### 5. “I don't know” without cycling through the same question

After case 2: “I don't know the rent date and can't check right now.”
Then: “I can't confirm any more details right now. Just help me with what I've told you.”

Observed replies retained the conditional ₹20,000 shortfall without assigning a date or asking
for rent timing again. One full replay recorded both unavailable timing and unavailable scope,
leaving an empty voice shortlist. Another retained the scope candidate but did not ask it.

Decision: explicit unavailable information remains a risk, not zero or completed coverage.
The supported undated comparison is already useful. Candidate suppression is deterministic
once the model records the corresponding answer; semantic extraction is still model-dependent.

### 6. Enough information means stop collecting

Input: ₹6,000 cash and ₹2,000 unpaid rent on 15 September; explicitly no other costs, debts,
optional spending or receipts in the window.

Before: four unnecessary zero/unknown placeholder records caused a qualified rather than ready result.
In the final targeted replay an invalid delete-placeholder was rejected, then the required repair
request saved only rent and the explicit category absences before any answer.

Observed: “Yes. Based on the reported figures, you can pay the rent due September 15 and
would have ₹4,000 left afterward…” The consumer then accurately states their plan and says thanks.
Isha closes without another question or financial write; revision remains one.

Decision: the canonical assessment is ready, with one rent record, no gap and no outstanding question.
The ₹4,000 projection does not authorize additional spending or establish that rent was paid.

### 7. An infeasible outcome and a genuine misunderstanding

Input: ₹1,000 cash, committed ₹6,000 rent on 14 September, no other receipts or unpaid costs.
Consumer: “I've already asked; my landlord refused to change the payment. I can't ask anyone else
for help either.”

Before: the refusal became mere action unavailability; the reply allocated scarce cash to essentials
and proposed other support without a supported plan for it.

Observed after: “The rent is still short by ₹5,000 on September 14, with no confirmed way to
cover it from this plan…” The actual landlord refusal is saved; original rent remains unchanged.

Consumer: “So if I pay the thousand, the rent problem is handled?”

Observed: “No. Paying ₹1,000 would only partially pay the ₹6,000 rent, leaving ₹5,000 still due;
it would not handle the rent problem.”

Decision: repair the misunderstanding rather than request another expense. The engine still
shows ₹5,000 unfunded; no imaginary loan, waiver, settlement or executed payment is introduced.

### 8. Understanding a conditional plan

Input: ₹3,000 cash, ₹5,000 rent on 15 September, a possible/unreliable ₹3,000 client payment
on 14 September, and explicitly no other commitments. Canonical main closing is −₹2,000;
the separate received-on-reported-date comparison closes at ₹1,000.

Consumer: “That's a lot. I don't really follow what I should do first.”

Observed: “First, check whether the client's ₹3,000 has actually arrived…” followed by
“Before acting, tell me: will you check the payment first?”

Consumer: “I need to check the client money has actually arrived before relying on it for rent.
Otherwise the rent still isn't covered. Got it, thanks.” Isha acknowledges and stops.

This is better than another intake question, but the observed check is still leading. The final
guidance asks for one action or condition in the consumer's words. A representative target wording
is **“What needs to happen before you rely on the client's money?”** This last wording is an
illustration, not a claimed model quote. Human testing must assess whether this actually helps.

## Evidence boundaries and acceptance

Baseline: twelve turns, 28 model requests, prompt SHA-256
`26b85ae49b4c093cd8383f8b79f755131db03f4f7b41a95bbc4a474835f24e5a`.
Initial after replay: same twelve turns, 25 requests. This is not a speed or accuracy benchmark.
Further focused replays exposed and drove the reserve, receipt-status and invalid-argument fixes.
Final sufficient-information check: two turns, five requests including one rejected argument
and its successful repair. Wording varies; explicit receipts and validation gates provide stronger
guarantees than prompt prose alone.

155 scoped offline tests passed: context/receipt handling, invalid-command repair, evaluation
billing/network safeguards, barge-in/turn cancellation, bounded history, resume and scoped memory.
Run the voice suites plus `test_dialogue_policy.py` and `test_dialogue_verification.py` when changing
this behavior. Do not label text replays or provider doubles as live voice acceptance.