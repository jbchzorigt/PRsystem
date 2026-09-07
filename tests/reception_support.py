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
