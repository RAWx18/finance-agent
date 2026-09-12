# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import os
import sys
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from app.config import ROOT, load_config
from app.history import CaptionHistory, History
from app.store import Store, utc_now


async def seed(directory: Path, owner: str) -> None:
    """Seed caption histories only in a running isolated browser-test account database."""
    directory = await asyncio.to_thread(directory.resolve)
    if directory.parent != ROOT / "frontend" / ".cache" or not directory.name.startswith(
        "browser-"
    ):
        raise ValueError("History fixtures require the isolated browser test directory")
    if not await asyncio.to_thread((directory / "sessions.sqlite3").is_file):
        raise ValueError("The isolated browser backend must already be running")
    now = utc_now()
    store = Store(directory / "sessions.sqlite3", load_config(), lambda: now)
    await store.open()
    try:
        async with store.connection().execute(
            "SELECT 1 FROM auth_users WHERE id = ? AND subject = 'google-user-one'", (owner,)
        ) as cursor:
            if await cursor.fetchone() is None:
                raise ValueError("Only the synthetic browser-test Google identity may be seeded")
        await store.create(owner)
        history = History(store)
        conversations = [
            [
                ("assistant", "Hi, I’m Isha. What’s on your mind today?"),
                ("user", "Can I cover rent before payday?"),
                (
                    "assistant",
                    "Let’s look at the timing. When is your rent due, "
                    "and when do you expect your salary?",
                ),
                (
                    "user",
                    "Rent is ₹8,000 on the 18th. My salary comes on the 20th, "
                    "but I have only ₹6,500 right now.",
                ),
                (
                    "assistant",
                    "Rent comes before your salary. What do you need to keep aside "
                    "for food and travel until then?",
                ),
                ("user", "About ₹1,200 for groceries and ₹500 for the bus."),
                (
                    "assistant",
                    "That leaves ₹4,800 for the ₹8,000 rent, a ₹3,200 gap. "
                    "Would you be comfortable asking your landlord about the timing?",
                ),
                ("user", "I can ask, but I don’t know if they’ll agree."),
                (
                    "assistant",
                    "We’ll keep that unconfirmed. Your plan still has a ₹3,200 gap "
                    "until you hear back. Keep food and bus money protected.",
                ),
                ("user", "There’s also a card payment of ₹2,000 due on the 24th."),
                (
                    "assistant",
                    "Is ₹2,000 the required minimum or the amount you were hoping to pay?",
                ),
                ("user", "It’s what I hoped to pay. I need to check the minimum."),
                (
                    "assistant",
                    "Check the card statement for the minimum and ask the landlord about "
                    "rent timing. Neither is confirmed in your plan yet.",
                ),
            ],
            [
                ("user", "Help me plan groceries."),
                (
                    "assistant",
                    "How much needs to last until your next income, including your commute?",
                ),
                ("user", "₹2,400 until Friday. I need ₹400 for travel."),
                (
                    "assistant",
                    "That leaves ₹2,000 for groceries, before any other commitments. "
                    "Is there another payment due before Friday?",
                ),
            ],
            [("user", "Can I cover rent before payday?"), ("assistant", "When is rent due?")],
            [],
        ]
        for index, turns in enumerate(conversations):
            started = now - timedelta(hours=index + 1)
            store.clock = lambda started=started: started
            call = uuid4()
            await history.start(owner, call, (await store.get(owner)).session_id)
            captions = CaptionHistory(history, owner, call)
            for number, (role, text) in enumerate(turns):
                stamp = started + timedelta(seconds=number * 18)
                store.clock = lambda stamp=stamp: stamp
                if role == "user":
                    await captions.capture(
                        {
                            "type": "user-transcription",
                            "data": {
                                "text": text,
                                "timestamp": stamp.isoformat(),
                                "user_id": "test-human",
                                "final": True,
                            },
                        }
                    )
                else:
                    await captions.capture(
                        {
                            "type": "bot-output",
                            "data": {
                                "segment_id": number,
                                "text": text,
                                "will_be_spoken": True,
                                "spoken_status": "completed",
                                "spoken_progress": {"accumulated_text": text},
                            },
                        }
                    )
            await history.finish(owner, call)
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(seed(Path(os.environ["E2E_DATA_DIR"]), sys.argv[1]))
