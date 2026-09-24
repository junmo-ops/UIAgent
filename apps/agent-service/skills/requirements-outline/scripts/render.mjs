let input = '';
for await (const chunk of process.stdin) input += chunk;
const { args, outputDir } = JSON.parse(input);
if (typeof args.title !== 'string' || !Array.isArray(args.sections)) throw new Error('title must be a string; sections must be an array');
const lines = [`# ${args.title.replaceAll('\n', ' ')}`, ''];
for (const section of args.sections) {
  if (typeof section.heading !== 'string' || !Array.isArray(section.items)) throw new Error('each section needs heading and items');
  lines.push(`## ${section.heading.replaceAll('\n', ' ')}`, '');
  for (const item of section.items) {
    if (typeof item !== 'string') throw new Error('items must contain strings');
    lines.push(`- ${item.replaceAll('\n', '\n  ')}`);
  }
  lines.push('');
}
const { writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
await writeFile(join(outputDir, 'requirements.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ generated: 'requirements.md' }));
