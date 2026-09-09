import { Banner, COMMON, Table, errorText, formatDateTime, formatMnt } from '@prsystem/web-kit';
import { OPS } from '../../lib/copy';
import { api, requireSession, stepUpIfRequired } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';

interface Row {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly hotelId: string | null;
  readonly applicationId: string | null;
  readonly provider: string;
  readonly providerInvoiceId: string;
  readonly providerPaymentId: string | null;
  readonly amountMnt: string;
  readonly confirmedAt: string | null;
  readonly state: string;
}

/** doc 14 §4.2 / OPS-DEC-017: the queue is read here; the terminal outcome is a separate, permissioned command. */
export default async function ReconciliationsPage() {
  const { token, session } = await requireSession('/reconciliations');
  const answer = await api().call<{ items: readonly Row[] }>('/operation/reconciliations', {
    token,
  });
  stepUpIfRequired(answer, '/reconciliations');
  const c = OPS.reconciliations.columns;
  return (
    <OpsShell session={session} current="reconciliations">
      <h1>{OPS.reconciliations.title}</h1>
      <p className="hint">{OPS.reconciliations.hint}</p>
      {!answer.ok ? (
        <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
      ) : (
        <Table<Row>
          caption={OPS.reconciliations.title}
          rows={answer.body.items}
          rowKey={(r) => `${r.subjectKind}:${r.subjectId}:${r.providerInvoiceId}`}
          empty={COMMON.nothingHere}
          columns={[
            { key: 'subject', header: c.subject, cell: (r) => `${r.subjectKind} ${r.subjectId}` },
            { key: 'provider', header: c.provider, cell: (r) => r.provider },
            { key: 'invoice', header: c.invoice, cell: (r) => r.providerInvoiceId },
            { key: 'payment', header: c.payment, cell: (r) => r.providerPaymentId ?? '—' },
            { key: 'amount', header: c.amount, cell: (r) => formatMnt(r.amountMnt) },
            { key: 'confirmed', header: c.confirmedAt, cell: (r) => formatDateTime(r.confirmedAt) },
            { key: 'state', header: c.state, cell: (r) => r.state },
          ]}
        />
      )}
    </OpsShell>
  );
}
