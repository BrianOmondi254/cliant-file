const path = require('path');
const fs = require('fs');

console.log("__dirname:", __dirname);
const generalFile = path.join(__dirname, "../general.json");
console.log("Resolved Path:", generalFile);
console.log("Exists:", fs.existsSync(generalFile));

try {
  const content = fs.readFileSync(generalFile, 'utf8');
  console.log("Content Length:", content.length);
  const json = JSON.parse(content);
  console.log("Parsed Items:", json.length);
} catch(e) {
  console.error("Error:", e.message);
}
