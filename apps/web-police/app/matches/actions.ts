'use server';

import { redirect } from 'next/navigation';
import { text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

/**
 * doc 13 §9: the exact search opens one active Match. The registration
 * number stays in this POST body; only the match id reaches the address bar.
 */
export async function search(form: FormData): Promise<void> {
  const { token } = await requireSession('/matches');
  const registrationNumber = text(form, 'registrationNumber');
  const matchId = text(form, 'matchId');
  const body =
    matchId !== undefined
      ? { matchId }
      : registrationNumber !== undefined
        ? { registrationNumber }
        : undefined;
  if (body === undefined)
    redirect(withOutcome('/matches', { error: 'VALIDATION_FAILED', field: 'registrationNumber' }));
  const answer = await api().call<{ matchId: string }>('/police/matches/searches', {
    method: 'POST',
    token,
    body,
  });
  if (!answer.ok)
    redirect(withOutcome('/matches', { error: answer.code, message: answer.message }));
  redirect(`/matches/${answer.body.matchId}`);
}
