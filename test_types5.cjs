const fs = require('fs');
const content = fs.readFileSync('node_modules/@google/genai/dist/genai.d.ts', 'utf8');
const lines = content.split('\n');
const i = lines.findIndex(l => l.includes('export declare interface Transcription'));
if (i !== -1) {
  console.log(lines.slice(i, i + 30).join('\n'));
}
