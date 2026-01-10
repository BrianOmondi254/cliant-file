 const fs = require('fs');

let data = fs.readFileSync('locations.json', 'utf8');

// Remove any trailing backticks or extra characters
data = data.replace(/```$/gm, '');

const locations = JSON.parse(data);

for (const county in locations) {
  for (const constituency in locations[county]) {
    const wards = locations[county][constituency];
    if (Array.isArray(wards)) {
      locations[county][constituency] = {
        wards: wards,
        county: county
      };
    }
  }
}

fs.writeFileSync('locations.json', JSON.stringify(locations, null, 2));
console.log('Updated locations.json completely');
