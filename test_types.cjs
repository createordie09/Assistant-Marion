const fs = require('fs');
const content = fs.readFileSync('node_modules/@google/genai/dist/genai.d.ts', 'utf8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('interface LiveServerMessage'));
if (start !== -1) {
  console.log(lines.slice(start, start + 30).join('\n'));
} else {
  console.log("Not found in genai.d.ts");
}
