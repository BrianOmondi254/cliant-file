const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'general.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const stdTrustees = 3;
const stdOfficials = 3;

function processGroup(group) {
    const keys = Object.keys(group);
    
    // Collect roles
    const trustees = keys.filter(k => k.startsWith('trustee_')).map(k => ({ oldKey: k, obj: group[k] })).sort((a,b) => parseInt(a.oldKey.split('_')[1]) - parseInt(b.oldKey.split('_')[1]));
    const officials = keys.filter(k => k.startsWith('official_')).map(k => ({ oldKey: k, obj: group[k] })).sort((a,b) => parseInt(a.oldKey.oldKey?.split('_')[1] || a.oldKey.split('_')[1]) - parseInt(b.oldKey.oldKey?.split('_')[1] || b.oldKey.split('_')[1]));
    const members = keys.filter(k => k.startsWith('member_')).map(k => ({ oldKey: k, obj: group[k] })).sort((a,b) => parseInt(a.oldKey.oldKey?.split('_')[1] || a.oldKey.split('_')[1]) - parseInt(b.oldKey.oldKey?.split('_')[1] || b.oldKey.split('_')[1]));

    // Remove old keys first
    trustees.forEach(t => delete group[t.oldKey]);
    officials.forEach(o => delete group[o.oldKey]);
    members.forEach(m => delete group[m.oldKey]);

    // Re-add with new keys and matching indices
    trustees.forEach((t, i) => {
        const index = (i+1).toString();
        const newKey = `trustee_${index}`;
        delete t.obj.index; // Remove redundant index numbering from data
        group[newKey] = t.obj;
    });

    officials.forEach((o, i) => {
        const index = (stdTrustees + i + 1).toString();
        const newKey = `official_${index}`;
        delete o.obj.index; // Remove redundant index numbering from data
        group[newKey] = o.obj;
    });

    members.forEach((m, i) => {
        const index = (stdTrustees + stdOfficials + i + 1).toString();
        const newKey = `member_${index}`;
        delete m.obj.index; // Remove redundant index numbering from data
        group[newKey] = m.obj;
    });
}

for (const county in data) {
    for (const constituency in data[county]) {
        for (const ward in data[county][constituency]) {
            data[county][constituency][ward].forEach(processGroup);
        }
    }
}

fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
console.log('Key reorganization complete.');
