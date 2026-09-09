'use server';

import { redirect } from 'next/navigation';
import {
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
} from '@prsystem/web-kit/server';
import { api, requireSession } from '../../../lib/portal';

const back = (matchId: string) => `/matches/${matchId}`;

/** doc 13 §9: "Хүлээн авсан" records that the alert was seen — nothing more. */
export async function acknowledge(form: FormData): Promise<void> {
  const matchId = requiredText(form, 'matchId');
  const { token } = await requireSession(back(matchId));
  const answer = await api().call(`/police/matches/${matchId}/acknowledgement`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { expectedRevision: integer(form, 'expectedRevision') },
  });
  if (!answer.ok)
    redirect(withOutcome(back(matchId), { error: answer.code, message: answer.message }));
  redirect(withOutcome(back(matchId), { ok: 'acknowledged' }));
}

/** doc 13 §9.1: the quick Found form — one location kind, the rest optional. */
export async function found(form: FormData): Promise<void> {
  const matchId = requiredText(form, 'matchId');
  const { token } = await requireSession(back(matchId));
  const locationNote = text(form, 'locationNote');
  const taskReference = text(form, 'taskReference');
  const note = text(form, 'note');
  const answer = await api().call(`/police/matches/${matchId}/found`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      expectedRevision: integer(form, 'expectedRevision'),
      locationKind: requiredText(form, 'locationKind'),
      ...(locationNote === undefined ? {} : { locationNote }),
      ...(taskReference === undefined ? {} : { taskReference }),
      ...(note === undefined ? {} : { note }),
    },
  });
  if (!answer.ok)
    redirect(
      withOutcome(back(matchId), {
        error: answer.code,
        message: answer.message,
        field: 'locationNote',
      }),
    );
  redirect(withOutcome(back(matchId), { ok: 'found' }));
}

/** doc 13 §9.3: a False Match is requested here and decided by a second person. */
export async function falseMatch(form: FormData): Promise<void> {
  const matchId = requiredText(form, 'matchId');
  const { token } = await requireSession(back(matchId));
  const answer = await api().call(`/police/matches/${matchId}/false-match`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      reasonCode: requiredText(form, 'reasonCode'),
      reasonNote: requiredText(form, 'reasonNote'),
    },
  });
  if (!answer.ok)
    redirect(
      withOutcome(back(matchId), {
        error: answer.code,
        message: answer.message,
        field: 'reasonNote',
      }),
    );
  redirect(withOutcome(back(matchId), { ok: 'false-match' }));
}
