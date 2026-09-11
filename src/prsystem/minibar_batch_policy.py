"""Derived batch progress; no caller can overwrite a child outcome."""
import hashlib
import json

STATES = ('READY_FOR_RECONCILIATION','SCHEDULED_AFTER_STAY','IN_PROGRESS',
          'BLOCKED_STOCK','BLOCKED_VARIANCE','APPLIED','SKIPPED','CANCELLED',
          'ROLLBACK_REQUIRED','ROLLED_BACK')
TERMINAL = {'APPLIED','CANCELLED','ROLLED_BACK'}

def progress(items):
    counts = dict.fromkeys(STATES, 0)
    for item in items:
        counts[item['state']] += 1
    counts['selected'] = len(items)
    counts['accepted'] = len(items) - counts['SKIPPED']
    if not counts['accepted']:
        state = 'FAILED_VALIDATION'
    elif any(i['state'] not in TERMINAL | {'SKIPPED'} for i in items):
        state = 'IN_PROGRESS'
    elif counts['APPLIED'] == counts['selected']:
        state = 'COMPLETED'
    elif counts['CANCELLED'] == counts['accepted']:
        state = 'CANCELLED'
    else:
        state = 'PARTIALLY_COMPLETED'
    revision = hashlib.sha256(json.dumps([(i['room_id'],i['state'],i['revision']) for i in items],
                                         separators=(',',':')).encode()).hexdigest()
    return dict(state=state,counts=counts,revision=revision)

