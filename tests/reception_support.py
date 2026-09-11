from operational_support import OperationalCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql


class ReceptionCase(OperationalCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT ON prsystem.shift_takeover TO {}',
                'GRANT SELECT,INSERT ON prsystem.shift_policy,prsystem.shift_handover,prsystem.handover_count,prsystem.cash_custody TO {}',
                'GRANT UPDATE(single_worker,revision,configured_by) ON prsystem.shift_policy TO {}',
                'GRANT UPDATE(state,decided_at,decision_reason,new_shift_id) ON prsystem.shift_handover TO {}',
                'GRANT UPDATE(state,released_at) ON prsystem.cash_custody TO {}',
                'GRANT UPDATE(state,closed_at,review_state) ON prsystem.reception_shift TO {}',
                'GRANT SELECT,INSERT ON prsystem.room_lifecycle_intent,prsystem.room_lifecycle_completion TO {}',
                'GRANT SELECT ON prsystem.reception_dependency_blocker TO {}',
                'GRANT EXECUTE ON FUNCTION prsystem.room_blockers(text,text),prsystem.category_blockers(text,text),prsystem.complete_room_retirement(text) TO {}',
                'GRANT UPDATE(status) ON prsystem.room_category TO {}',
                'GRANT UPDATE(status,category_id) ON prsystem.room TO {}',
                'GRANT SELECT,INSERT ON prsystem.room_readiness_event TO {}',
                'GRANT USAGE ON SEQUENCE prsystem.room_readiness_event_sequence_seq TO {}',
                'GRANT SELECT,INSERT ON prsystem.cash_location_config,prsystem.cash_initial_opening,prsystem.cash_shift_reference,prsystem.reception_shift,prsystem.room_hotel_settings,prsystem.room_category,prsystem.room TO {}',
                'GRANT UPDATE (code,name,physical_location,expected_float,status,revision,configured_by) ON prsystem.cash_location_config TO {}',
                'GRANT UPDATE (review_state) ON prsystem.cash_initial_opening TO {}',
                'GRANT INSERT ON prsystem.cash_drawer,prsystem.cash_event,prsystem.cash_outbox TO {}',
                'GRANT UPDATE (shift_id,posted) ON prsystem.cash_drawer TO {}',
                'GRANT UPDATE (revision) ON prsystem.cash_book TO {}',
                'GRANT UPDATE (hourly_price,nightly_price,checkout_time,revision) ON prsystem.room_hotel_settings TO {}',
                'GRANT UPDATE (hourly_price,nightly_price,revision) ON prsystem.room_category,prsystem.room TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))
