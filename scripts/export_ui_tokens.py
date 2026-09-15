"""Export this project's deliberately small DESIGN token subset; no dependencies."""
import re
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
text = (root / 'DESIGN.md').read_text()
colors = dict(re.findall(r'^  ([\w-]+): "(#[a-f0-9]{6})"$', text, re.M))
style = root / 'src/prsystem/static/staff.css'
css = style.read_text()
for name, value in colors.items():
    pattern = rf'(--{name}: )#[a-f0-9]{{6}}'
    css, count = re.subn(pattern, rf'\g<1>{value}', css)
    if count != 1:
        raise SystemExit(f'Token mapping missing or duplicate: {name}')
# Other documented tokens are explicit CSS mappings; enforce exact values.
for pattern in ['--radius: .5rem', '--space: 1rem', '--measure: 34rem',
                '--font-body: "Segoe UI", "Noto Sans", Arial, sans-serif',
                '--font-display: "Trebuchet MS", "Segoe UI", Arial, sans-serif']:
    if pattern not in css:
        raise SystemExit('Typography/geometry mapping changed: update exporter and DESIGN together')
if '--check' in sys.argv:
    if css != style.read_text():
        raise SystemExit('Run scripts/export_ui_tokens.py to regenerate color tokens')
else:
    style.write_text(css)
