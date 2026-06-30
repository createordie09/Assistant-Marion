const fs = require('fs');
const content = fs.readFileSync('node_modules/@google/genai/dist/index.d.ts', 'utf8');
console.log(content.substring(0, 100));
