# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from .conftest import facts, money, record
from .test_decision_priorities import next_action
from .test_finance import project


@pytest.mark.parametrize("amount", ["9000", None])
def test_unknown_details_of_explicitly_uncertain_income_do_not_displace_urgent_rent(amount):
    """Verify missing uncertain-income details do not displace urgent rent guidance."""
    plan = project(
        facts(
            "4000",
            [
                {
                    **record("client", "income", "9000", None, reliability="uncertain"),
                    "amount": money(amount, "unknown" if amount is None else "exact"),
                },
                record("rent", "essential", "6000", "2026-09-15", label="Rent"),
            ],
        )
    )
    assert plan.reliable_income_paise == 0
    assert plan.first_gap.amount_paise == 200000
    assert next_action(plan).record_ids == ["rent"]
    uncertainty = next(
        item for item in plan.decision_assessment.uncertainties if "client:" in item.id
    )
    assert "immediateDecision" not in uncertainty.blocks
    assert "excluded" in uncertainty.reason
    assert not any(action.record_ids == ["client"] for action in plan.decision_assessment.actions)


@pytest.mark.parametrize("reliability", ["reliable", "unknown"])
def test_income_not_explicitly_uncertain_still_needs_usable_date(reliability):
    """Verify income not explicitly uncertain prompts for a usable date before rent guidance."""
    plan = project(
        facts(
            "4000",
            [
                record("salary", "income", "9000", None, reliability=reliability),
                record("rent", "essential", "6000", "2026-09-15"),
            ],
        )
    )
    assert plan.decision_assessment.next_question_id == "salary:schedule.date"
    assert "available to use" in next_action(plan).question
    assert plan.first_gap.amount_paise == 200000
