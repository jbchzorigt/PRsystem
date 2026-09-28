"""Encrypted backup/restore drill on disposable test databases only.

Credentials stay in environment variables. The tool never targets or drops an
existing database, and never writes an unencrypted backup to disk.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import time
from datetime import datetime,timezone
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict,make_conninfo
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def pg_tool(name,args,dsn,stdin=None):
    info=conninfo_to_dict(dsn);env=os.environ.copy()
    mapping={'host':'PGHOST','port':'PGPORT','dbname':'PGDATABASE','user':'PGUSER','password':'PGPASSWORD','sslmode':'PGSSLMODE'}
    for field,var in mapping.items():
        if field in info:env[var]=info[field]
        else:env.pop(var,None)
    command=[name,*args];container=os.environ.get('PRSYSTEM_PG_CONTAINER_ID')
    if container:
        if not re.fullmatch(r'[a-f0-9]{12,64}',container):raise ValueError('Invalid disposable PostgreSQL container')
        command=['docker','exec','-i',*[part for var in mapping.values() if var in env for part in ['-e',var]],container,*command]
    result=subprocess.run(command,input=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=300,check=False)
    if result.returncode:raise RuntimeError(f'{name} failed with exit code {result.returncode}; inspect isolated worker logs without credentials')
    if len(result.stdout)>100_000_000:raise RuntimeError('Fixture backup exceeded 100 MB limit')
    return result.stdout


def fingerprints(conn):
    conn.execute("SET LOCAL TIME ZONE 'UTC'")
    tables=conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='prsystem' ORDER BY tablename").fetchall();result={}
    for (table,) in tables:
        digest=hashlib.sha256();count=0
        query=sql.SQL('SELECT to_jsonb(t)::text FROM prsystem.{} t ORDER BY to_jsonb(t)::text').format(sql.Identifier(table))
        for (row,) in conn.execute(query):digest.update(row.encode()+b'\n');count+=1
        result[table]=dict(rows=count,sha256=digest.hexdigest())
    return result


def restore(source,admin,key,directory):
    info=conninfo_to_dict(source)
    if not re.fullmatch(r'prsystem_test_[a-zA-Z0-9_]+',info.get('dbname','')):raise ValueError('Source must be a disposable prsystem_test_* fixture')
    if len(key)!=32:raise ValueError('Backup encryption requires a 32-byte key')
    target='prsystem_restore_'+uuid4().hex;target_dsn=make_conninfo(admin,dbname=target)
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    started=time.monotonic()
    with psycopg.connect(source) as conn:
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        snapshot=conn.execute('SELECT pg_export_snapshot()').fetchone()[0]
        before=fingerprints(conn)
        checksums=conn.execute('SELECT name,checksum FROM prsystem.schema_migrations ORDER BY name').fetchall()
        dump=pg_tool('pg_dump',['--format=custom','--no-owner','--no-privileges','--snapshot='+snapshot],source)
    nonce=secrets.token_bytes(12);encrypted=nonce+AESGCM(key).encrypt(nonce,dump,b'prsystem-restore-drill-v1');del dump
    archive=directory/'fixture-backup.aesgcm';fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as file:file.write(encrypted)
    created=False
    try:
        with psycopg.connect(admin,autocommit=True) as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)));created=True
        payload=archive.read_bytes();plain=AESGCM(key).decrypt(payload[:12],payload[12:],b'prsystem-restore-drill-v1')
        pg_tool('pg_restore',['--no-owner','--no-privileges','--single-transaction','--exit-on-error','--dbname='+target],target_dsn,plain);del plain
        with psycopg.connect(target_dsn) as conn:
            after=fingerprints(conn)
            migrated=conn.execute('SELECT name,checksum FROM prsystem.schema_migrations ORDER BY name').fetchall()
        result=dict(status='DATA_RESTORED' if before==after and checksums==migrated else 'FAIL',recorded_at=datetime.now(timezone.utc).isoformat(),
            data_equal=before==after,migration_checksums_equal=checksums==migrated,tables=len(before),rows=sum(v['rows'] for v in before.values()),
            elapsed_seconds=round(time.monotonic()-started,3),encrypted_backup_sha256=hashlib.sha256(encrypted).hexdigest(),
            roles_verified=False,key_recovery_verified=False,scope='Disposable fixture. Role and identity-key recovery acceptance must be verified separately.')
        return target_dsn,result
    except BaseException:
        if created:
            with psycopg.connect(admin,autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH(FORCE)').format(sql.Identifier(target)))
        raise


def main():
    p=argparse.ArgumentParser();p.add_argument('--output-directory',type=Path,required=True);a=p.parse_args()
    key=base64.b64decode(os.environ['PRSYSTEM_BACKUP_KEY'],validate=True)
    target,result=restore(os.environ['PRSYSTEM_RESTORE_SOURCE_DSN'],os.environ['PRSYSTEM_TEST_ADMIN_DSN'],key,a.output_directory)
    try:(a.output_directory/'restore-result.json').write_text(json.dumps(result,indent=2));print(result['status'])
    finally:
        name=conninfo_to_dict(target)['dbname']
        with psycopg.connect(os.environ['PRSYSTEM_TEST_ADMIN_DSN'],autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH(FORCE)').format(sql.Identifier(name)))


if __name__=='__main__':main()
