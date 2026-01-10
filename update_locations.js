const fs = require('fs');

const locations = JSON.parse(fs.readFileSync('locations.json', 'utf8'));

for (const county in locations) {
  for (const constituency in locations[county]) {
    const wards = locations[county][constituency];
    locations[county][constituency] = {
      wards: wards,
      county: county
    };
  }
}

fs.writeFileSync('locations.json', JSON.stringify(locations, null, 2));
console.log('Updated locations.json');
