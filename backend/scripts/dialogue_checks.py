# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Independent, hand-calculated expectations for the small synthetic dialogue corpus."""

from typing import Any

# Record signatures omit model-worded labels and generated identities, not financial values.
# Each tuple is kind, amount paise, date, debt type, target paise, outstanding paise.
EXPECTED = {
    "enough": (600000, [("essential", 200000, "2026-09-15", None, None, None)]),
    "timing": (
        500000,
        [
            ("essential", 800000, "2026-09-15", None, None, None),
            ("essential", 200000, "2026-09-13", None, None, None),
            ("income", 2000000, "2026-09-20", None, None, None),
        ],
    ),
    "unknown": (1000000, [("essential", 3000000, None, None, None, None)]),
    "difficult": (100000, [("essential", 600000, "2026-09-14", None, None, None)]),
    "understanding": (
        300000,
        [
            ("essential", 500000, "2026-09-15", None, None, None),
            ("income", 300000, "2026-09-14", None, None, None),
        ],
    ),
    "debts": (
        1200000,
        [
            ("debt", 200000, "2026-09-16", "loan", None, None),
            ("debt", 200000, "2026-09-16", "loan", None, None),
            ("debt", 50000, "2026-09-18", "card", 150000, 2000000),
            ("debt", 100000, "2026-09-18", "card", 200000, 3000000),
        ],
    ),
    "missing": (
        800000,
        [
            ("essential", 300000, None, None, None, None),
            ("essential", None, "2026-09-16", None, None, None),
        ],
    ),
    "conflict": (1000000, [("essential", None, "2026-09-15", None, None, None)]),
}


def check_turn(case: str, turn: int, state: dict, before: dict, calls: list[dict]) -> list[dict]:
    """Check actual model interpretation and shared projections without judging prose."""
    checks = []

    def check(name: str, actual: Any, expected: Any) -> None:
        """Retain both sides of each deterministic comparison for failure diagnosis."""
        checks.append(
            {"name": name, "passed": actual == expected, "actual": actual, "expected": expected}
        )

    snapshot = state["snapshot"]
    facts = snapshot["facts"]
    records = facts["records"]
    plan = state["activePlan"]
    opening, signatures = EXPECTED[case]
    signatures = list(signatures)
    if case == "timing":
        if turn >= 2:
            signatures[0] = ("essential", 600000, "2026-09-15", None, None, None)
        if turn >= 3:
            signatures[2] = ("income", 2000000, "2026-09-14", None, None, None)
    if case == "debts" and turn >= 3:
        signatures[0] = ("debt", 250000, "2026-09-16", "loan", None, None)
    if case == "missing" and turn == 2:
        signatures = [
            ("essential", 300000, "2026-09-15", None, None, None),
            ("essential", 120000, "2026-09-16", None, None, None),
        ]
    if case == "conflict" and turn == 2:
        signatures[0] = ("essential", 700000, "2026-09-15", None, None, None)
    actual = [
        (
            item["kind"],
            item["amount"]["amountPaise"],
            item["schedule"]["date"],
            item["debtType"],
            (item["target"] or {}).get("amountPaise"),
            (item["outstanding"] or {}).get("amountPaise"),
        )
        for item in records
    ]
    check("reportedCash", facts["opening"]["amountPaise"], opening)
    check("reportedRecords", sorted(actual, key=str), sorted(signatures, key=str))
    check(
        "amountCertainty",
        all(
            item["amount"]["status"]
            == ("unknown" if item["amount"]["amountPaise"] is None else "exact")
            for item in records
        ),
        True,
    )
    check("noInventedReserve", facts["reservePaise"], 0)
    check("noSilentAcceptance", snapshot["accepted"], None)
    check("noUnrequestedPreview", snapshot["preview"], None)
    check("processingToolUsed", bool(calls), True)
    check("lastToolSucceeded", calls[-1].get("code") if calls else "missing", None)

    closing, first, peak, income = {
        "enough": (400000, None, 0, 0),
        "timing": (
            1500000 if turn == 1 else 1700000,
            {"date": "2026-09-15", "amountPaise": 500000 if turn == 1 else 300000}
            if turn < 3
            else None,
            (500000 if turn == 1 else 300000) if turn < 3 else 0,
            2000000,
        ),
        "unknown": (1000000, None, 0, 0),
        "difficult": (-500000, {"date": "2026-09-14", "amountPaise": 500000}, 500000, 0),
        "understanding": (-200000, {"date": "2026-09-15", "amountPaise": 200000}, 200000, 0),
        "debts": (450000 if turn < 3 else 400000, None, 0, 0),
        "missing": (800000 if turn == 1 else 380000, None, 0, 0),
        "conflict": (1000000 if turn == 1 else 300000, None, 0, 0),
    }[case]
    for field, expected in (
        ("closingPaise", closing),
        ("firstGap", first),
        ("peakGapPaise", peak),
        ("reliableIncomePaise", income),
    ):
        value = plan[field]
        if field == "firstGap" and value is not None:
            value = {key: value[key] for key in ("date", "amountPaise")}
        check(field, value, expected)

    if case in {"enough", "timing", "difficult", "understanding", "debts", "conflict"}:
        check(
            "explicitScope",
            facts["coverage"],
            {
                kind: "reviewed" if any(item[0] == kind for item in signatures) else "none"
                for kind in ("income", "essential", "optional", "debt")
            },
        )
    else:
        check(
            "incompleteScope",
            any(value not in {"none", "reviewed"} for value in facts["coverage"].values()),
            True,
        )
    if case == "understanding":
        check(
            "uncertainReceipt",
            [item["reliability"] for item in records if item["kind"] == "income"],
            ["uncertain"],
        )
        check("conditionalNotAssured", plan["uncertainIncomePaise"], 300000)
    if case == "conflict":
        check("conflictCount", len(facts["conflicts"]), 1 if turn == 1 else 0)
        if turn == 1 and facts["conflicts"]:
            check(
                "competingAmounts",
                sorted(value["amountPaise"] for value in facts["conflicts"][0]["values"]),
                [600000, 800000],
            )
    if case == "debts":
        loans = {item["id"] for item in records if item["debtType"] == "loan"}
        check(
            "ambiguousLoans",
            sorted(facts["decision"]["ambiguousRecordIds"]),
            sorted(loans) if turn == 2 else [],
        )
        if turn == 3:
            scooter_ids = {
                item["id"]
                for item in before["snapshot"]["facts"]["records"]
                if "scooter" in item["label"].casefold()
            }
            check("identifiedScooter", len(scooter_ids), 1)
            check(
                "correctLoanChanged",
                [item["amount"]["amountPaise"] for item in records if item["id"] in scooter_ids],
                [250000],
            )
    if (case == "unknown" and turn >= 2) or (case == "missing" and turn == 1):
        unknowns = {
            f"{item['id']}:schedule.date" for item in records if item["schedule"]["date"] is None
        }
        unknowns |= {
            f"{item['id']}:amount" for item in records if item["amount"]["amountPaise"] is None
        }
        check(
            "unavailableNotOffered",
            sorted(unknowns & {item["id"] for item in state["workspace"]["questions"]}),
            [],
        )

    read_only = (case, turn) in {
        ("enough", 2),
        ("timing", 4),
        ("debts", 4),
        ("understanding", 3),
        ("difficult", 3),
    }
    if read_only:
        check("readOnlyFacts", facts, before["snapshot"]["facts"])
        check("readOnlyRevision", snapshot["revision"], before["snapshot"]["revision"])
        check(
            "readOnlyTools",
            all(call["name"] in {"read_state", "review_plan"} for call in calls),
            True,
        )
    if case in {"enough", "timing", "debts", "missing", "conflict"}:
        revision = min(
            turn, {"enough": 1, "timing": 3, "debts": 3, "missing": 2, "conflict": 2}[case]
        )
        check("atomicRevision", snapshot["revision"], revision)
    if turn > 1:
        check(
            "stableRecordIds",
            sorted(item["id"] for item in records),
            sorted(item["id"] for item in before["snapshot"]["facts"]["records"]),
        )
        if case in {"timing", "debts", "missing", "conflict"}:
            check(
                "preservedConcern",
                facts["decision"]["concern"],
                before["snapshot"]["facts"]["decision"]["concern"],
            )

    workspace = state["workspace"]
    check("snapshotCardConsistency", workspace, snapshot["workspace"])
    results = {item["id"]: item for item in workspace["results"]}
    for name, expected in (("opening", opening), ("closing", closing), ("peakGap", peak)):
        check(f"cardResult:{name}", results.get(name, {}).get("amountPaise"), expected)
    ids = {item["id"] for item in records}
    events = {item["id"] for item in plan["events"]}
    check(
        "cardReferences",
        all(
            set(card["recordIds"]) <= ids
            and set(card["eventIds"]) <= events
            and set(card["resultIds"]) <= results.keys()
            for card in workspace["cards"]
        ),
        True,
    )
    return checks
