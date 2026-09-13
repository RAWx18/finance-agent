Decision journal

[11 September 2026]

- Getting voice connected

The work was drifting towards a sound manual planner. I pushed back on the AI-assisted plan
to keep polishing maths, authorization analysis, and infrastructure before connecting voice.
The foundation could stay. I wanted to try describing a problem, seeing the figures, correcting
one, and reaching a 30-day plan. We would not learn much about questions or turn-taking from
another isolated subsystem. One complete conversation became the acceptance check.
A limited prototype was fine, but the listening and financial answers had to be real.

- Cash flow and payment choices

The backend owns the saved facts and paise calculations. The model explains the result;
there was no need for it to keep another balance or call a second planner model.

I tried early bills followed by salary. A later cut can improve closing cash and still leave
rent unpaid. First shortfall, largest shortfall, and closing balance need separate treatment.
Payments go before receipts on the same day as a cautious assumption, not known bank order.

The payment review also caught the difference between a card's minimum and preferred target.
The cases included combined minimums, declined cuts, unavailable follow-ups, and zero versus
unknown fees. Previews wait for explicit acceptance. Essentials, loans, and automatic debits
cannot be silently cut. "I can't ask" is not "the lender refused," and neither changes what is due.
Sometimes the answer is still that it does not fit. No invented lender offer to get past that.

- First voice checks

Settled on Pipecat, Daily, Azure-hosted Terra, and Azure Speech with Indian-English recognition
and Aarti HD synthesis. The component checks produced speech and saved corrections.
I tried the optional speech refinement, but financial recognition was mixed and it added delay.
Stayed with standard recognition. No hidden fallback; try this stack together before comparing more.

Daily initially allowed room creation but blocked media joining on account activation. Once
that stopped reproducing, real audio exchange and the browser cash-correction flow worked.
This used synthetic microphone speech. Amounts and dates still went wrong, so human acceptance
was outstanding.

- Saved figures

Browser and voice share one saved state. An old edit cannot overwrite a newer one, and retrying
a save cannot apply it twice. One retained session would not load because its calculation date
was missing. The figures were valid; rebuilding the projection was enough. No data wipe.
Google sign-in stayed server-enforced, without a production bypass.

I exercised restarts, lost replies, logout, deletion races, and the restricted packaged runtime.
One backend instance with SQLite was enough for the prototype; high availability could wait.
Remote CI and coverage uploads still needed their own run, whatever passed locally.

[12 September 2026]

- Opening and follow-ups

At this stage the model gave a short opening, then the person could supply several facts.
A garbled September date exposed a problem: unclear speech was being treated as information
the person could not provide. Replaying it helped retain the amounts without recording that answer.

I also tried repeated facts, similar loans, corrections, and explicit unknowns. Missing income
is not "none." If someone says "I don't know," don't ask it straight back. Recognition itself
still needed work; this was about what happened to the unclear transcript.

- Cutting down the cards

I rejected the verbose cards and asked the finance review to choose what matters now, not
reproduce a category checklist. Cash and timing, relevant commitments, uncertainty that affects
the decision, and proposed changes stayed. Inline edits reach the state the assistant reads.
I tried failed saves and retained drafts in the browser, including narrow screens and larger text.

Later I removed Review and Take your plan. End leaves the picture there; Money holds the detail
and downloads. End/reconnect checks covered the cards staying put. Estimates and minimum-only
warnings still need to be visible, even with less text. Unresolved information can remain after End.

- Saved chats

Temporary transcripts meant too much was lost between calls. Saved what was actually said,
including interrupted speech, and made the chat independent of any one call. I exercised
isolation, recall, forgetting, and continuing through a fresh real-media call with the saved figures.
Reopening the page alone must leave the microphone off. Memory notes are not financial facts.

Chats expire with the plan; preferences have separate retention rules. Text only, no recordings.
Deleting our copy cannot promise deletion by the speech providers.

- "Can you hear me" failed

"Can you hear me" produced a caption, then failed. Separate model and speech probes had worked.
The actual image lacked sentence-splitting data and could not download it in the read-only runtime.
Bundled and tested that data during the build rather than loosening permissions or switching
providers. The greeting replay then spoke through the image. Health checks had missed this.
There was still no explanation for every earlier stopped call.

- Pauses, interruptions, End

Real exercises split turns around pauses and short interruptions. Recognition activity now
helps decide when a turn ends, so "No, stop" can interrupt without losing the correction after it.
Obsolete speech is discarded. End stops microphone and playback immediately, while provider
cleanup finishes separately; another call waits for that cleanup. Mute must not end the call.

A live run also showed "muted" while capture was active. Made the indicator follow acknowledgement.
The exercises covered multi-fact pauses, overlapping corrections, lost End replies, and reconnects.
For now a transient response failure offers Continue, with no automatic retry. I did not want
to guess whether an interrupted save or speech operation had finished.

- Response delay

The financial tools were quick in the trace. Most of the wait was turn handoff and model requests.
Removed repeated snapshots and an unnecessary pause extension without dropping facts or consent.
Financial speech still waits until tool selection and saving are settled.

An early small comparison improved. A later like-for-like run still took roughly eleven to
twelve seconds. Less input, but no consistent speedup. I left the cleanup in and dropped the
stronger claim. Filler speech or cutting the person's thinking pause would not prove an improvement.

- Schedules and missing dates

Added finite schedules, varying amounts, and monthly budgets, testing endings, month lengths,
rounding, and edits. Spreading a budget over days cannot turn it into contractual daily bills.
Foreign income retains the original amount and reported conversion terms. No market lookup yet;
missing rates and fees stay unknown. Uncertain forecasts are not automatic spending-cut options.

I pushed back on the rigid AI-assisted date handling. "Rent is Rs 30,000 monthly" gives us something
useful even without a day. That is not permission to invent the first of the month. Undated
payments got an "if due in this window" comparison; reported dates and patterns stay distinct
from unknowns. Rent corrections, month-end salary, and adding dates were tested for double-counting.
A qualified picture would do. Pattern income was still outside assured funds at this point.

- Replay findings

In the text replays the model tried unsupported rent timing and advised from a failed save.
It also turned the lowest balance into a reserve recommendation. I corrected the instructions:
explain the saved result, and deal with confusion before asking for more facts.
Replies improved in places. One understanding check was still leading, and the model did not
consistently record that the person could provide no more details. Finishing the replay was not a pass.

The financial audit also found useful later cuts disappearing because an earlier gap remained.
I made those available when they relieve a later funding gap. They still do not solve
the first deadline, and timing-only cuts stay optional. Grouped payments retain each payee's
response; recurring-payment questions use the relevant occurrence's date. Re-ran the failures
through the cards and export, with clearer timing labels.

- Getting to the plan

Every additional expense seemed to move the finish line. Chose one contextual question about
omissions rather than filling unmentioned categories with "none." Qualifications can remain
in a ready plan. Weekly living costs without a start date got a labelled allowance forecast;
the replay needed the actual occurrences, not "four weeks." Corrections and the final-card
handoff were part of that check.
I also asked the AI to stop broad test loops and finish the prototype increment. Focused checks
stayed, with human voice acceptance still outstanding.

Separate save problem: conversation memory was not enough to retry reliably. Stored the exact
request for the active call instead of having the model reconstruct it. I tested failure before
saving and a lost reply afterwards, looking for duplicate rent records. A display-refresh failure
cannot undo a saved figure. The replay also retried within the same turn when it should not,
so attempts were bounded until the user spoke again. Did not add a persistent retry queue.

[13 September 2026]

- Missing crash logs

"Conversation stopped" kept returning, but the original failure was missing from retained logs.
A successful new call could not explain it. Added bounded logs that survive restart and show
the failing stage and save status, without financial speech, amounts, credentials, or provider
bodies. Tested persistence and privacy; missing log events also needed fixing. There was no
evidence to blame the person's internet in the error message.

- Income follow-up

A supplied conversation skipped income, then merely acknowledged the person's correction.
It needed to ask. The focused replay covered that question and salary capture, along with an
unconverted foreign expense that must not disappear and a rent retry that must not duplicate it.

The review also found reliable salary excluded because its date or amount was approximate,
creating a misleading gap. I reversed the exact-only choice: reliable income counts with its
assumptions labelled, alongside a comparison without it. Genuinely uncertain income stays
conditional. Approximate salary and monthly patterns have regression cases.
Shortened the prompt and unnecessary closing tool work too. Not every reply will necessarily be faster.

- Allowing a bounded retry

The stop-or-Continue policy was too disruptive for short failures. Allowed brief reconnection
grace, supported recognition restarts, and resuming after a wordless interruption. One automatic
read-only response retry comes before Continue. It cannot replay saves, override mute, or undo End.
I exercised this with controlled failures and real-provider demos. Google recheck outages got
limited grace too; expiry and permanent setup failures still stop the call. Recovery has to end
somewhere, rather than leave an unusable call saying "Listening."

- Exchange rates

Added the requested Frankfurter lookup. Original currency and captured terms stay separate
from today's planning value. Limited it to one cached attempt per pair per local day, even on
failure, with no alternate provider or fallback to yesterday. Unknown fees are excluded from
the reference estimate, not set to zero. Payment fees add cost; receipt fees reduce income.

The tests covered reuse, restart, failed lookups, changed rates, minimums, and UI corrections.
Only pairs go to the rate service. Publication lag and unavailable conversions are limitations
I'm leaving visible rather than making the estimate look like a bank quote.

- Empty Plan Changes

No options because the optional item had no date. Made that date editable instead of weakening
eligibility. The amounts and acceptance flow needed less clutter, but previews still stay separate
and failed drafts stay open. Another tab's change needs review. I tried multiple choices, lost
replies, reload, and updates reaching the conversation. Narrow-screen checks caught overlaps
during the Money cleanup. Repeated detail could go; stale-state warnings and the reason for
having no choices could not.

- Opening and calendar

I changed my mind about the model-written greeting. Asked for a short configured opening
spoken directly, and the live check produced audio without a model request. Substantive answers
and catching up on a resumed chat still use the model. The first real turn still has its delay.

For dates, supplied the local calendar without shifting the saved planning window. "Tomorrow"
stays relative to when it was said, even across a midnight retry. "Next month" remains a range.
Weekdays, month-end, leap years, and delivery to the voice pipeline were tested. The engine
expands recurrences. There is still room for ambiguous intent or a misheard date.

- More stopped calls

The logs finally separated a missing model deployment from speech failing after audio started.
Matched the available Terra deployment without adding a fallback. Speech recovery applies to
the supported cancellation, not every runtime error.

Then interrupting exposed speech shutdown blocking captions and state updates. Obsolete speech
is discarded immediately while cleanup finishes separately and still needs confirmation.
I injected a hung stop and the next turn could proceed. A real-media interruption demo passed too.
Azure's intermittent synthesis failure remains unresolved.

- Final-plan handoff

Cancelling an inline edit could leave working cards stuck. Settled edits return to the final
plan; genuine drafts remain visible. The browser checks cover that handoff.

Repeated questions also needed to stop after "this is all I have" or an explicit refusal.
The outing replay checks a direct "not safely," explains the remaining gap, and does not offer
the rejected compromise again. Uncertain freelance income and approximate dates remain qualified.
I wanted the answer first, then the next action and caveat, even when the ready plan is not affordable.

- Summary paused

Asked for a summary after the final plan. It started speaking, then Paused. The trace showed
synthesis cancellation, not a long-answer cutoff. The retry returned text but no audio in time.
Left the exhausted-retry pause alone rather than raise limits blindly. Added bounded diagnostics
and a summary step to the live demo; the follow-up spoke it and cleaned up successfully.
That gives us something to retest, but Azure's internal fault is unexplained. I cannot promise
an interruption-free recording from that run.
