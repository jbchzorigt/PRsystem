import { Banner, Field, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../../lib/copy';
import { requireSession } from '../../../lib/portal';
import { PoliceShell } from '../../../lib/shell';
import { register } from './actions';

/** doc 13 §6: register the person (ХУР or manual) and open the Wanted Case in one screen. */
export default async function NewWantedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = outcomeOf(await searchParams);
  const { session } = await requireSession('/wanted/new');
  const fieldError = (name: string) =>
    outcome.field === name && outcome.error !== undefined
      ? errorText(outcome.error, outcome.message)
      : undefined;
  const w = POLICE.wanted;
  return (
    <PoliceShell session={session} current="wanted">
      <h1>{w.title}</h1>
      <p className="hint">{w.hint}</p>
      {outcome.error !== undefined && outcome.field === undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={register} autoComplete="off">
        <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
        <Field
          id="registrationNumber"
          label={w.registrationNumber}
          error={fieldError('registrationNumber')}
        >
          <input
            id="registrationNumber"
            name="registrationNumber"
            type="text"
            autoComplete="off"
            required
          />
        </Field>
        <fieldset>
          <legend>{w.manual}</legend>
          <label>
            <input type="checkbox" name="manual" value="yes" /> {w.manual}
          </label>
          <Field id="manualReason" label={w.manualReason}>
            <select id="manualReason" name="manualReason" defaultValue="XYP_NOT_FOUND">
              <option value="XYP_NOT_FOUND">{w.XYP_NOT_FOUND}</option>
              <option value="XYP_UNAVAILABLE">{w.XYP_UNAVAILABLE}</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field id="familyName" label={w.familyName}>
              <input id="familyName" name="familyName" type="text" maxLength={100} />
            </Field>
            <Field id="parentName" label={w.parentName}>
              <input id="parentName" name="parentName" type="text" maxLength={100} />
            </Field>
            <Field id="givenName" label={w.givenName}>
              <input id="givenName" name="givenName" type="text" maxLength={100} />
            </Field>
            <Field id="dateOfBirth" label={w.dateOfBirth}>
              <input id="dateOfBirth" name="dateOfBirth" type="date" />
            </Field>
            <Field id="homeAddress" label={w.homeAddress}>
              <input id="homeAddress" name="homeAddress" type="text" maxLength={300} />
            </Field>
            <Field id="homeDistrict" label={w.homeDistrict}>
              <input id="homeDistrict" name="homeDistrict" type="text" maxLength={100} />
            </Field>
          </div>
        </fieldset>
        <h2>{w.caseTitle}</h2>
        <Field id="reasonText" label={w.reasonText} error={fieldError('reasonText')}>
          <textarea
            id="reasonText"
            name="reasonText"
            minLength={10}
            maxLength={2000}
            required
            rows={4}
          />
        </Field>
        <div className="form-grid">
          <Field id="crimeCategory" label={w.crimeCategory}>
            <input id="crimeCategory" name="crimeCategory" type="text" maxLength={120} required />
          </Field>
          <Field id="owningUnitRef" label={w.owningUnitRef}>
            <input id="owningUnitRef" name="owningUnitRef" type="text" maxLength={100} required />
          </Field>
        </div>
        <button className="button" type="submit">
          {w.submit}
        </button>
      </form>
    </PoliceShell>
  );
}
