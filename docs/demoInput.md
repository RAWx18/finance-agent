<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Live demo input sheet

**Synthetic person:** salaried, shares a flat in Pune, works from home.
**Window:** 12 September–11 October 2026 inclusive, India time. Use a fresh chat anchored on
12 September; rebase this sheet if demonstrating another day. Unqualified amounts are INR.

Read **Say/Reply** in order, pausing for responses. **Swaps** are optional English alternatives,
not extra facts. Unknowns must stay unknown.

**Build limitation:** native FX conversion supports income only. This subscription tests an
unknown-INR expense retaining its USD price in the name—not native expense conversion.

## Read-aloud script

### 1. Concern and starting cash

**Say:** “I want to cover my bills until payday without cutting food. Today is September
twelfth, twenty twenty-six. I have twenty thousand rupees available across my bank and cash.
Please keep this simple, one question at a time.”

**Swaps:** “Twenty grand available as of September twelve”; “My starting balance on the
twelfth of September is twenty thousand rupees.”

### 2. Reliable salary, uncertain side income

**Say:** “My take-home salary is thirty thousand rupees, available on September twenty-fifth.
That's my reliable monthly payday. A freelance client might also pay about four thousand
rupees net around September twentieth. That amount and date aren't confirmed, and it might
not arrive. I can't check further right now; plan without relying on it.”

**Swaps:** “Thirty thousand net on the twenty-fifth; maybe four thousand around the twentieth”;
“Monthly pay: thirty grand on September twenty-five; roughly four grand from a client, possibly
September twenty, not guaranteed.”

### 3. Rent and recurring groceries

**Say:** “Rent is ten thousand rupees monthly, next due September fifteenth. It includes water
and internet and can't be reduced. I need one thousand rupees for groceries and household basics
every Sunday, starting September thirteenth, through October eleventh. Please protect that food
budget; those shopping trips are still unpaid.”

**Swaps:** “Ten grand rent on the fifteenth; a thousand each Sunday from September thirteen”;
“Rent: ten thousand on September fifteen. Weekly groceries: one thousand, September thirteen
to October eleven.”

Expected grocery dates: **13, 20, 27 September; 4, 11 October**. One recurring item, five payments.

### 4. Conflicting utility amount; omitted due date

**Say:** “The electricity app shows twelve hundred rupees, but a message says fifteen hundred
for the same unpaid bill. I'm not sure which is right.”

Let it ask a useful question. **Reply:** “I've checked the actual bill: one thousand two
hundred rupees, due September sixteenth. Use that, not fifteen hundred.”
If it does not ask, volunteer this reply before continuing so later arithmetic stays comparable.

**Swaps:** “Twelve hundred, not fifteen hundred, by the sixteenth of September”;
“The confirmed electricity payment is one thousand two hundred on September sixteen.”

Expected: one disputed bill, then one resolved bill—not two expenses. Its missing date matters.

### 5. Two EMIs and an ambiguous correction

**Say:** “My bike EMI is three thousand rupees, next auto-debited September eighteenth.
My phone EMI is twelve hundred rupees, next auto-debited September twenty-second. Both repeat
monthly; I can't change their payment dates or required amounts.”

**Swaps:** “Three thousand for the bike on the eighteenth; twelve hundred for the phone on
the twenty-second”; “Monthly auto-debits: bike, three grand, September eighteen; phone,
one thousand two hundred, September twenty-two.”

After its response, **say:** “One of those two EMI amounts is wrong. Change that previous
payment to eight hundred rupees—I need to check which loan it is.”

Expected question: **“Bike EMI or phone EMI?”** No amount should change while the target is unclear.

**Reply:** “It's the phone EMI: eight hundred rupees, not twelve hundred. September
twenty-second is still correct. Leave the bike loan alone.”

**Swaps:** “Phone only: eight hundred on September twenty-two”; “The phone instalment is
eight hundred, still due on the twenty-second of September.”

### 6. Credit-card minimum versus intended total

**Say:** “I've checked this month's credit-card statement: the minimum is one thousand rupees,
due September twenty-fourth. I intended to pay three thousand in total, including that minimum.
I pay manually and can choose the amount. I don't know the outstanding balance or interest
rate and can't check them now.”

**Swaps:** “One thousand minimum by the twenty-fourth; three thousand altogether if possible”;
“September twenty-four: required minimum one thousand, planned total three grand—not four.”

### 7. Correct the starting balance naturally

**Say:** “No, wait—I misread my starting balance. It was eighteen thousand rupees on September
twelfth, not twenty thousand. That's a correction, not another expense. I have no other cash.”

**Swaps:** “Make my September twelve starting cash eighteen grand”; “The opening amount on
the twelfth was eighteen thousand, not twenty thousand rupees.”

### 8. Optional spending with different urgency

**Say:** “An outing with friends would cost twenty-five hundred rupees on September fourteenth.
Nothing is booked or paid; I can skip it without a fee. A haircut would be four hundred rupees,
once after payday but before October twelfth. I haven't picked a day; it can wait.”

**Swaps:** “Two thousand five hundred for the outing on September fourteen; four hundred for
a haircut after payday, date undecided”; “The outing is twenty-five hundred on the fourteenth.
Haircut: four hundred sometime September twenty-five to October eleven, no appointment.”

### 9. USD obligation and an irrelevant missing premium

**Say:** “My work cloud subscription renews monthly for twenty US dollars, next on October
fifth, automatically from my debit card. It's needed for work and isn't in that credit-card bill.
I don't know the
rupee charge, exchange rate or fees. Keep the dollar price in its name and the rupee amount
unknown. I haven't cancelled it.”

**Swaps:** “USD twenty, renewal October five, rupee debit unknown”;
“Twenty American dollars on the fifth of October, monthly; no confirmed INR total.”

**Then say:** “Bike insurance renews on October twentieth. I don't know the premium.”

**Swaps:** “Insurance is due October twenty, amount unknown”;
“The twentieth of October is the renewal date; I haven't got the premium yet.”

Never offer a made-up FX rate, zero fee, estimated INR amount or insurance premium.

### 10. Close the inventory and request a conclusion

**Say:** “That's everything: no other income, unpaid bills, debts or optional spending in this
window. My mobile recharge is already paid and reflected in my starting cash; I don't have its
receipt here. I work from home with no commuting costs. What goes wrong first if I keep the outing?”

Expected: explain the **20 September shortage**, not just the positive closing balance.
If it repeats an unavailable question, say: **“I still can't check that. Please keep it unknown
and explain what I can do with the information we have.”** Repetition is a demo failure, not an
instruction to invent an answer.

### 11. Preview the trade-off, then consent

**Say:** “Show me the plan if I skip the outing. Don't save a spending change yet.”

Expected: saving **₹2,500** still leaves **₹2,000 short on 24 September**.

**Then say:** “Now compare skipping the outing and paying only the confirmed one-thousand-rupee
card minimum by September twenty-fourth. Show both changes together before saving.”

Expected preview: outing **₹2,500 → ₹0**, card total **₹3,000 → ₹1,000**; combined saving
**₹4,500**, with the known dated gap removed. No rent, food or EMI cuts.

**Only after it correctly reads back both changes, say:** “Yes, save both planning changes:
no outing, and one thousand rupees total to the card. I accept both even if the client never
pays. I haven't made any payments or cancelled any subscription.”

**Swaps:** “Save zero for the outing and one thousand for the card, regardless of the client”;
“Agreed: skip the outing and pay the card minimum; neither decision depends on freelance income.”

### 12. Finish without another questionnaire

**Say:** “So I keep rent, food and both EMIs, skip the outing, and get the card minimum paid by
the twenty-fourth. I have no buffer until salary is available. The dollars still need checking,
and the client money isn't dependable. Is that right? Give me the short final plan.”

## Operator checks — do not read aloud

### Arithmetic after all factual corrections

These are **known dated INR projections**, excluding the uncertain client receipt, undated
haircut, unknown cloud debit and unquantified card interest/fees.

| Scenario | Dated outflows | First shortage | Largest shortage | 11 October closing |
| --- | ---: | --- | --- | ---: |
| Original spending intentions | ₹25,500 | ₹700 · 20 Sep | ₹4,500 · 24 Sep | ₹22,500 |
| Skip outing only | ₹23,000 | ₹2,000 · 24 Sep | ₹2,000 · 24 Sep | ₹25,000 |
| Skip outing + card minimum | ₹21,000 | None calculated | ₹0 | ₹27,000 |

- First and largest gaps are **not added**. The 25 September salary cannot fund earlier bills.
- Both changes leave **₹0 after the 24 September minimum**, then ₹30,000 when salary becomes
  available, before three remaining ₹1,000 grocery trips. There is no pre-payday buffer.
- The separate **one-haircut, if-in-window** allowance leaves **₹26,600**, before unknown FX/card
  costs. No invented haircut date or double counting.
- A separate **if-client-pays** comparison may show **₹31,000** dated closing. The estimated
  ₹4,000 is never dependable income in the main plan.

### Questions and cards

**Ask:** electricity amount/date; bike or phone for the ambiguous correction; consent to both
cuts. A useful FX question concerns the all-in INR debit, not a guessed market rate. Respect
the stated inability to answer rather than repeating it.

**Do not demand:** an exact haircut date to solve the early gap; the outside-window insurance
premium; unavailable debt balances/APR to model confirmed instalments; the paid recharge's
amount/date/receipt; repeated salary, grocery or coverage confirmation. Unknown is not zero.

Cards are compact summaries, not one card per bill; expand commitments for the remaining rows.

| Card | Expected behavior |
| --- | --- |
| Cash & timing | ₹20,000 → ₹18,000; dependent balances/gaps update together. |
| Next & commitments | Same corrected electricity/phone records. Five grocery occurrences; one rent and each EMI in-window. Cloud remains USD 20, INR unknown, due 5 October—not ₹20 or a guessed conversion. |
| Important uncertainty | Material conflict/ambiguity can appear, then resolve. Missing details remain on relevant rows without repeated questions. |
| Plan changes | Preview before consent; both accepted cuts retained. Card minimum and original total remain distinct. No executed payment/cancellation claim. |

### The final plan should mean

Protect rent, groceries, electricity and both automatic EMIs. Skip the outing; arrange for the
₹1,000 minimum to reach the card issuer by 24 September. This is **not full repayment**; interest
and fees may apply. Check salary availability before relying on it. Leave the haircut undated,
after payday and subject to other commitments. Verify the all-in INR cloud debit and bank funds
before 5 October. No invented lender extension, cancellation, free credit or new borrowing.

End **qualified**, not “everything funded” or “₹27,000 free to spend”: zero pre-payday buffer,
unknown FX/card costs, separate haircut, uncertain client income. Next rent on 15 October and
insurance on 20 October are outside this window. Revisit when receipt/debit details become known.

**Verification:** arithmetic, recurrence, unknown-INR exclusion, outside-window insurance and
haircut allowance were checked using the current financial engine and synthetic in-memory facts.
Live speech recognition, model extraction and rendered cards have **not** been verified with this script.