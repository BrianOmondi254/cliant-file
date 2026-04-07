    // ─── SHOW VERIFICATION FORM ──────────────────────────────
    function showVerificationForm() {
      const list = document.getElementById('verificationList');
      
      // Collect all member data from form inputs
      const membersToVerify = [];
      
      // Trustee 1
      membersToVerify.push({
        key: 'trustee_1',
        phone: document.getElementById('t1_phone').value.trim(),
        id: document.getElementById('t1_id').value.trim(),
        role: 'trustee',
        title: 'Chairperson',
        index: '1'
      });
      
      // Trustee 2
      membersToVerify.push({
        key: 'trustee_2',
        phone: document.getElementById('t2_phone').value.trim(),
        id: document.getElementById('t2_id').value.trim(),
        role: 'trustee',
        title: 'Treasurer',
        index: '2'
      });
      
      // Trustee 3
      membersToVerify.push({
        key: 'trustee_3',
        phone: document.getElementById('t3_phone').value.trim(),
        id: document.getElementById('t3_id').value.trim(),
        role: 'trustee',
        title: 'Secretary',
        index: '3'
      });
      
      // Officials
      for (let i = 0; i < currentOfficialsCount; i++) {
        const idx = STD_TRUSTEES + i + 1;
        membersToVerify.push({
          key: `official_${idx}`,
          phone: document.getElementById(`official_${idx}_phone`).value.trim(),
          id: document.getElementById(`official_${idx}_id`).value.trim(),
          role: 'official',
          title: document.getElementById(`official_${idx}_title`).value.trim() || 'No Title',
          index: String(idx)
        });
      }
      
      // Regular Members
      for (let i = 0; i < regularMembersCount; i++) {
        const idx = STD_TRUSTEES + currentOfficialsCount + i + 1;
        membersToVerify.push({
          key: `member_${idx}`,
          phone: document.getElementById(`member_${idx}_phone`).value.trim(),
          id: document.getElementById(`member_${idx}_id`).value.trim(),
          role: 'member',
          title: 'Member',
          index: String(idx)
        });
      }
      
      console.log('Sending', membersToVerify.length, 'members for verification');
      
      // Call API to verify members against data.json
      fetch('/general/api/verify-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: membersToVerify })
      })
        .then(r => r.json())
        .then(apiResponse => {
          if (!apiResponse.success) {
            console.warn('⚠ API returned error:', apiResponse.error);
            showNotification('Failed to verify members. Please try again.', 'error');
            return;
          }
          
          const verifiedMembers = apiResponse.members;
          console.log('✓ Verification complete:', verifiedMembers.length, 'members verified');
          
          // Build verification cards
          let html = '';
          verifiedMembers.forEach(member => {
            const bgColor = member.role === 'trustee' ? '#dbeafe' : 
                           member.role === 'official' ? '#fef9c3' : '#dcfce7';
            const textColor = member.role === 'trustee' ? '#1d4ed8' : 
                             member.role === 'official' ? '#92400e' : 'var(--primary-dark)';
            
            html += buildVerificationCard(
              member.role === 'trustee' ? member.title : '',
              member.title,
              member.index,
              member.phone,
              bgColor,
              textColor,
              member,
              member.id
            );
          });
          
          list.innerHTML = html;
        })
        .catch(err => {
          console.error('Error verifying members:', err);
          showNotification('Network error. Please check your connection.', 'error');
          goBackToForm();
        });

      // Switch to verification step
      setStepBar(3);
      showStep('step4-verify');
    }
