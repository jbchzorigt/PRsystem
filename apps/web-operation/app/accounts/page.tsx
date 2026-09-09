import { Banner, COMMON, Field, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
import { requireSession } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';
import { createAccount } from './actions';

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = outcomeOf(await searchParams);
  const { session } = await requireSession('/accounts');
  return (
    <OpsShell session={session} current="accounts">
      <h1>{OPS.accounts.title}</h1>
      <p className="hint">{OPS.accounts.hint}</p>
      {outcome.ok === 'created' ? <Banner tone="ok">{OPS.accounts.created}</Banner> : null}
      {outcome.error !== undefined && outcome.field === undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={createAccount}>
        <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
        <Field id="email" label={OPS.accounts.email}>
          <input id="email" name="email" type="email" required />
        </Field>
        <Field id="role" label={OPS.accounts.role}>
          <select id="role" name="role" defaultValue="OPERATION_ADMIN">
            <option value="OPERATION_ADMIN">OPERATION_ADMIN</option>
            <option value="PLATFORM_SUPER_ADMIN">PLATFORM_SUPER_ADMIN</option>
          </select>
        </Field>
        <Field
          id="permissions"
          label={OPS.accounts.permissions}
          error={
            outcome.field === 'permissions' && outcome.error !== undefined
              ? errorText(outcome.error, outcome.message)
              : undefined
          }
        >
          <input
            id="permissions"
            name="permissions"
            type="text"
            placeholder="OPERATION_READ, SUBSCRIPTION_REMINDER_SEND"
          />
        </Field>
        <button className="button" type="submit">
          {OPS.accounts.create}
        </button>
      </form>
      <p>
        <a href="/">{COMMON.back}</a>
      </p>
    </OpsShell>
  );
}
