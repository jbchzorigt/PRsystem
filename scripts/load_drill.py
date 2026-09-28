"""Bounded read-only load drill against an explicitly configured local pilot."""
import argparse
import json
import math
import os
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
try:
    import httpx2 as httpx
except ModuleNotFoundError:
    import httpx


def run(base,path,token,samples,concurrency,budget):
    u=urlsplit(base)
    if u.hostname not in {'127.0.0.1','localhost','::1'} or u.scheme!='http' or u.username or u.password or u.query or u.fragment:raise ValueError('Use a local pilot server')
    if not path.startswith(('/platform/operation','/hotels/')) or '?' in path or '..' in path:raise ValueError('Use an authenticated, read-only dashboard route')
    if not 1<=samples<=10000 or not 1<=concurrency<=32 or budget<=0:raise ValueError('Invalid drill bounds')
    def sample(_):
        start=time.monotonic()
        try:
            with httpx.Client(timeout=10,follow_redirects=False,trust_env=False) as client:
                response=client.get(base.rstrip('/')+path,headers={'Authorization':'Bearer '+token})
                response.json();success=response.status_code==200
        except (httpx.HTTPError,ValueError):success=False
        return (time.monotonic()-start)*1000,success
    with ThreadPoolExecutor(max_workers=concurrency) as pool:results=list(pool.map(sample,range(samples)))
    times=sorted(r[0] for r in results);errors=sum(not r[1] for r in results);p95=times[math.ceil(.95*len(times))-1]
    return dict(status='PASS' if errors==0 and p95<=budget else 'FAIL',recorded_at=datetime.now(timezone.utc).isoformat(),samples=samples,concurrency=concurrency,errors=errors,
        p95_ms=round(p95,2),median_ms=round(statistics.median(times),2),budget_p95_ms=budget,scope='Local read-only pilot; no claim about production capacity')


def main():
    p=argparse.ArgumentParser();p.add_argument('--base-url',required=True);p.add_argument('--path',required=True);p.add_argument('--samples',type=int,default=100);p.add_argument('--concurrency',type=int,default=8);p.add_argument('--budget-p95-ms',type=float,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();result=run(a.base_url,a.path,os.environ['PRSYSTEM_LOAD_BEARER'],a.samples,a.concurrency,a.budget_p95_ms);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(result['status']);return 0 if result['status']=='PASS' else 1


if __name__=='__main__':raise SystemExit(main())
