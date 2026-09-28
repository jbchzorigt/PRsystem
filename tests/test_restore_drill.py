import tempfile
import unittest
from pathlib import Path
from postgres_support import ADMIN_DSN,PostgresCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict,make_conninfo
    from psycopg.types.json import Jsonb
    from prsystem.guest_identity import IdentityVault
    from scripts.restore_drill import restore


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RestoreDrillTests(PostgresCase):
    def test_encrypted_fixture_restore_checks_data_key_and_restricted_role(self):
        vault=IdentityVault({'fixture':b'e'*32},'fixture',b'l'*32)
        envelope=vault.seal(dict(test_value='synthetic-only'),'tenant-a','fixture')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('CREATE TABLE prsystem.restore_probe(tenant_id text PRIMARY KEY,envelope jsonb NOT NULL)')
            conn.execute('ALTER TABLE prsystem.restore_probe ENABLE ROW LEVEL SECURITY')
            conn.execute('ALTER TABLE prsystem.restore_probe FORCE ROW LEVEL SECURITY')
            conn.execute("CREATE POLICY probe_scope ON prsystem.restore_probe USING(tenant_id=current_setting('prsystem.tenant_id',true))")
            conn.execute('INSERT INTO prsystem.restore_probe VALUES(%s,%s),(%s,%s)',('tenant-a',Jsonb(envelope),'tenant-b',Jsonb(envelope)))
        with tempfile.TemporaryDirectory() as folder:
            target,result=restore(self.owner_dsn,ADMIN_DSN,b'b'*32,folder)
            try:
                self.assertTrue(result['data_equal']);self.assertTrue(result['migration_checksums_equal'])
                self.assertFalse(result['roles_verified'])
                with psycopg.connect(target) as conn:
                    row=conn.execute("SELECT envelope FROM prsystem.restore_probe WHERE tenant_id='tenant-a'").fetchone()[0]
                    self.assertEqual(vault.open(row,'tenant-a','fixture'),dict(test_value='synthetic-only'))
                    conn.execute(sql.SQL('GRANT USAGE ON SCHEMA prsystem TO {}').format(sql.Identifier(self.role)))
                    conn.execute(sql.SQL('GRANT SELECT ON prsystem.restore_probe TO {}').format(sql.Identifier(self.role)))
                scoped=make_conninfo(self.app_dsn,dbname=conninfo_to_dict(target)['dbname'])
                with psycopg.connect(scoped) as conn:
                    conn.execute("SELECT set_config('prsystem.tenant_id','tenant-a',true)")
                    self.assertEqual(conn.execute('SELECT tenant_id FROM prsystem.restore_probe').fetchall(),[('tenant-a',)])
                    self.assertEqual(conn.execute("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone(),(False,False))
                self.assertNotIn(b'synthetic-only',(Path(folder)/'fixture-backup.aesgcm').read_bytes())
            finally:
                with psycopg.connect(ADMIN_DSN,autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH(FORCE)').format(sql.Identifier(conninfo_to_dict(target)['dbname'])))
