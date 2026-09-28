"""Run every discovered test module in exactly one isolated CI shard."""
import argparse
import os
import sys
import unittest
from collections import Counter


def cases(suite):
    for item in suite:
        if isinstance(item,unittest.TestSuite):yield from cases(item)
        else:yield item


def partition(suite,count):
    groups=[unittest.TestSuite() for _ in range(count)]
    for index,module in enumerate(suite):groups[index%count].addTest(module)
    return groups


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--index',type=int,required=True);parser.add_argument('--count',type=int,required=True)
    args=parser.parse_args()
    if not 1<=args.count<=8 or not 0<=args.index<args.count:parser.error('Invalid shard bounds')
    if not os.environ.get('PRSYSTEM_TEST_ADMIN_DSN'):parser.error('A real disposable PostgreSQL service is required')
    suite=unittest.defaultTestLoader.discover('tests')
    expected=Counter(case.id() for case in cases(suite));groups=partition(suite,args.count)
    actual=Counter(case.id() for group in groups for case in cases(group))
    if actual!=expected or not expected:raise RuntimeError('Shard partition lost or duplicated tests')
    counts=[group.countTestCases() for group in groups]
    print(f'Discovered {sum(counts)} tests; shard counts {counts}; running shard {args.index}',flush=True)
    if not counts[args.index]:raise RuntimeError('Empty PostgreSQL shard')
    result=unittest.TextTestRunner(verbosity=2).run(groups[args.index])
    if result.skipped:print(f'ERROR: {len(result.skipped)} skipped tests are not database acceptance',file=sys.stderr)
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__=='__main__':raise SystemExit(main())
