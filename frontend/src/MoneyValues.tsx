// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Snapshot } from './api';
import { amountStatus, money, sourceDescription } from './money';
import { PagedList } from './PagedList';

/** Shows reported conversion terms or ordered occurrence amounts and their calculated INR values. */
export function MoneySources({ record, snapshot }: { record: Snapshot['facts']['records'][number]; snapshot: Snapshot }) {
  if (!record.schedule.amounts?.length) return record.amount.source?.conversion ? <p className="hint">{sourceDescription(record.amount.source)}</p> : null;
  return <PagedList label={`${record.label} ordered amounts`} className="evidence-list" pageSize={5} ordered>{record.schedule.amounts.map((amount, index) => {
    const event = (snapshot.accepted?.plan ?? snapshot.plan).events.find(event => event.recordId === record.id && event.scheduleIndex === index);
    return <li key={index}>Occurrence {index + 1}: {amount.conversion ? <>{sourceDescription(amount)}<p>Calculated INR: {event ? money(event.amountPaise) : 'No dated occurrence available'}</p></>
      : <>{amount.amount == null ? 'Unknown' : `₹${amount.amount}`} · {amountStatus[amount.status]}</>}</li>;
  })}</PagedList>;
}