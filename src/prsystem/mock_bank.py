"""Explicit local bank controls; never exposed as business HTTP paid flags."""
import secrets
from datetime import datetime,timezone
from prsystem.common import DomainError,money


class MockBankGateway:
    is_mock=True
    def __init__(self,store):
        self.store=store
        with store.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS mock_bank_credit(tenant TEXT,provider TEXT,merchant TEXT,payment TEXT,amount INTEGER,fee INTEGER,chargeback INTEGER DEFAULT 0,disputed INTEGER DEFAULT 0,revision INTEGER DEFAULT 1,PRIMARY KEY(tenant,provider,merchant,payment));
            CREATE TABLE IF NOT EXISTS mock_bank_beneficiary(tenant TEXT PRIMARY KEY,reference TEXT,active INTEGER);
            CREATE TABLE IF NOT EXISTS mock_bank_payout(id TEXT PRIMARY KEY,tenant TEXT,beneficiary TEXT,amount INTEGER,state TEXT DEFAULT 'PENDING',reference TEXT UNIQUE,confirmed REAL);''')
    def record_credit(self,tenant,provider,merchant,payment,amount,fee):
        money(amount,positive=True);money(fee)
        with self.store.connect() as c:
            c.execute('INSERT OR IGNORE INTO mock_bank_credit(tenant,provider,merchant,payment,amount,fee) VALUES(?,?,?,?,?,?)',(tenant,provider,merchant,payment,amount,fee))
            r=c.execute('SELECT amount,fee FROM mock_bank_credit WHERE tenant=? AND provider=? AND merchant=? AND payment=?',(tenant,provider,merchant,payment)).fetchone()
            if tuple(r)!=(amount,fee):raise DomainError('IDEMPOTENCY_CONFLICT')
    def dispute(self,tenant,payment,*,opened,chargeback):
        money(chargeback)
        with self.store.connect() as c:
            if not c.execute('UPDATE mock_bank_credit SET disputed=?,chargeback=?,revision=revision+1 WHERE tenant=? AND payment=? AND amount>=?',(int(opened),chargeback,tenant,payment,chargeback)).rowcount:raise DomainError('WORK_SOURCE_NOT_FOUND')
    def credit(self,tenant,provider,merchant,payment):
        with self.store.connect() as c:
            r=c.execute('SELECT * FROM mock_bank_credit WHERE tenant=? AND provider=? AND merchant=? AND payment=?',(tenant,provider,merchant,payment)).fetchone()
            return dict(r) if r else None
    def set_beneficiary(self,tenant,reference,active=True):
        with self.store.connect() as c:c.execute('INSERT INTO mock_bank_beneficiary VALUES(?,?,?) ON CONFLICT(tenant) DO UPDATE SET reference=excluded.reference,active=excluded.active',(tenant,reference,int(active)))
    def beneficiary(self,tenant,reference):
        with self.store.connect() as c:return bool(c.execute('SELECT 1 FROM mock_bank_beneficiary WHERE tenant=? AND reference=? AND active=1',(tenant,reference)).fetchone())
    def create_payout(self,identity,tenant,beneficiary,amount):
        money(amount,positive=True)
        if not self.beneficiary(tenant,beneficiary):raise DomainError('BANK_BENEFICIARY_UNVERIFIED')
        with self.store.connect() as c:
            c.execute('INSERT OR IGNORE INTO mock_bank_payout(id,tenant,beneficiary,amount,reference) VALUES(?,?,?,?,?)',(identity,tenant,beneficiary,amount,'mock-bank:'+secrets.token_hex(16)))
            r=c.execute('SELECT tenant,beneficiary,amount FROM mock_bank_payout WHERE id=?',(identity,)).fetchone()
            if tuple(r)!=(tenant,beneficiary,amount):raise DomainError('IDEMPOTENCY_CONFLICT')
    def set_payout_status(self,identity,state):
        if state not in {'PENDING','UNKNOWN','FAILED','SUCCEEDED'}:raise ValueError('Invalid mock bank state')
        with self.store.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            r=c.execute('SELECT * FROM mock_bank_payout WHERE id=?',(identity,)).fetchone()
            if not r:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if r['state'] in {'SUCCEEDED','FAILED'}:
                if r['state']!=state:raise DomainError('PAYOUT_TERMINAL')
                return
            if state=='SUCCEEDED':
                credits=c.execute('SELECT coalesce(sum(amount-fee-chargeback),0) FROM mock_bank_credit').fetchone()[0]
                refunds=c.execute("SELECT coalesce(sum(r.amount),0) FROM mock_refund r WHERE r.state='SUCCEEDED' AND EXISTS(SELECT 1 FROM mock_bank_credit b WHERE b.payment=r.original AND b.provider=r.provider)").fetchone()[0]
                payouts=c.execute("SELECT coalesce(sum(amount),0) FROM mock_bank_payout WHERE state='SUCCEEDED'").fetchone()[0]
                if credits-refunds-payouts<r['amount']:raise DomainError('BANK_FUNDS_INSUFFICIENT')
            c.execute('UPDATE mock_bank_payout SET state=?,confirmed=? WHERE id=?',(state,self.store.clock() if state in {'FAILED','SUCCEEDED'} else None,identity))
    def payout(self,identity):
        with self.store.connect() as c:r=c.execute('SELECT * FROM mock_bank_payout WHERE id=?',(identity,)).fetchone()
        if not r:raise DomainError('PROVIDER_EVIDENCE_INVALID')
        return dict(r)|dict(confirmed_at=datetime.fromtimestamp(r['confirmed'],timezone.utc) if r['confirmed'] else None,currency='MNT')

    def cancel_payout(self,identity):
        with self.store.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            r=c.execute('SELECT state FROM mock_bank_payout WHERE id=?',(identity,)).fetchone()
            if not r:return
            if r['state']=='SUCCEEDED':raise DomainError('PAYOUT_TERMINAL')
            if r['state']!='FAILED':c.execute("UPDATE mock_bank_payout SET state='FAILED',confirmed=? WHERE id=?",(self.store.clock(),identity))
