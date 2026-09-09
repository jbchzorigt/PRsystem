'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

interface ExportView {
  readonly jobId: string;
  readonly state: string;
  readonly rowCount: number | null;
  readonly fullIdentifier: boolean;
  readonly expiresAt: string | null;
}

/** doc 13 §12.2–12.3: the Excel is built server-side; the portal only names the purpose. */
export async function run(form: FormData): Promise<void> {
  const { token } = await requireSession('/exports');
  const state = text(form, 'state');
  const answer = await api().call<ExportView>('/police/exports', {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      purpose: requiredText(form, 'purpose'),
      taskReference: requiredText(form, 'taskReference'),
      fullIdentifier: text(form, 'fullIdentifier') === 'yes',
      ...(state === undefined ? {} : { state }),
    },
  });
  if (!answer.ok)
    redirect(withOutcome('/exports', { error: answer.code, message: answer.message }));
  const params = new URLSearchParams({
    ok: 'ran',
    jobId: answer.body.jobId,
    state: answer.body.state,
    rows: String(answer.body.rowCount ?? ''),
    full: answer.body.fullIdentifier ? 'yes' : 'no',
    expiresAt: answer.body.expiresAt ?? '',
  });
  redirect(`/exports?${params.toString()}`);
}

/** A five-minute signed link; the browser is sent straight to it. */
export async function download(form: FormData): Promise<void> {
  const jobId = requiredText(form, 'jobId');
  const { token } = await requireSession('/exports');
  const answer = await api().call<{ url: string }>(`/police/exports/${jobId}/download`, {
    method: 'POST',
    token,
  });
  if (!answer.ok)
    redirect(withOutcome('/exports', { error: answer.code, message: answer.message }));
  redirect(answer.body.url);
}
