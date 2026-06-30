const fs = require('fs');
const content = fs.readFileSync('node_modules/@google/genai/dist/genai.d.ts', 'utf8');
const lines = content.split('\n');
const starts = [];
lines.forEach((l, i) => { if (l.includes('LiveServerMessage {')) starts.push(i); });
console.log('Found LiveServerMessage at', starts);
if (starts.length > 0) {
  console.log(lines.slice(starts[0] - 2, starts[0] + 50).join('\n'));
} else {
  // try generic export declare interface LiveServerMessage
  const i = lines.findIndex(l => l.includes('export declare interface LiveServerMessage'));
  if (i !== -1) {
    console.log(lines.slice(i, i + 50).join('\n'));
  }
}
