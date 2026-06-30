const fs = require('fs');
const path = require('path');

function findInDir(dir, filter, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      findInDir(filePath, filter, fileList);
    } else if (filePath.endsWith('.d.ts')) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes(filter)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

const res = findInDir('node_modules/@google/genai', 'LiveServerMessage');
console.log(res);

if(res.length > 0) {
  const content = fs.readFileSync(res[0], 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.includes('LiveServerMessage'));
  console.log(lines.slice(Math.max(0, start - 5), start + 40).join('\n'));
}
