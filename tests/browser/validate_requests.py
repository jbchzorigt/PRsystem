"""Validate browser-generated command payloads against the real FastAPI models."""
import json
import sys
from prsystem.api import create_app
app=create_app('postgresql://unused:unused@localhost/prsystem_test_contract')
count=0
for item in json.load(open(sys.argv[1])):
    if item.get('body') is None:continue
    path='/hotels/test-hotel/'+item['tail']
    route=next(r for r in app.routes if hasattr(r,'path_regex') and r.path_regex.fullmatch(path) and item['method'] in r.methods)
    fields=route.dependant.body_params
    if fields:fields[0].type_.model_validate(item['body'])
    count+=1
assert count>=5,count
print(f'{count} browser commands match actual API models')
