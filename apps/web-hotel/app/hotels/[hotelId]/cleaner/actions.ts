'use server';

import { redirect } from 'next/navigation';
import {
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
} from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/**
 * The Cleaner's commands (doc 04 §5, §7): take a task, confirm a refill, count
 * the minibar or say it was not used, finish the cleaning. Quantities are what
 * the Cleaner counted; prices never appear, because the API never sends them
 * to this role.
 */
const back = (hotelId: string): string => `/hotels/${hotelId}/cleaner`;

async function post(
  hotelId: string,
  path: string,
  form: FormData,
  body: Record<string, unknown>,
  ok: string,
): Promise<never> {
  const ctx = await hotelContext(hotelId, back(hotelId));
  const answer = await ctx.client.call(path, {
    method: 'POST',
    token: ctx.token,
    body,
    idempotencyKey: idempotencyKeyOf(form),
  });
  if (!answer.ok)
    redirect(withOutcome(back(hotelId), { error: answer.code, message: answer.message }));
  redirect(withOutcome(back(hotelId), { ok }));
}

/** Lines named `qty:<productId>` become `{ productId, quantity }`; blanks are omitted. */
function lines(form: FormData): { productId: string; quantity: number }[] {
  const out: { productId: string; quantity: number }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith('qty:') || typeof value !== 'string' || value.trim() === '') continue;
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity < 0) continue;
    out.push({ productId: name.slice('qty:'.length), quantity });
  }
  return out;
}

export async function claimCleaning(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/cleaning-tasks/${taskId}/claim`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'claimed',
  );
}

export async function completeCleaning(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/cleaning-tasks/${taskId}/complete`,
    form,
    { expectedRevision: integer(form, 'expectedRevision'), refilled: lines(form) },
    'cleaned',
  );
}

export async function claimReport(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const reportId = requiredText(form, 'reportId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar-reports/${reportId}/claim`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'claimed',
  );
}

export async function submitReport(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const reportId = requiredText(form, 'reportId');
  const noUsage = text(form, 'noUsage') === '1';
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar-reports/${reportId}/versions`,
    form,
    {
      expectedRevision: integer(form, 'expectedRevision'),
      counted: noUsage ? [] : lines(form),
      noUsage,
    },
    'submitted',
  );
}

export async function claimRefill(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar-refills/${taskId}/claim`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'claimed',
  );
}

export async function completeRefill(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar-refills/${taskId}/complete`,
    form,
    {
      expectedRevision: integer(form, 'expectedRevision'),
      confirmedQuantity: integer(form, 'confirmedQuantity'),
    },
    'refilled',
  );
}

export async function refillImpossible(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar-refills/${taskId}/impossible`,
    form,
    { expectedRevision: integer(form, 'expectedRevision'), reason: requiredText(form, 'reason') },
    'impossible',
  );
}

export async function claimConfigTask(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar/tasks/${taskId}/claim`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'claimed',
  );
}

export async function completeConfigTask(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const taskId = requiredText(form, 'taskId');
  await post(
    hotelId,
    `/hotels/${hotelId}/minibar/tasks/${taskId}/complete`,
    form,
    { expectedRevision: integer(form, 'expectedRevision'), counted: lines(form) },
    'reconciled',
  );
}
