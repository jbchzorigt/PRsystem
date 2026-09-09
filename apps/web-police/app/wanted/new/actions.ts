'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../../lib/portal';

interface Person {
  readonly personId: string;
  readonly revisionId: string;
  readonly provenance: string;
  readonly approvalState: string;
}
interface Case {
  readonly caseId: string;
  readonly state: string;
  readonly revision: number;
}

/**
 * doc 13 §6.1 steps 2–6: the registration number goes to the API, which asks
 * ХУР or takes the manual identity (§6.2); then the case is opened on the
 * person. The number is in these two request bodies and in no address.
 */
export async function register(form: FormData): Promise<void> {
  const { token } = await requireSession('/wanted/new');
  const client = api();
  const key = idempotencyKeyOf(form);
  const manual = text(form, 'manual') === 'yes';
  const homeAddress = text(form, 'homeAddress');
  const homeDistrict = text(form, 'homeDistrict');
  const person = await client.call<Person>('/police/wanted-people', {
    method: 'POST',
    token,
    idempotencyKey: `${key}-person`,
    body: {
      registrationNumber: requiredText(form, 'registrationNumber'),
      ...(manual
        ? {
            manual: {
              familyName: requiredText(form, 'familyName'),
              parentName: requiredText(form, 'parentName'),
              givenName: requiredText(form, 'givenName'),
              dateOfBirth: requiredText(form, 'dateOfBirth'),
              reason: requiredText(form, 'manualReason'),
              ...(homeAddress === undefined ? {} : { homeAddress }),
              ...(homeDistrict === undefined ? {} : { homeDistrict }),
            },
          }
        : {}),
    },
  });
  if (!person.ok)
    redirect(
      withOutcome('/wanted/new', {
        error: person.code,
        message: person.message,
        field: 'registrationNumber',
      }),
    );
  const opened = await client.call<Case>(`/police/wanted-people/${person.body.personId}/cases`, {
    method: 'POST',
    token,
    idempotencyKey: `${key}-case`,
    body: {
      reasonText: requiredText(form, 'reasonText'),
      crimeCategory: requiredText(form, 'crimeCategory'),
      owningUnitRef: requiredText(form, 'owningUnitRef'),
    },
  });
  if (!opened.ok)
    redirect(
      withOutcome('/wanted/new', {
        error: opened.code,
        message: opened.message,
        field: 'reasonText',
      }),
    );
  const params = new URLSearchParams({
    ok: 'opened',
    state: opened.body.state,
    revision: String(opened.body.revision),
    personId: person.body.personId,
    revisionId: person.body.revisionId,
    provenance: person.body.provenance,
    approval: person.body.approvalState,
  });
  redirect(`/cases/${opened.body.caseId}?${params.toString()}`);
}
