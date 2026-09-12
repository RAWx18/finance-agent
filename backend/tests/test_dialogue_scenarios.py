# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Tool replays test the engine/oracle; only the opt-in runner tests model interpretation."""

from copy import deepcopy
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools, canonical
from scripts.dialogue_checks import EXPECTED, check_turn
from scripts.verify_dialogue import CASES

from .conftest import facts, money, record


@pytest.fixture
def intakes():
    """Explicit reported facts are independent of the oracle's expected paise totals."""
    cases = {
        "enough": facts(
            "6000",
            [record("Rent", "essential", "2000", "2026-09-15")],
            coverageEvidence={
                "income": "no income coming in over these thirty days",
                "essential": "No other unpaid living costs",
                "optional": "No other unpaid living costs, debts or optional spending",
                "debt": "No other unpaid living costs, debts or optional spending",
            },
        ),
        "timing": facts(
            "5000",
            [
                record("Rent", "essential", "8000", "2026-09-15"),
                record("Groceries", "essential", "2000", "2026-09-13"),
                record("Salary", "income", "20000", "2026-09-20"),
            ],
            coverageEvidence={
                "income": "That's all my income and unpaid spending for the next thirty days",
                "essential": "That's all my income and unpaid spending for the next thirty days",
                "optional": "no debts or other purchases",
                "debt": "no debts or other purchases",
            },
        ),
        "unknown": facts(
            "10000",
            [
                record("Rent", "essential", "30000", None, schedule={"recurrence": "monthly"}),
            ],
            coverage={},
        ),
        "difficult": facts(
            "1000",
            [
                record("Rent", "essential", "6000", "2026-09-14", controllability="committed"),
            ],
            coverageEvidence={
                "income": "There is no income coming in",
                "essential": "no other unpaid spending or debts over these thirty days",
                "optional": "no other unpaid spending or debts over these thirty days",
                "debt": "no other unpaid spending or debts over these thirty days",
            },
        ),
        "understanding": facts(
            "3000",
            [
                record("Rent", "essential", "5000", "2026-09-15"),
                record("Client", "income", "3000", "2026-09-14", reliability="uncertain"),
            ],
            coverageEvidence={
                "income": "That is all my expected income and unpaid spending",
                "essential": "That is all my expected income and unpaid spending",
                "optional": "no debts or other costs",
                "debt": "no debts or other costs",
            },
        ),
        "debts": facts(
            "12000",
            [
                record("Scooter", "debt", "2000", "2026-09-16"),
                record("Appliance", "debt", "2000", "2026-09-16"),
                record(
                    "HDFC",
                    "debt",
                    "500",
                    "2026-09-18",
                    debtType="card",
                    target=money("1500"),
                    outstanding=money("20000"),
                ),
                record(
                    "SBI",
                    "debt",
                    "1000",
                    "2026-09-18",
                    debtType="card",
                    target=money("2000"),
                    outstanding=money("30000"),
                ),
            ],
            coverageEvidence={
                "income": "no income or other spending",
                "essential": "no income or other spending",
                "optional": "no income or other spending",
                "debt": "That's all my unpaid costs and debts for thirty days",
            },
        ),
        "missing": facts(
            "8000",
            [
                record("Rent", "essential", "3000", None),
                record("Electricity", "essential", None, "2026-09-16"),
            ],
            coverage={},
        ),
        "conflict": facts(
            "10000",
            [
                record(
                    "Rent",
                    "essential",
                    None,
                    "2026-09-15",
                    conflicts=[
                        {
                            "field": "amount",
                            "values": [
                                {"id": "messageA", "amount": "6000", "status": "exact"},
                                {"id": "messageB", "amount": "8000", "status": "exact"},
                            ],
                        }
                    ],
                ),
            ],
            coverageEvidence={
                "income": "No income, debts or other spending for the next thirty days",
                "essential": "No income, debts or other spending for the next thirty days",
                "optional": "No income, debts or other spending for the next thirty days",
                "debt": "No income, debts or other spending for the next thirty days",
            },
        ),
    }
    for case, value in cases.items():
        value["decision"] = {"concern": f"Help with {case}."}
        for item in value["records"]:
            del item["id"]
            if item["amount"]["amount"] is None:
                item["amount"]["status"] = "unknown"
            if "conflicts" in item:
                del item["amount"]
    return cases


@pytest.mark.parametrize("case", EXPECTED)
async def test_reported_scenarios_reconcile_and_propagate(store, intakes, case):
    """Replay financial operations, revisions, receipts and cards without a model or network."""
    await store.create(case)
    tools = VoiceTools(store, case, uuid4(), lambda snapshot: None)
    tools.user_turn = CASES[case][0]
    initial = canonical(await store.get(case))
    intake = {"expectedRevision": 0, **intakes[case]}
    response = await tools.invoke("update_facts", intake, "intake")
    assert "code" not in response, response
    assert await tools.invoke("update_facts", intake, "intake") == response
    state = canonical(await store.get(case))
    checks = check_turn(case, 1, state, initial, [{"name": "update_facts", "code": None}])
    assert all(item["passed"] for item in checks), [item for item in checks if not item["passed"]]
    assert state["snapshot"]["revision"] == state["snapshot"]["sequence"] == 1

    records = {item["label"]: item for item in state["snapshot"]["facts"]["records"]}
    changes = {
        "enough": [None],
        "timing": [
            {"records": [{"id": records.get("Rent", {}).get("id"), "amount": money("6000")}]},
            {
                "records": [
                    {"id": records.get("Salary", {}).get("id"), "schedule": {"date": "2026-09-14"}}
                ]
            },
            None,
        ],
        "unknown": [
            {"records": [{"id": records.get("Rent", {}).get("id"), "schedule": {"date": None}}]},
            None,
        ],
        "understanding": [{"decision": {"responsePreference": "brief"}}, None],
        "debts": [
            {
                "decision": {
                    "ambiguousRecordIds": [
                        item["id"] for item in records.values() if item["debtType"] == "loan"
                    ]
                }
            },
            {
                "decision": {"ambiguousRecordIds": []},
                "records": [{"id": records.get("Scooter", {}).get("id"), "amount": money("2500")}],
            },
            None,
        ],
        "missing": [
            {
                "records": [
                    {"id": records.get("Rent", {}).get("id"), "schedule": {"date": "2026-09-15"}},
                    {"id": records.get("Electricity", {}).get("id"), "amount": money("1200")},
                ]
            }
        ],
    }.get(case, [])
    if case == "conflict":
        changes = [
            {
                "resolutions": [
                    {
                        "conflictId": state["snapshot"]["facts"]["conflicts"][0]["id"],
                        "value": {"id": "confirmed", "amount": "7000", "status": "exact"},
                    }
                ]
            }
        ]
    stream = await store.subscribe(case)
    await stream.get()
    try:
        for turn, change in enumerate(changes, 2):
            tools.user_turn = CASES[case][turn - 1]
            before = state
            name = "update_facts" if change is not None else "read_state"
            arguments = (
                {"expectedRevision": before["snapshot"]["revision"], **change}
                if (change is not None)
                else {}
            )
            response = await tools.invoke(name, arguments, str(turn))
            assert "code" not in response, response
            saved = await store.get(case)
            state = canonical(saved)
            assert response["snapshot"] == state["snapshot"]
            assert response["workspace"] == state["workspace"]
            if change is not None:
                assert stream.get_nowait() == saved
                assert saved.workspace.change.revision == saved.revision
                assert saved.sequence == saved.revision
                assert await tools.invoke(name, arguments, str(turn)) == response
            else:
                assert stream.empty()
            checks = check_turn(case, turn, state, before, [{"name": name, "code": None}])
            assert all(item["passed"] for item in checks), [
                item for item in checks if not item["passed"]
            ]
    finally:
        store.unsubscribe(case, stream)


@pytest.mark.parametrize(
    "defect", ["droppedRent", "staleCard", "silentConsent", "wrongRevision", "lostScope"]
)
async def test_oracle_rejects_plausible_false_successes(store, intakes, defect):
    """Mutation controls prove the evaluator can reject fluent but unsafe results."""
    await store.create("enough")
    tools = VoiceTools(store, "enough", uuid4(), lambda snapshot: None)
    tools.user_turn = CASES["enough"][0]
    before = canonical(await store.get("enough"))
    await tools.invoke("update_facts", {"expectedRevision": 0, **intakes["enough"]}, "intake")
    state = deepcopy(canonical(await store.get("enough")))
    if defect == "droppedRent":
        state["snapshot"]["facts"]["records"] = []
    elif defect == "staleCard":
        next(item for item in state["workspace"]["results"] if item["id"] == "closing")[
            "amountPaise"
        ] = 600000
    elif defect == "silentConsent":
        state["snapshot"]["accepted"] = {"invented": True}
    elif defect == "lostScope":
        state["snapshot"]["facts"]["coverage"]["essential"] = "reported"
    else:
        state["snapshot"]["revision"] = 2
    checks = check_turn("enough", 1, state, before, [{"name": "update_facts", "code": None}])
    assert not all(item["passed"] for item in checks)


async def test_third_amount_resolution_does_not_double_write_disputed_field(store, intakes):
    """Replay the live duplicate-edit failure and the resolution-only repair atomically."""
    await store.create("conflict")
    tools = VoiceTools(store, "conflict", uuid4(), lambda snapshot: None)
    tools.user_turn = CASES["conflict"][0]
    await tools.invoke("update_facts", {"expectedRevision": 0, **intakes["conflict"]}, "intake")
    tools.user_turn = CASES["conflict"][1]
    before = canonical(await store.get("conflict"))
    conflict = before["snapshot"]["facts"]["conflicts"][0]
    arguments = {
        "expectedRevision": 1,
        "records": [{"id": conflict["recordId"], "amount": money("7000")}],
        "resolutions": [
            {
                "conflictId": conflict["id"],
                "value": {
                    "id": "confirmed7000",
                    "amount": "7000",
                    "status": "exact",
                },
            }
        ],
    }
    rejected = await tools.invoke("update_facts", arguments, "duplicate-edit")
    assert rejected["code"] == "invalidFacts"
    await tools.invoke("read_state", {}, "read-after-error")
    assert canonical(await store.get("conflict")) == before
    checks = check_turn(
        "conflict",
        2,
        before,
        before,
        [
            {"name": "update_facts", "code": "invalidFacts"},
            {"name": "read_state", "code": None},
        ],
    )
    assert {item["name"] for item in checks if not item["passed"]} >= {
        "reportedRecords",
        "conflictCount",
        "closingPaise",
        "atomicRevision",
    }
    del arguments["records"]
    result = await tools.invoke("update_facts", arguments, "resolve-only")
    assert "code" not in result
    after = canonical(await store.get("conflict"))
    checks = check_turn("conflict", 2, after, before, [{"name": "update_facts", "code": None}])
    assert all(item["passed"] for item in checks)
    assert after["snapshot"]["facts"]["records"][0]["id"] == conflict["recordId"]


@pytest.mark.parametrize("case", ["timing", "debts"])
async def test_successful_read_cannot_mask_rejected_correction(store, intakes, case):
    """Retain regressions for a mistyped ID and ambiguity put inside a record patch."""
    await store.create(case)
    tools = VoiceTools(store, case, uuid4(), lambda snapshot: None)
    tools.user_turn = CASES[case][0]
    await tools.invoke("update_facts", {"expectedRevision": 0, **intakes[case]}, "intake")
    tools.user_turn = CASES[case][2 if case == "timing" else 1]
    before = canonical(await store.get(case))
    records = before["snapshot"]["facts"]["records"]
    arguments = {
        "expectedRevision": 1,
        "records": [
            {"id": "mistyped-salary-id", "schedule": {"date": "2026-09-14"}}
            if case == "timing"
            else {
                "decision": {
                    "ambiguousRecordIds": [
                        item["id"] for item in records if item["debtType"] == "loan"
                    ]
                }
            },
        ],
    }
    result = await tools.invoke("update_facts", arguments, "rejected-correction")
    assert result["code"] == "invalidFacts"
    await tools.invoke("read_state", {}, "read-after-error")
    after = canonical(await store.get(case))
    assert after == before
    checks = check_turn(
        case,
        3 if case == "timing" else 2,
        after,
        before,
        [
            {"name": "update_facts", "code": "invalidFacts"},
            {"name": "read_state", "code": None},
        ],
    )
    failures = {item["name"] for item in checks if not item["passed"]}
    assert "atomicRevision" in failures
    assert ("reportedRecords" if case == "timing" else "ambiguousLoans") in failures
