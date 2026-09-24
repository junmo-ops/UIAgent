# -*- coding: utf-8 -*-
"""Python 3.7+; standard library only. Input envelope is JSON on stdin."""
import json
import os
import sys

request = json.load(sys.stdin)
args = request['args']
if not isinstance(args.get('title'), str) or not isinstance(args.get('sections'), list):
    raise ValueError('title must be a string; sections must be an array')
lines = ['# ' + args['title'].replace('\n', ' '), '']
for section in args['sections']:
    if not isinstance(section.get('heading'), str) or not isinstance(section.get('items'), list):
        raise ValueError('each section needs heading and items')
    lines.extend(['## ' + section['heading'].replace('\n', ' '), ''])
    for item in section['items']:
        if not isinstance(item, str):
            raise ValueError('items must contain strings')
        lines.append('- ' + item.replace('\n', '\n  '))
    lines.append('')
with open(os.path.join(request['outputDir'], 'requirements.md'), 'w', encoding='utf-8') as output:
    output.write('\n'.join(lines))
print(json.dumps({'generated': 'requirements.md'}, ensure_ascii=False))
