'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, integer, requiredText, text } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../../lib/portal';

interface CaseView {
  readonly caseId: string;
  readonly state: string;
  readonly revision: number;
  readonly sweptMatches?: number;
}

function carry(form: FormData, extra: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  for (const name of ['personId', 'revisionId', 'provenance', 'approval']) {
    const value = text(form, name);
    if (value !== undefined) params.set(name, value);
  }
  return params.toString();
}

/** doc 13 §7: every lifecycle move carries a reason and the row's revision. */
export async function move(form: FormData): Promise<void> {
  const caseId = requiredText(form, 'caseId');
  const back = `/cases/${caseId}`;
  const { token } = await requireSession(back);
  const answer = await api().call<CaseView>(`/police/cases/${caseId}/state`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      state: requiredText(form, 'state'),
      reason: requiredText(form, 'reason'),
      expectedRevision: integer(form, 'expectedRevision'),
    },
  });
  if (!answer.ok) {
    redirect(
      `${back}?${carry(form, { error: answer.code, message: answer.message ?? '', state: text(form, 'currentState') ?? '', revision: text(form, 'expectedRevision') ?? '' })}`,
    );
  }
  redirect(
    `${back}?${carry(form, {
      ok: 'moved',
      state: answer.body.state,
      revision: String(answer.body.revision),
      ...(answer.body.sweptMatches === undefined
        ? {}
        : { swept: String(answer.body.sweptMatches) }),
    })}`,
  );
}

/** doc 13 §6.2: a manual identity is approved or rejected by a different account. */
export async function decideIdentity(form: FormData): Promise<void> {
  const caseId = requiredText(form, 'caseId');
  const personId = requiredText(form, 'personId');
  const back = `/cases/${caseId}`;
  const { token } = await requireSession(back);
  const approve = text(form, 'decision') === 'approve';
  const answer = await api().call<{ approvalState: string }>(
    `/police/wanted-people/${personId}/identity-decisions`,
    {
      method: 'POST',
      token,
      idempotencyKey: idempotencyKeyOf(form),
      body: {
        revisionId: requiredText(form, 'revisionId'),
        approve,
        reason: requiredText(form, 'identityReason'),
      },
    },
  );
  const state = text(form, 'currentState') ?? '';
  const revision = text(form, 'expectedRevision') ?? '';
  if (!answer.ok)
    redirect(
      `${back}?${carry(form, { error: answer.code, message: answer.message ?? '', state, revision })}`,
    );
  redirect(
    `${back}?${carry(form, { ok: 'identity', state, revision, approval: answer.body.approvalState ?? (approve ? 'APPROVED' : 'PENDING_APPROVAL') })}`,
  );
}
