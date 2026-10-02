import json
import os
import sys
import time
import hashlib
from pathlib import Path

envelope = json.load(sys.stdin)
args = envelope['args']
Path(args['marker']).write_text(json.dumps({'pid': os.getpid(), 'outputDir': envelope['outputDir']}))
mode = args['mode']
if mode == 'failure':
    sys.stderr.write('E2E deliberate script failure\n')
    sys.exit(7)
if mode in ('timeout', 'cancel'):
    time.sleep(60)
text = args['text']
report = {'text': text, 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(), 'pid': os.getpid()}
Path(envelope['outputDir'], 'report.json').write_text(json.dumps(report))
print('E2E Python completed')
