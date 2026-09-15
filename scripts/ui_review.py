"""Run the real UI/API against a disposable local PostgreSQL review fixture."""
from contextlib import contextmanager
import argparse
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]


def require_local_database(dsn):
    from psycopg.conninfo import conninfo_to_dict
    info = conninfo_to_dict(dsn)
    for field in ('host', 'hostaddr'):
        value = info.get(field, '')
        if value and value not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('UI review requires a single loopback PostgreSQL host')
    if info.get('service') or info.get('dbname') != 'postgres':
        raise ValueError('UI review creates its own database from the local postgres maintenance database')
    # libpq environment must not supply a different network destination.
    if any(os.environ.get(key) for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGHOST')):
        raise ValueError('Unset PG service/host overrides before starting UI review')
    if not info.get('host'):
        raise ValueError('An explicit loopback PostgreSQL host is required')
    return dsn


@contextmanager
def disposable_postgres():
    """Own exactly one named container, no host volume or published non-loopback port."""
    if not shutil.which('docker'):
        raise RuntimeError('Docker Desktop/Docker is required. Start Docker, then run this command again.')
    import psycopg
    from psycopg.conninfo import make_conninfo
    name = 'prsystem-ui-review-' + uuid4().hex
    env = {**os.environ, 'POSTGRES_PASSWORD': secrets.token_urlsafe(24)}
    created = False
    try:
        result = subprocess.run(['docker', 'run', '--detach', '--rm', '--name', name,
            '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD',
            '--label', 'prsystem.purpose=disposable-ui-review', 'postgres:17'],
            env=env, capture_output=True, text=True, timeout=240)
        if result.returncode:
            raise RuntimeError('Could not start the disposable PostgreSQL container. Check Docker and image availability.')
        created = True
        binding = subprocess.check_output(['docker', 'port', name, '5432/tcp'], text=True, timeout=15).strip()
        host, port = binding.rsplit(':', 1)
        if host != '127.0.0.1' or not port.isdigit():
            raise RuntimeError('Unexpected PostgreSQL port binding')
        dsn = make_conninfo(host=host, port=port, dbname='postgres', user='postgres', password=env['POSTGRES_PASSWORD'])
        require_local_database(dsn)
        deadline = time.monotonic() + 45
        while True:
            try:
                with psycopg.connect(dsn, connect_timeout=2):
                    break
            except psycopg.OperationalError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Disposable PostgreSQL did not become ready') from None
                time.sleep(0.25)
        yield dsn
    finally:
        # Also remove an ambiguously started container if docker run was interrupted.
        if shutil.which('docker'):
            result = subprocess.run(['docker', 'rm', '--force', name], capture_output=True, timeout=30)
            if result.returncode and created:
                print('Could not remove this review container. Run: docker rm --force ' + name, file=sys.stderr)
                raise RuntimeError('Disposable review container cleanup failed')


def load_session(dsn):
    require_local_database(dsn)
    existing = os.environ.get('PRSYSTEM_TEST_ADMIN_DSN')
    if existing and existing != dsn:
        raise ValueError('A different test database is already configured; use a fresh terminal')
    os.environ['PRSYSTEM_TEST_ADMIN_DSN'] = dsn
    tests = str(ROOT / 'tests')
    if tests not in sys.path:
        sys.path.insert(0, tests)
    from ui_review_support import review_session
    return review_session(dsn)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Local UI review with synthetic data and a disposable PostgreSQL database. No live providers.')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--check', action='store_true', help='Verify role logins and owning reads, then remove the fixture')
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    try:
        # Refuse to bootstrap a database when the UI port is already occupied.
        if not args.check:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', args.port))
        import uvicorn
        print('Preparing a disposable UI review hotel. No live messages or payments.', flush=True)
        with disposable_postgres() as dsn, load_session(dsn) as session:
            session.verify()
            if args.check:
                print('UI_REVIEW_CHECK_PASSED: three isolated roles, real API, PostgreSQL and mock-only mode.')
                return 0
            print('\nOpen http://127.0.0.1:' + str(args.port) + '/reception', flush=True)
            print('Буудлын код: ' + session.tenant)
            for role, email in session.accounts.items():
                print(role + ': ' + email)
            print('Түр нууц үг (зөвхөн энэ туршилт): ' + session.password)
            print('101: зочин бүртгэхэд бэлэн. 201: цэвэрлэгчид оноосон ажил.')
            print('Заавар: docs/76-ui-review-session.md')
            print('Ctrl+C: зогсоож, зөвхөн энэ туршилтын бааз/container-ийг устгана. Дараагийн асаалт шинэ өгөгдөлтэй.', flush=True)
            uvicorn.run(session.app, host='127.0.0.1', port=args.port, proxy_headers=False, access_log=False)
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        # Do not print connection strings, generated passwords or driver exceptions.
        print('UI_REVIEW_FAILED (' + type(exc).__name__ + '). Check Docker, dependencies and that the selected port is free. See docs/76-ui-review-session.md.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
