const DEFAULT_SETTINGS = {
  newbookRegion: 'au',
  newbookUsername: '',
  newbookPassword: '',
  newbookApiKey: '',
  packageInventoryName: '',
  resosApiKey: '',
  defaultTableArea: '',
  autoRefreshSeconds: 0,
  sendGuestNotification: false,
  bookingRefFieldId: '',
  hotelGuestFieldId: '',
  dbbFieldId: ''
};

const elements = {
  newbookRegion: document.getElementById('newbookRegion'),
  newbookUsername: document.getElementById('newbookUsername'),
  newbookPassword: document.getElementById('newbookPassword'),
  newbookApiKey: document.getElementById('newbookApiKey'),
  packageInventoryName: document.getElementById('packageInventoryName'),
  resosApiKey: document.getElementById('resosApiKey'),
  defaultTableArea: document.getElementById('defaultTableArea'),
  autoRefreshSeconds: document.getElementById('autoRefreshSeconds'),
  sendGuestNotification: document.getElementById('sendGuestNotification'),
  bookingRefFieldId: document.getElementById('bookingRefFieldId'),
  hotelGuestFieldId: document.getElementById('hotelGuestFieldId'),
  dbbFieldId: document.getElementById('dbbFieldId'),
  testNewbook: document.getElementById('testNewbook'),
  testResos: document.getElementById('testResos'),
  loadCustomFields: document.getElementById('loadCustomFields'),
  saveSettings: document.getElementById('saveSettings'),
  status: document.getElementById('status')
};

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get('settings');
    const settings = result.settings || DEFAULT_SETTINGS;

    elements.newbookRegion.value = settings.newbookRegion || 'au';
    elements.newbookUsername.value = settings.newbookUsername || '';
    elements.newbookPassword.value = settings.newbookPassword || '';
    elements.newbookApiKey.value = settings.newbookApiKey || '';
    elements.packageInventoryName.value = settings.packageInventoryName || '';
    elements.resosApiKey.value = settings.resosApiKey || '';
    elements.defaultTableArea.value = settings.defaultTableArea || '';
    elements.autoRefreshSeconds.value = settings.autoRefreshSeconds || 0;
    elements.sendGuestNotification.checked = settings.sendGuestNotification || false;

    // Store field IDs to re-select after loading custom fields
    elements.bookingRefFieldId.dataset.savedValue = settings.bookingRefFieldId || '';
    elements.hotelGuestFieldId.dataset.savedValue = settings.hotelGuestFieldId || '';
    elements.dbbFieldId.dataset.savedValue = settings.dbbFieldId || '';

    // If we have a Resos API key, try to load custom fields
    if (settings.resosApiKey) {
      await loadCustomFieldOptions(settings.resosApiKey, settings.bookingRefFieldId, settings.hotelGuestFieldId, settings.dbbFieldId);
    }
  } catch (error) {
    showStatus('Error loading settings: ' + error.message, 'error');
  }
}

async function saveSettings() {
  try {
    if (!elements.newbookUsername.value.trim()) {
      showStatus('Newbook username is required', 'error');
      elements.newbookUsername.focus();
      return;
    }
    if (!elements.newbookPassword.value.trim()) {
      showStatus('Newbook password is required', 'error');
      elements.newbookPassword.focus();
      return;
    }
    if (!elements.newbookApiKey.value.trim()) {
      showStatus('Newbook API key is required', 'error');
      elements.newbookApiKey.focus();
      return;
    }
    if (!elements.resosApiKey.value.trim()) {
      showStatus('Resos API key is required', 'error');
      elements.resosApiKey.focus();
      return;
    }

    const settings = {
      newbookRegion: elements.newbookRegion.value.trim() || 'au',
      newbookUsername: elements.newbookUsername.value.trim(),
      newbookPassword: elements.newbookPassword.value.trim(),
      newbookApiKey: elements.newbookApiKey.value.trim(),
      packageInventoryName: elements.packageInventoryName.value.trim(),
      resosApiKey: elements.resosApiKey.value.trim(),
      defaultTableArea: elements.defaultTableArea.value.trim(),
      autoRefreshSeconds: parseInt(elements.autoRefreshSeconds.value) || 0,
      sendGuestNotification: elements.sendGuestNotification.checked,
      bookingRefFieldId: elements.bookingRefFieldId.value,
      hotelGuestFieldId: elements.hotelGuestFieldId.value,
      dbbFieldId: elements.dbbFieldId.value
    };

    await chrome.storage.sync.set({ settings });
    chrome.runtime.sendMessage({ action: 'settingsUpdated', settings });
    showStatus('Settings saved successfully!', 'success');
  } catch (error) {
    showStatus('Error saving settings: ' + error.message, 'error');
  }
}

async function testNewbookConnection() {
  const username = elements.newbookUsername.value.trim();
  const password = elements.newbookPassword.value.trim();
  const apiKey = elements.newbookApiKey.value.trim();
  const region = elements.newbookRegion.value.trim() || 'au';

  if (!username || !password || !apiKey) {
    showStatus('Please fill in all Newbook API fields', 'error');
    return;
  }

  showStatus('Testing Newbook connection...', 'info');
  elements.testNewbook.disabled = true;

  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch('https://api.newbook.cloud/rest/bookings_list', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${username}:${password}`),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        period_from: `${today} 00:00:00`,
        period_to: `${today} 23:59:59`,
        list_type: 'staying',
        region: region,
        api_key: apiKey
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.data) {
        showStatus(`Newbook connection successful! Found ${data.data.length} staying bookings.`, 'success');
      } else if (data.success === false) {
        showStatus('Newbook responded but returned an error: ' + (data.message || 'Unknown error'), 'error');
      } else {
        showStatus('Newbook connected but unexpected response format.', 'info');
      }
    } else if (response.status === 401) {
      showStatus('Newbook authentication failed. Check username and password.', 'error');
    } else {
      showStatus(`Newbook connection failed with status ${response.status}`, 'error');
    }
  } catch (error) {
    if (error.message.includes('Failed to fetch')) {
      showStatus('Cannot reach Newbook API. Check network connection.', 'error');
    } else {
      showStatus('Newbook error: ' + error.message, 'error');
    }
  } finally {
    elements.testNewbook.disabled = false;
  }
}

async function testResosConnection() {
  const apiKey = elements.resosApiKey.value.trim();

  if (!apiKey) {
    showStatus('Please fill in the Resos API key', 'error');
    return;
  }

  showStatus('Testing Resos connection...', 'info');
  elements.testResos.disabled = true;

  try {
    const response = await fetch('https://api.resos.com/v1/customFields', {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${apiKey}:`),
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const fields = await response.json();
      showStatus(`Resos connection successful! Found ${fields.length} custom fields.`, 'success');
    } else if (response.status === 401) {
      showStatus('Resos authentication failed. Check your API key.', 'error');
    } else {
      showStatus(`Resos connection failed with status ${response.status}`, 'error');
    }
  } catch (error) {
    if (error.message.includes('Failed to fetch')) {
      showStatus('Cannot reach Resos API. Check network connection.', 'error');
    } else {
      showStatus('Resos error: ' + error.message, 'error');
    }
  } finally {
    elements.testResos.disabled = false;
  }
}

async function loadCustomFieldOptions(apiKeyOverride, selectBookingRef, selectHotelGuest, selectDbb) {
  const apiKey = apiKeyOverride || elements.resosApiKey.value.trim();

  if (!apiKey) {
    showStatus('Please enter a Resos API key first', 'error');
    return;
  }

  if (!apiKeyOverride) {
    showStatus('Loading custom fields from Resos...', 'info');
    elements.loadCustomFields.disabled = true;
  }

  try {
    const response = await fetch('https://api.resos.com/v1/customFields', {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${apiKey}:`),
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fields = await response.json();

    // Populate booking ref dropdown
    populateFieldSelect(elements.bookingRefFieldId, fields, selectBookingRef || elements.bookingRefFieldId.dataset.savedValue);
    // Populate hotel guest dropdown
    populateFieldSelect(elements.hotelGuestFieldId, fields, selectHotelGuest || elements.hotelGuestFieldId.dataset.savedValue);
    // Populate DBB field dropdown
    populateFieldSelect(elements.dbbFieldId, fields, selectDbb || elements.dbbFieldId.dataset.savedValue);

    if (!apiKeyOverride) {
      showStatus(`Loaded ${fields.length} custom fields from Resos.`, 'success');
    }
  } catch (error) {
    if (!apiKeyOverride) {
      showStatus('Error loading custom fields: ' + error.message, 'error');
    }
  } finally {
    if (!apiKeyOverride) {
      elements.loadCustomFields.disabled = false;
    }
  }
}

function populateFieldSelect(selectElement, fields, selectedValue) {
  // Keep the auto-detect option
  selectElement.innerHTML = '<option value="">Auto-detect</option>';

  for (const field of fields) {
    const option = document.createElement('option');
    option.value = field._id;
    option.textContent = `${field.name} (${field.type || 'text'})`;
    if (field._id === selectedValue) {
      option.selected = true;
    }
    selectElement.appendChild(option);
  }
}

function showStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;
  elements.status.classList.remove('hidden');

  if (type === 'success') {
    setTimeout(() => {
      elements.status.classList.add('hidden');
    }, 5000);
  }
}

// Event listeners
elements.saveSettings.addEventListener('click', saveSettings);
elements.testNewbook.addEventListener('click', testNewbookConnection);
elements.testResos.addEventListener('click', testResosConnection);
elements.loadCustomFields.addEventListener('click', () => loadCustomFieldOptions());

// Enter key saves on text inputs
[elements.newbookRegion, elements.newbookUsername, elements.newbookPassword, elements.newbookApiKey, elements.packageInventoryName, elements.resosApiKey, elements.defaultTableArea, elements.autoRefreshSeconds].forEach(input => {
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveSettings();
  });
});

document.addEventListener('DOMContentLoaded', loadSettings);
