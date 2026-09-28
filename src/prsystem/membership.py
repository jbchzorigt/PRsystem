"""Hotel membership mutations and the first, claim-only takeover boundary."""

import secrets

from psycopg.types.json import Jsonb

from prsystem.auth import digest
from prsystem.common import DomainError, identifier
from prsystem.postgres.connection import transaction
from prsystem.staff_commands import StaffCommands
from prsystem.obligations import exception_shift_root
from prsystem.subscription import AccessFacts, Action, subscription_gate


class MembershipService(StaffCommands):
    @staticmethod
    def _event(conn, tenant, actor, target, kind, details):
        conn.execute("""INSERT INTO prsystem.staff_change_event
            (id, tenant_id, actor_id, target_id, kind, details) VALUES (%s, %s, %s, %s, %s, %s)""",
            (secrets.token_hex(16), tenant, actor, target, kind, Jsonb(details)))

    @staticmethod
    def _manager(roles, package):
        return "MANAGER" in roles or ("MANAGER_PLUS" in roles and package == 30000)

    @classmethod
    def _member_roles(cls, roles, package, primary):
        if not roles or len(roles) != len(set(roles)):
            raise DomainError("ROLE_NOT_ALLOWED")
        if ("HOTEL_ADMIN" in roles) != primary:
            raise DomainError("PRIMARY_ADMIN_PROTECTED" if primary else "ROLE_NOT_ALLOWED")
        operational = [role for role in roles if role != "HOTEL_ADMIN"]
        if operational or not primary:
            cls._roles(operational, package)

    def change(self, bearer, tenant, target, action, revision, key, reason, roles=None):
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
            raise DomainError("INVALID_REASON")
        if action not in {"ROLES", "SUSPEND", "TERMINATE", "REACTIVATE"} or (action == "ROLES") != (roles is not None):
            raise DomainError("INVALID_REQUEST")
        command = {"action": action, "account_id": target, "revision": revision, "reason": reason, "roles": roles}
        with transaction(self.auth.dsn) as conn:
            actor, package = self._admin(conn, bearer, tenant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            member = conn.execute("""SELECT status, roles, is_primary, revision FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s FOR UPDATE""", (tenant, target)).fetchone()
            if member is None:
                raise DomainError("MEMBERSHIP_NOT_FOUND")
            status, previous_roles, primary, current_revision = member
            if type(revision) is not int or revision != current_revision:
                raise DomainError("REVISION_CONFLICT")
            if primary and action != "ROLES":
                raise DomainError("PRIMARY_ADMIN_PROTECTED")
            next_roles, next_status = previous_roles, status
            if action == "ROLES":
                self._member_roles(roles, package, primary)
                next_roles = sorted(roles)
            elif action == "SUSPEND" and status in {"ACTIVE", "PENDING"}:
                next_status = "SUSPENDED"
            elif action == "TERMINATE" and status in {"ACTIVE", "PENDING", "SUSPENDED"}:
                next_status = "TERMINATED"
            elif action == "REACTIVATE" and status in {"SUSPENDED", "TERMINATED"}:
                self._member_roles(previous_roles, package, primary)
                account = conn.execute("SELECT status, verified_at FROM prsystem.staff_account WHERE id = %s", (target,)).fetchone()
                if account[0] != "ACTIVE" or account[1] is None:
                    raise DomainError("ACCOUNT_NOT_ACTIVE_VERIFIED")
                next_status = "ACTIVE"
            else:
                raise DomainError("INVALID_MEMBERSHIP_TRANSITION")
            # Revocation does not re-grant stale roles after a package downgrade.
            # Only role grants/reactivation validate the target's new entitlement.
            new_revision = conn.execute("""UPDATE prsystem.staff_membership SET status = %s, roles = %s
                WHERE tenant_id = %s AND account_id = %s RETURNING revision""",
                (next_status, next_roles, tenant, target)).fetchone()[0]
            conn.execute("""UPDATE prsystem.staff_session SET revoked_at = clock_timestamp()
                WHERE tenant_id = %s AND account_id = %s AND revoked_at IS NULL""", (tenant, target))
            conn.execute("""UPDATE prsystem.staff_link SET state = 'REVOKED' WHERE tenant_id = %s AND account_id = %s
                AND purpose = 'INVITE' AND state = 'ACTIVE'""", (tenant, target))
            # Account lock shared with source registration prevents a late open
            # item from escaping this scan. Source ownership/history never moves.
            blocked = conn.execute("""UPDATE prsystem.staff_open_work SET state = 'BLOCKED'
                WHERE tenant_id = %s AND owner_id = %s AND state = 'OPEN'
                AND (%s <> 'ACTIVE' OR (kind = 'SHIFT' AND NOT %s) OR (kind = 'CLEANING_TASK' AND NOT %s))
                RETURNING id, kind""", (tenant, target, next_status, "RECEPTION" in next_roles,
                                        "CLEANER" in next_roles and package >= 25000)).fetchall()
            queue_ids = []
            for work_id, kind in blocked:
                queue_id = secrets.token_hex(16)
                queued = conn.execute("""INSERT INTO prsystem.staff_work_exception (tenant_id, id, work_id, reason)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (tenant_id,work_id) DO UPDATE SET claimant_id=NULL,
                        revision=staff_work_exception.revision+1
                    RETURNING id""", (tenant, queue_id, work_id,
                    "TAKEOVER_REQUIRED" if kind == "SHIFT" else "REASSIGNMENT_REQUIRED")).fetchone()
                queue_ids.append(queued[0])
            if next_status != "ACTIVE" or not self._manager(next_roles, package):
                released = conn.execute("""UPDATE prsystem.staff_work_exception SET claimant_id = NULL, revision = revision + 1
                    WHERE tenant_id = %s AND claimant_id = %s RETURNING id, revision""", (tenant, target)).fetchall()
                for queue_id, queue_revision in released:
                    self._event(conn, tenant, actor, target, "WORK_CLAIM_RELEASED",
                                {"exception_id": queue_id, "revision": queue_revision, "reason": reason})
            result = {"account_id": target, "status": next_status, "roles": next_roles,
                      "revision": new_revision, "exception_ids": sorted(queue_ids)}
            self._event(conn, tenant, actor, target, "MEMBERSHIP_CHANGED",
                        {"command": command, "before": {"status": status, "roles": previous_roles, "revision": current_revision},
                         "after": result})
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def _queue_actor(self, conn, bearer, tenant, *, exception_id=None, action=Action.CONFIGURE, obligation=None):
        principal, _ = self.auth._authenticate(conn, bearer, tenant)
        hotel = conn.execute("""SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access
            WHERE tenant_id = %s FOR SHARE""", (tenant,)).fetchone()
        facts = AccessFacts(tenant, True, True, True, self._manager(principal["roles"], hotel[0]), True, True, True, hotel[2])
        if exception_id is not None:
            obligation = exception_shift_root(conn, tenant, exception_id)
            action = Action.SHIFT_CLOSE if obligation else Action.CONFIGURE
        decision = subscription_gate(action, facts, hotel[1], conn.execute("SELECT clock_timestamp()").fetchone()[0], obligation)
        if not decision.allowed:
            raise DomainError(decision.code)
        return principal["account_id"]

    def exceptions(self, bearer, tenant, limit=100, after=""):
        with transaction(self.auth.dsn) as conn:
            locked = False
            try:
                self._queue_actor(conn, bearer, tenant)
            except DomainError as exc:
                if str(exc) != "SUBSCRIPTION_EXPIRED":
                    raise
                # Authentication, current Manager role/package and hotel security
                # passed. Return only exact remaining pre-lock shift work.
                locked = True
            rows = conn.execute("""SELECT e.id, e.reason, e.claimant_id, e.revision, w.kind, w.source_id, w.owner_id,
                w.assignment_version FROM prsystem.staff_work_exception e JOIN prsystem.staff_open_work w
                ON (w.tenant_id, w.id) = (e.tenant_id, e.work_id) WHERE e.tenant_id = %s AND w.state = 'BLOCKED'
                AND (NOT %s OR (w.kind='SHIFT' AND EXISTS (
                    SELECT 1 FROM prsystem.reception_shift s JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id
                    WHERE s.tenant_id=w.tenant_id AND s.id=w.source_id AND s.state='OPEN'
                    AND s.opened_at<h.expires_at+interval '48 hours')))
                AND e.id > %s ORDER BY e.id LIMIT %s""", (tenant, locked, after, limit)).fetchall()
            return [{"id": r[0], "reason": r[1], "claimant_id": r[2], "revision": r[3], "kind": r[4],
                     "source_id": r[5], "original_owner_id": r[6], "assignment_version": r[7]} for r in rows]

    def claim(self, bearer, tenant, exception_id, revision, key):
        command = {"action": "CLAIM_WORK", "exception_id": exception_id, "revision": revision}
        with transaction(self.auth.dsn) as conn:
            actor = self._queue_actor(conn, bearer, tenant, exception_id=exception_id)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            row = conn.execute("""SELECT e.claimant_id, e.revision, w.owner_id FROM prsystem.staff_work_exception e
                JOIN prsystem.staff_open_work w ON (w.tenant_id, w.id) = (e.tenant_id, e.work_id)
                WHERE e.tenant_id = %s AND e.id = %s AND w.state = 'BLOCKED' FOR UPDATE OF e""", (tenant, exception_id)).fetchone()
            if row is None:
                raise DomainError("EXCEPTION_NOT_FOUND")
            if type(revision) is not int or revision != row[1]:
                raise DomainError("REVISION_CONFLICT")
            if row[0] is not None and row[0] != actor:
                raise DomainError("EXCEPTION_ALREADY_CLAIMED")
            new_revision = row[1]
            if row[0] is None:
                new_revision = conn.execute("""UPDATE prsystem.staff_work_exception SET claimant_id = %s, revision = revision + 1
                    WHERE tenant_id = %s AND id = %s RETURNING revision""", (actor, tenant, exception_id)).fetchone()[0]
                self._event(conn, tenant, actor, row[2], "WORK_CLAIMED", {"exception_id": exception_id, "revision": new_revision})
            result = {"id": exception_id, "claimant_id": actor, "revision": new_revision, "status": "CLAIMED"}
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def recover_claim(self, bearer, tenant, exception_id, revision, key, reason):
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
            raise DomainError("INVALID_REASON")
        command = {"action": "RECOVER_CLAIM", "exception_id": exception_id, "revision": revision, "reason": reason}
        with transaction(self.auth.dsn) as conn:
            session = conn.execute("SELECT account_id FROM prsystem.staff_session WHERE token_hash = %s", (digest(bearer),)).fetchone()
            if session is None:
                raise DomainError("UNAUTHENTICATED")
            snapshot = conn.execute("SELECT claimant_id FROM prsystem.staff_work_exception WHERE tenant_id = %s AND id = %s",
                                    (tenant, exception_id)).fetchone()
            previous = snapshot[0] if snapshot else None
            self._lock_accounts(conn, {session[0], previous} - {None})
            actor = self._queue_actor(conn, bearer, tenant, exception_id=exception_id)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            row = conn.execute("""SELECT e.claimant_id, e.revision, w.owner_id FROM prsystem.staff_work_exception e
                JOIN prsystem.staff_open_work w ON (w.tenant_id, w.id) = (e.tenant_id, e.work_id)
                WHERE e.tenant_id = %s AND e.id = %s AND w.state = 'BLOCKED' FOR UPDATE OF e""", (tenant, exception_id)).fetchone()
            if row is None:
                raise DomainError("EXCEPTION_NOT_FOUND")
            if type(revision) is not int or row[1] != revision or row[0] != previous:
                raise DomainError("REVISION_CONFLICT")
            if previous is None:
                raise DomainError("EXCEPTION_NOT_CLAIMED")
            member = conn.execute("""SELECT m.status, m.roles, a.status, a.verified_at FROM prsystem.staff_membership m
                JOIN prsystem.staff_account a ON a.id = m.account_id WHERE m.tenant_id = %s AND m.account_id = %s
                FOR SHARE OF m""", (tenant, previous)).fetchone()
            package = conn.execute("SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id = %s", (tenant,)).fetchone()[0]
            if member[0] == "ACTIVE" and member[2] == "ACTIVE" and member[3] is not None and self._manager(member[1], package):
                raise DomainError("CLAIMANT_STILL_ELIGIBLE")
            new_revision = conn.execute("""UPDATE prsystem.staff_work_exception SET claimant_id = %s, revision = revision + 1
                WHERE tenant_id = %s AND id = %s RETURNING revision""", (actor, tenant, exception_id)).fetchone()[0]
            self._event(conn, tenant, actor, previous, "WORK_CLAIM_RELEASED",
                        {"exception_id": exception_id, "revision": new_revision, "reason": reason})
            self._event(conn, tenant, actor, row[2], "WORK_CLAIMED",
                        {"exception_id": exception_id, "revision": new_revision, "previous_claimant_id": previous, "reason": reason})
            result = {"id": exception_id, "claimant_id": actor, "revision": new_revision, "status": "CLAIMED"}
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    @classmethod
    def register_open_work(cls, conn, tenant, owner, kind, source_id, *, checkout_stay=None, inspection_stay=None, refill_stay=None):
        """Internal source adapter only, inside the source creation transaction.

        Call before source row locks; all involved accounts must be locked in
        sorted order first. No HTTP route accepts these authority fields.
        Cleaning source existence/progress must be checked by its future adapter.
        """
        identifier(source_id)
        if kind not in {"SHIFT", "CLEANING_TASK"}:
            raise DomainError("INVALID_WORK_KIND")
        cls._lock_accounts(conn, {owner})
        member = conn.execute("""SELECT m.status, m.roles, a.status, a.verified_at FROM prsystem.staff_membership m
            JOIN prsystem.staff_account a ON a.id = m.account_id WHERE m.tenant_id = %s AND m.account_id = %s
            FOR SHARE OF m""", (tenant, owner)).fetchone()
        if member is None or member[0] != "ACTIVE" or member[2] != "ACTIVE" or member[3] is None:
            raise DomainError("ACCOUNT_NOT_ACTIVE_VERIFIED")
        hotel = conn.execute("""SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access
            WHERE tenant_id = %s FOR SHARE""", (tenant,)).fetchone()
        role = "RECEPTION" if kind == "SHIFT" else "CLEANER"
        facts = AccessFacts(tenant, True, True, True, role in member[1], kind == "SHIFT" or hotel[0] >= 25000, True, True, hotel[2])
        action, obligation = Action.CONFIGURE, None
        if refill_stay is not None:
            if kind!='CLEANING_TASK' or checkout_stay is not None or inspection_stay is not None:raise DomainError('INVALID_WORK_KIND')
            source=conn.execute("""SELECT s.check_in_recorded_at FROM prsystem.minibar_refill_request q
                JOIN prsystem.stay s ON(s.tenant_id,s.id)=(q.tenant_id,q.stay_id)
                JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(q.tenant_id,q.source_id)
                WHERE q.tenant_id=%s AND q.stay_id=%s AND t.id=%s AND t.assignee_id=%s AND t.state='OPEN' AND s.state='ACTIVE'
                AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_result x WHERE(x.tenant_id,x.request_id)=(q.tenant_id,q.id))""",(tenant,refill_stay,source_id,owner)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            from prsystem.subscription import Obligation, RootKind
            action,obligation=Action.CHECKOUT_REPORT,Obligation(tenant,refill_stay,RootKind.STAY,source[0],True)
        if inspection_stay is not None:
            if kind!='CLEANING_TASK' or checkout_stay is not None:raise DomainError('INVALID_WORK_KIND')
            source=conn.execute('''SELECT s.check_in_recorded_at FROM prsystem.minibar_guest_inspection e
                JOIN prsystem.stay s ON(s.tenant_id,s.id)=(e.tenant_id,e.stay_id)
                JOIN prsystem.reception_minibar_inspection i ON(i.tenant_id,i.stay_id)=(e.tenant_id,e.stay_id)
                JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
                WHERE e.tenant_id=%s AND e.stay_id=%s AND t.id=%s AND t.assignee_id=%s AND t.state='OPEN'
                AND s.state='ACTIVE' AND i.state='REQUESTED' AND e.revision=i.revision+1''',(tenant,inspection_stay,source_id,owner)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            from prsystem.subscription import Obligation, RootKind
            action,obligation=Action.CHECKOUT_REPORT,Obligation(tenant,inspection_stay,RootKind.STAY,source[0],True)
        if checkout_stay is not None:
            if kind != 'CLEANING_TASK':raise DomainError('INVALID_WORK_KIND')
            # A trusted adapter may register completion work only when this exact
            # task/owner/source is linked to an immutable, already closed stay.
            source = conn.execute("""SELECT s.check_in_recorded_at FROM prsystem.stay_checkout c
                JOIN prsystem.stay s ON (s.tenant_id,s.id)=(c.tenant_id,c.stay_id)
                JOIN prsystem.cleaning_source cs ON (cs.tenant_id,cs.id)=(c.tenant_id,c.cleaning_source_id)
                JOIN prsystem.cleaning_task t ON (t.tenant_id,t.source_id)=(cs.tenant_id,cs.id)
                WHERE c.tenant_id=%s AND c.stay_id=%s AND t.id=%s AND t.assignee_id=%s
                AND t.state='OPEN' AND s.state='CLOSED' AND cs.source_kind='CHECKOUT'
                AND cs.source_reference='checkout:'||c.stay_id""",(tenant,checkout_stay,source_id,owner)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            from prsystem.subscription import Obligation, RootKind
            action, obligation = Action.CHECKOUT_REPORT, Obligation(tenant,checkout_stay,RootKind.STAY,source[0],True)
        decision = subscription_gate(action, facts, hotel[1], conn.execute("SELECT clock_timestamp()").fetchone()[0], obligation)
        if not decision.allowed:
            raise DomainError(decision.code)
        previous = conn.execute("""SELECT id, owner_id, state FROM prsystem.staff_open_work
            WHERE tenant_id = %s AND kind = %s AND source_id = %s""", (tenant, kind, source_id)).fetchone()
        if previous:
            if previous[1:] != (owner, "OPEN"):
                raise DomainError("WORK_SOURCE_CONFLICT")
            return previous[0]
        work_id = secrets.token_hex(16)
        conn.execute("""INSERT INTO prsystem.staff_open_work (tenant_id, id, kind, source_id, owner_id, shift_id)
            VALUES (%s, %s, %s, %s, %s, %s)""", (tenant, work_id, kind, source_id, owner, source_id if kind == "SHIFT" else None))
        return work_id
