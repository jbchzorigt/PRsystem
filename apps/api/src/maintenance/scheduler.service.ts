import type { Pool } from 'pg';
import { withTenantTransaction } from '@prsystem/db';
import type { TenantContext } from '@prsystem/db';

/**
 * Issues privileged maintenance jobs (D-09).
 *
 * **Internal only.** Phase 03 exposes no route for this: it is a control-plane
 * capability the API holds, not an API the outside world can call. A public
 * endpoint would need the authorization pipeline that arrives in Phase 04, and
 * shipping one before that pipeline exists would be shipping the credential
 * without the checks that are supposed to sit in front of it.
 *
 * The separation this preserves is a deployment fact, not a code convention:
 * only the API deployment is given `SCHEDULER_DATABASE_URL`. A compromised
 * worker credential can execute a job somebody else issued and cannot issue
 * one — it holds no `INSERT` on `job_run`, cannot execute the scheduling
 * function, and its own job path refuses the privileged namespace. A compromised
 * *API* credential can issue jobs; that is the power the control plane has, and
 * this says so rather than implying the arrangement stops both.
 */
export class MaintenanceSchedulerService {
  constructor(private readonly schedulerPool: Pool) {}

  /**
   * Issues one job for `context.hotelId`, to be executed by `executorLogin`.
   *
   * Everything that decides authorisation is written server-side by
   * `platform.schedule_maintenance_job`: the issuer comes from `session_user`,
   * the executor is validated to be a real Worker login, the scope must equal
   * the transaction's own scope, and the scheduling audit event is written in
   * the same transaction. Nothing here can widen any of that.
   */
  async issueMaintenanceJob(
    context: TenantContext,
    jobName: string,
    executorLogin: string,
  ): Promise<string> {
    return withTenantTransaction(this.schedulerPool, context, async (uow) => {
      const issued = await uow.query<{ job_run_id: string }>(
        'SELECT platform.schedule_maintenance_job($1, $2, $3)::text AS job_run_id',
        [jobName, context.hotelId, executorLogin],
      );
      const id = issued.rows[0]?.job_run_id;
      if (id === undefined) throw new Error('the scheduler returned no job id');
      return id;
    });
  }
}
