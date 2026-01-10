const fs = require('fs');
const path = require('path');

const generalFile = path.join(__dirname, 'general.json');
console.log('Path:', generalFile);

const readJSON = (file, fallback) => {
  if (!fs.existsSync(file)) {
      console.log('File does not exist');
      return fallback;
  }
  const data = fs.readFileSync(file, 'utf8');
  console.log('Raw Data Length:', data.length);
  try {
    return data ? JSON.parse(data) : fallback;
  } catch (e) {
      console.log('Parse error:', e);
      return fallback;
  }
};

const accounts = readJSON(generalFile, []);
console.log('Accounts found:', accounts.length);
if (accounts.length > 0) {
    console.log('First Group:', accounts[0].groupName);
}
