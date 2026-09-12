// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, Snapshot } from './api';
import { Dialog } from './Dialog';
import { PagedList } from './PagedList';
import { ConflictReview } from './WorkspaceDetails';
import { dateLabel } from './money';
import { MoneyIcon } from './MoneyIcon';
import type { EditTarget } from './MoneyEdit';

export function moneyIssues(snapshot: Snapshot) {
  const assessment = (snapshot.accepted?.plan ?? snapshot.plan).decisionAssessment;
  return [...new Map([...(assessment?.uncertainties ?? []), ...(snapshot.workspace?.issues ?? [])].map(issue => [issue.id, issue])).values()];
}

const issueFields: Partial<Record<string, EditTarget['field']>> = {
  amount: 'amount', target: 'target', outstanding: 'outstanding', 'schedule.date': 'schedule.date',
  reliability: 'reliability', controllability: 'controllability', recurrence: 'recurrence', schedule: 'schedule.date',
  'schedule.certainty': 'schedule.date', 'schedule.recurrence': 'recurrence', autoDebit: 'autoDebit', debtType: 'debtType',
};

export function MoneyChecks({ snapshot, open, blocked, onClose, onEdit, onCommand }: {
  snapshot: Snapshot; open: boolean; blocked: boolean; onClose: () => void;
  onEdit: (target: EditTarget) => void; onCommand: (operation: Command['operation']) => Promise<Snapshot | undefined>;
}) {
  const issues = moneyIssues(snapshot);
  return <Dialog open={open} title="Needs your check" onClose={onClose}>
    <PagedList label="Remaining checks" className="money-checks" pageSize={6}>{issues.map(issue => <li key={issue.id}>
      <h3>{issue.question}</h3><p>{issue.reason}</p>
      {issue.beforeDate && <p className="money-meta">Before {dateLabel(issue.beforeDate)}</p>}
      {issue.recordIds.map(id => {
        const record = snapshot.facts.records.find(item => item.id === id);
        const field = issueFields[issue.field];
        return record && field && <button key={id} className="icon-button" disabled={blocked} title={`Edit ${record.label}`} aria-label={`Edit ${record.label}`} onClick={() => { onClose(); onEdit({ recordId: id, field }); }}><MoneyIcon name="edit" /></button>;
      })}
      {issue.field === 'opening' && <button className="icon-button" disabled={blocked} title="Correct starting cash" aria-label="Correct starting cash" onClick={() => { onClose(); onEdit({ field: 'opening' }); }}><MoneyIcon name="edit" /></button>}
    </li>)}</PagedList>
    {!!snapshot.facts.conflicts?.length && <><h3>Conflicting reports</h3><PagedList label="Conflicting reports" className="money-checks" pageSize={4}>{snapshot.facts.conflicts.map(conflict => <li key={conflict.id}><ConflictReview {...{ conflict, snapshot, blocked, onCommand }} /></li>)}</PagedList></>}
    {!issues.length && !snapshot.facts.conflicts?.length && <p>No open checks in this assessment. Reported figures are not independently verified.</p>}
  </Dialog>;
}