import { Banner, Kpi, errorText, formatDateTime } from '@prsystem/web-kit';
import { OPS } from '../lib/copy';
import { api, requireSession, stepUpIfRequired } from '../lib/portal';
import { OpsShell } from '../lib/shell';

interface KpiView {
  readonly asOf: string;
  readonly totalHotels: number;
  readonly status: {
    readonly active: number;
    readonly expiringSoon: number;
    readonly grace: number;
    readonly expired: number;
    readonly suspended: number;
  };
  readonly packages: { readonly P20: number; readonly P25: number; readonly P30: number };
  readonly inactiveApplications: number;
  readonly sms: { readonly sent: number; readonly delivered: number; readonly failed: number };
}

/** doc 14 §3.1 / OPS-DEC-014: the mutually exclusive cards, each a filter on the list. */
export default async function DashboardPage() {
  const { token, session } = await requireSession('/');
  const answer = await api().call<KpiView>('/operation/dashboard/kpi', { token });
  stepUpIfRequired(answer, '/');
  return (
    <OpsShell session={session} current="dashboard">
      <h1>{OPS.kpi.title}</h1>
      {!answer.ok ? (
        <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
      ) : (
        <>
          <p className="hint">
            {OPS.kpi.asOf}: {formatDateTime(answer.body.asOf)}
          </p>
          <div className="kpi-grid">
            <Kpi
              label={OPS.kpi.totalHotels}
              value={answer.body.totalHotels}
              href="/subscriptions"
            />
            <Kpi
              label={OPS.kpi.active}
              value={answer.body.status.active}
              href="/subscriptions?status=ACTIVE"
            />
            <Kpi
              label={OPS.kpi.expiringSoon}
              value={answer.body.status.expiringSoon}
              href="/subscriptions?status=EXPIRING_SOON"
            />
            <Kpi
              label={OPS.kpi.grace}
              value={answer.body.status.grace}
              href="/subscriptions?status=GRACE"
            />
            <Kpi
              label={OPS.kpi.expired}
              value={answer.body.status.expired}
              href="/subscriptions?status=EXPIRED"
            />
            <Kpi
              label={OPS.kpi.suspended}
              value={answer.body.status.suspended}
              href="/subscriptions?status=SUSPENDED"
            />
            <Kpi
              label={OPS.kpi.inactive}
              value={answer.body.inactiveApplications}
              href="/onboarding?group=INACTIVE"
            />
            <Kpi
              label={OPS.kpi.P20}
              value={answer.body.packages.P20}
              href="/subscriptions?package=P20"
            />
            <Kpi
              label={OPS.kpi.P25}
              value={answer.body.packages.P25}
              href="/subscriptions?package=P25"
            />
            <Kpi
              label={OPS.kpi.P30}
              value={answer.body.packages.P30}
              href="/subscriptions?package=P30"
            />
            <Kpi label={OPS.kpi.smsSent} value={answer.body.sms.sent} href="/sms" />
            <Kpi label={OPS.kpi.smsDelivered} value={answer.body.sms.delivered} href="/sms" />
            <Kpi label={OPS.kpi.smsFailed} value={answer.body.sms.failed} href="/sms" />
          </div>
        </>
      )}
    </OpsShell>
  );
}
