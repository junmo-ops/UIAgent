# -*- coding: utf-8 -*-
"""Skill execution report; Python 3.7+ and standard library only."""
import hashlib
import json
import os
import platform
import sys
import uuid
from datetime import datetime, timezone


def main():
    request = json.load(sys.stdin)
    text = request['args']['text']
    if not isinstance(text, str):
        raise ValueError('args.text must be a string')
    encoded = text.encode('utf-8')
    report = {
        'execution_id': str(uuid.uuid4()),
        'executed_at_utc': datetime.now(timezone.utc).isoformat(),
        'python_version': platform.python_version(),
        'input_text': text,
        'character_count': len(text),
        'utf8_bytes': len(encoded),
        'sha256': hashlib.sha256(encoded).hexdigest()
    }
    filename = 'execution-report.json'
    with open(os.path.join(request['outputDir'], filename), 'w', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({'artifact': filename, 'execution_id': report['execution_id']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
