import json
import os

path = r'c:\Users\Brian\Desktop\cliant\general.json'

with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)

std_trustees = 3
std_officials = 3

def process_group(group):
    # 1. Collect roles
    trustees = []
    officials = []
    members = []
    
    # Identify keys
    keys = list(group.keys())
    for key in keys:
        if key.startswith('trustee_'):
            trustees.append((key, group[key]))
        elif key.startswith('official_'):
            officials.append((key, group[key]))
        elif key.startswith('member_'):
            members.append((key, group[key]))
            
    # Sort them by their original indices if possible, or key name
    trustees.sort(key=lambda x: int(x[0].split('_')[1]))
    officials.sort(key=lambda x: int(x[0].split('_')[1]))
    members.sort(key=lambda x: int(x[0].split('_')[1]))
    
    # 2. Re-assign indices
    # Trustees always 1-3
    for i, (key, obj) in enumerate(trustees):
        obj['index'] = str(i + 1)
        
    # Officials always start at 4
    for i, (key, obj) in enumerate(officials):
        obj['index'] = str(std_trustees + i + 1)
        
    # Members always start at 7 (std_trustees + std_officials + 1)
    for i, (key, obj) in enumerate(members):
        obj['index'] = str(std_trustees + std_officials + i + 1)
        
    return group

# Recursively traverse the hierarchy
for county in data:
    for constituency in data[county]:
        for ward in data[county][constituency]:
            groups = data[county][constituency][ward]
            for group in groups:
                process_group(group)

with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)

print("Reorganization complete.")
