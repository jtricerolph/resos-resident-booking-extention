// Resos Resident Booking - Sidepanel Logic

// ============================================================
// STATE
// ============================================================
const STATE = {
  settings: null,
  view: 'loading',
  newbookBookings: [],
  resosBookings: [],
  customFields: [],
  bookingRefFieldId: null,
  hotelGuestFieldId: null,
  hotelGuestYesChoiceId: null,
  matchedBookingIds: new Set(),
  selectedBooking: null,
  selectedTableId: null,
  availableTables: [],
  filterHideMatched: true,
  searchQuery: ''
};

let tableLoadDebounce = null;

// ============================================================
// API CLIENTS
// ============================================================
class NewbookAPI {
  constructor(settings) {
    this.baseUrl = 'https://api.newbook.cloud/rest';
    this.authHeader = 'Basic ' + btoa(`${settings.newbookUsername}:${settings.newbookPassword}`);
    this.apiKey = settings.newbookApiKey;
    this.region = settings.newbookRegion || 'au';
  }

  async fetchStayingTonight() {
    const today = getTodayDateString();
    const response = await fetch(`${this.baseUrl}/bookings_list`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        period_from: `${today} 00:00:00`,
        period_to: `${today} 23:59:59`,
        list_type: 'staying',
        region: this.region,
        api_key: this.apiKey
      })
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error('Newbook authentication failed. Check settings.');
      throw new Error(`Newbook API error: ${response.status}`);
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.message || 'Newbook API returned an error');
    }
    return data.data || [];
  }
}

class ResosAPI {
  constructor(settings) {
    this.baseUrl = 'https://api.resos.com/v1';
    this.authHeader = 'Basic ' + btoa(`${settings.resosApiKey}:`);
  }

  async fetchTodayBookings() {
    const today = getTodayDateString();
    const fromDateTime = `${today}T00:00:00`;
    const toDateTime = `${today}T23:59:59`;
    let allBookings = [];
    let skip = 0;
    const limit = 100;

    while (true) {
      const url = `${this.baseUrl}/bookings?fromDateTime=${encodeURIComponent(fromDateTime)}&toDateTime=${encodeURIComponent(toDateTime)}&limit=${limit}&skip=${skip}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error('Resos authentication failed. Check settings.');
        throw new Error(`Resos API error: ${response.status}`);
      }

      const bookings = await response.json();
      allBookings = allBookings.concat(bookings);

      if (bookings.length < limit) break;
      skip += limit;
    }

    return allBookings;
  }

  async fetchCustomFields() {
    const response = await fetch(`${this.baseUrl}/customFields`, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Resos custom fields error: ${response.status}`);
    }

    return await response.json();
  }

  async fetchAvailableTables(people, fromDateTime, toDateTime) {
    const params = new URLSearchParams({
      people: people.toString(),
      fromDateTime,
      toDateTime,
      returnAllTables: 'false'
    });

    const response = await fetch(`${this.baseUrl}/bookingFlow/availableTables?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Resos tables error: ${response.status}`);
    }

    return await response.json();
  }

  async createBooking(bookingData) {
    const response = await fetch(`${this.baseUrl}/bookings`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bookingData)
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errorBody = await response.text();
        errorDetail = errorBody ? ` - ${errorBody}` : '';
      } catch (_) {}
      throw new Error(`Resos create booking error: ${response.status}${errorDetail}`);
    }

    return await response.json();
  }
}

// ============================================================
// UTILITIES
// ============================================================
function getTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function titleCase(str) {
  if (!str) return '';
  return str.replace(/\w\S*/g, (word) => {
    // Handle O'Brien, O'Connor etc
    if (word.length > 1 && word[1] === "'") {
      return word[0].toUpperCase() + "'" + word[2].toUpperCase() + word.slice(3).toLowerCase();
    }
    // Handle McDonald, MacGregor etc
    if (word.toLowerCase().startsWith('mc') && word.length > 2) {
      return 'Mc' + word[2].toUpperCase() + word.slice(3).toLowerCase();
    }
    if (word.toLowerCase().startsWith('mac') && word.length > 3 && word[3] === word[3].toUpperCase()) {
      return 'Mac' + word[3].toUpperCase() + word.slice(4).toLowerCase();
    }
    return word[0].toUpperCase() + word.slice(1).toLowerCase();
  });
}

function getGuestFullName(booking) {
  if (booking.guests && booking.guests.length > 0) {
    const g = booking.guests[0];
    const first = titleCase(g.firstname || '');
    const last = titleCase(g.lastname || '');
    return `${first} ${last}`.trim();
  }
  return 'Unknown Guest';
}

function getGuestSurname(booking) {
  if (booking.guests && booking.guests.length > 0) {
    return (booking.guests[0].lastname || '').toLowerCase();
  }
  return '';
}

function getTotalGuests(booking) {
  return (parseInt(booking.booking_adults) || 0) +
         (parseInt(booking.booking_children) || 0) +
         (parseInt(booking.booking_infants) || 0);
}

function getGuestContact(booking, type) {
  if (!booking.guests || !booking.guests[0] || !booking.guests[0].contact_details) return '';
  for (const contact of booking.guests[0].contact_details) {
    if (contact.type === type) return contact.content || '';
  }
  return '';
}

function formatPhoneForResos(phone) {
  if (!phone) return '';
  // Strip non-digits
  let digits = phone.replace(/\D/g, '');
  // Remove leading 0
  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  // Prepend +44 (UK default)
  return '+44' + digits;
}

function getNowRoundedTime() {
  const now = new Date();
  const minutes = Math.round(now.getMinutes() / 15) * 15;
  const hours = now.getHours() + (minutes >= 60 ? 1 : 0);
  const mins = minutes >= 60 ? 0 : minutes;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(viewName) {
  STATE.view = viewName;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.remove('hidden');
}

function showFeedback(message, type) {
  const el = document.getElementById('create-feedback');
  el.textContent = message;
  el.className = `feedback ${type}`;
  el.classList.remove('hidden');
}

function hideFeedback() {
  document.getElementById('create-feedback').classList.add('hidden');
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get('settings');
    STATE.settings = result.settings || null;
    return !!STATE.settings;
  } catch (error) {
    console.error('Error loading settings:', error);
    return false;
  }
}

async function loadData() {
  showView('loading');

  try {
    const newbookApi = new NewbookAPI(STATE.settings);
    const resosApi = new ResosAPI(STATE.settings);

    // Parallel fetch
    const [newbookBookings, resosBookings, customFields] = await Promise.all([
      newbookApi.fetchStayingTonight(),
      resosApi.fetchTodayBookings(),
      resosApi.fetchCustomFields()
    ]);

    STATE.newbookBookings = newbookBookings;
    STATE.resosBookings = resosBookings;
    STATE.customFields = customFields;

    resolveCustomFieldMappings();
    buildMatchedSet();
    renderGuestList();
    showView('guest-list');
  } catch (error) {
    console.error('Error loading data:', error);
    document.getElementById('error-message').textContent = error.message;
    showView('error');
  }
}

// ============================================================
// CUSTOM FIELD RESOLUTION
// ============================================================
function resolveCustomFieldMappings() {
  const settings = STATE.settings;

  // Booking # field
  if (settings.bookingRefFieldId) {
    STATE.bookingRefFieldId = settings.bookingRefFieldId;
  } else {
    const field = STATE.customFields.find(f => {
      const name = (f.name || '').toLowerCase();
      return name.includes('booking') && name.includes('#');
    });
    STATE.bookingRefFieldId = field ? field._id : null;
  }

  // Hotel Guest field
  if (settings.hotelGuestFieldId) {
    STATE.hotelGuestFieldId = settings.hotelGuestFieldId;
    const field = STATE.customFields.find(f => f._id === settings.hotelGuestFieldId);
    if (field && field.multipleChoiceSelections) {
      const yesChoice = field.multipleChoiceSelections.find(c => c.name.toLowerCase() === 'yes');
      STATE.hotelGuestYesChoiceId = yesChoice ? yesChoice._id : null;
    }
  } else {
    const field = STATE.customFields.find(f => {
      const name = (f.name || '').toLowerCase();
      return name.includes('hotel') && name.includes('guest');
    });
    if (field) {
      STATE.hotelGuestFieldId = field._id;
      if (field.multipleChoiceSelections) {
        const yesChoice = field.multipleChoiceSelections.find(c => c.name.toLowerCase() === 'yes');
        STATE.hotelGuestYesChoiceId = yesChoice ? yesChoice._id : null;
      }
    }
  }
}

// ============================================================
// MATCHING
// ============================================================
function buildMatchedSet() {
  STATE.matchedBookingIds.clear();

  if (!STATE.bookingRefFieldId) return;

  for (const resosBooking of STATE.resosBookings) {
    if (!resosBooking.customFields) continue;
    for (const cf of resosBooking.customFields) {
      // Match by field ID or by field name fallback
      const isBookingRefField = cf._id === STATE.bookingRefFieldId ||
        cf.id === STATE.bookingRefFieldId;
      if (isBookingRefField && cf.value) {
        STATE.matchedBookingIds.add(String(cf.value));
      }
    }
  }
}

// ============================================================
// GUEST LIST RENDERING
// ============================================================
function renderGuestList() {
  const container = document.getElementById('guest-list');
  container.innerHTML = '';

  let bookings = [...STATE.newbookBookings];

  // Filter: hide matched
  if (STATE.filterHideMatched) {
    bookings = bookings.filter(b => !STATE.matchedBookingIds.has(String(b.booking_id)));
  }

  // Filter: search
  if (STATE.searchQuery.trim()) {
    const q = STATE.searchQuery.toLowerCase();
    bookings = bookings.filter(b => {
      const name = getGuestFullName(b).toLowerCase();
      const room = (b.site_name || '').toLowerCase();
      const id = String(b.booking_id);
      return name.includes(q) || room.includes(q) || id.includes(q);
    });
  }

  // Update count
  document.getElementById('guest-count').textContent = bookings.length;

  if (bookings.length === 0) {
    container.innerHTML = `
      <div class="empty-list">
        <span class="material-symbols-outlined">check_circle</span>
        <p>${STATE.filterHideMatched ? 'All hotel guests have a Resos booking' : 'No hotel guests staying tonight'}</p>
      </div>
    `;
    return;
  }

  // Sort by surname
  bookings.sort((a, b) => getGuestSurname(a).localeCompare(getGuestSurname(b)));

  for (const booking of bookings) {
    container.appendChild(createGuestCard(booking));
  }
}

function createGuestCard(booking) {
  const card = document.createElement('div');
  card.className = 'guest-card';

  const guestName = getGuestFullName(booking);
  const room = booking.site_name || 'N/A';
  const totalGuests = getTotalGuests(booking);
  const isMatched = STATE.matchedBookingIds.has(String(booking.booking_id));

  card.innerHTML = `
    <div class="guest-card-main">
      <div class="guest-card-name">${escapeHtml(guestName)}</div>
      <div class="guest-card-details">
        <span class="guest-card-room">
          <span class="material-symbols-outlined">meeting_room</span>
          ${escapeHtml(room)}
        </span>
        <span class="guest-card-pax">
          <span class="material-symbols-outlined">group</span>
          ${totalGuests}
        </span>
        <span class="guest-card-booking-id">#${booking.booking_id}</span>
      </div>
    </div>
    ${isMatched ? '<span class="matched-badge">Has booking</span>' : ''}
    <span class="material-symbols-outlined guest-card-arrow">chevron_right</span>
  `;

  card.addEventListener('click', () => selectGuest(booking));
  return card;
}

// ============================================================
// GUEST SELECTION & TABLE LOADING
// ============================================================
function selectGuest(booking) {
  STATE.selectedBooking = booking;
  STATE.selectedTableId = null;
  STATE.availableTables = [];

  const guestName = getGuestFullName(booking);
  const totalGuests = getTotalGuests(booking);

  document.getElementById('confirm-guest-name').textContent = guestName;
  document.getElementById('confirm-booking-id').textContent = booking.booking_id;
  document.getElementById('confirm-room').textContent = booking.site_name || 'N/A';
  document.getElementById('confirm-covers').value = totalGuests || 2;
  document.getElementById('confirm-time').value = getNowRoundedTime();

  // Reset tables
  document.getElementById('tables-section').classList.add('hidden');
  document.getElementById('create-booking-btn').disabled = true;
  hideFeedback();

  showView('confirm');

  // Load tables for default values
  loadAvailableTables();
}

async function loadAvailableTables() {
  const covers = parseInt(document.getElementById('confirm-covers').value);
  const time = document.getElementById('confirm-time').value;

  if (!covers || covers < 1 || !time) return;

  const today = getTodayDateString();
  const fromDateTime = `${today}T${time}:00`;

  // Calculate end time (2 hours later)
  const [hours, mins] = time.split(':').map(Number);
  const endDate = new Date();
  endDate.setHours(hours + 2, mins, 0, 0);
  const toDateTime = `${today}T${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;

  // Show section and loading
  const section = document.getElementById('tables-section');
  section.classList.remove('hidden');
  document.getElementById('tables-loading').classList.remove('hidden');
  document.getElementById('tables-list').innerHTML = '';
  document.getElementById('tables-empty').classList.add('hidden');
  document.getElementById('tables-error').classList.add('hidden');
  document.getElementById('create-booking-btn').disabled = true;
  STATE.selectedTableId = null;

  try {
    const resosApi = new ResosAPI(STATE.settings);
    const tables = await resosApi.fetchAvailableTables(covers, fromDateTime, toDateTime);
    STATE.availableTables = tables;

    document.getElementById('tables-loading').classList.add('hidden');

    if (!tables || tables.length === 0) {
      document.getElementById('tables-empty').classList.remove('hidden');
      return;
    }

    renderTableButtons(tables);
  } catch (error) {
    console.error('Error loading tables:', error);
    document.getElementById('tables-loading').classList.add('hidden');
    document.getElementById('tables-error').classList.remove('hidden');
    document.getElementById('tables-error-message').textContent = 'Error loading tables: ' + error.message;
  }
}

function renderTableButtons(tables) {
  const container = document.getElementById('tables-list');
  container.innerHTML = '';

  for (const table of tables) {
    const btn = document.createElement('button');
    btn.className = 'table-btn';

    // Show table name, with area if available
    let label = table.name || table._id;
    if (table.area && table.area.name) {
      label += ` (${table.area.name})`;
    }
    btn.textContent = label;
    btn.dataset.tableId = table._id;
    btn.title = label;

    btn.addEventListener('click', () => {
      container.querySelectorAll('.table-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      STATE.selectedTableId = table._id;
      document.getElementById('create-booking-btn').disabled = false;
    });

    container.appendChild(btn);
  }
}

function debouncedLoadTables() {
  clearTimeout(tableLoadDebounce);
  tableLoadDebounce = setTimeout(() => {
    loadAvailableTables();
  }, 500);
}

// ============================================================
// BOOKING CREATION
// ============================================================
async function createBooking() {
  const booking = STATE.selectedBooking;
  if (!booking || !STATE.selectedTableId) return;

  const guestName = getGuestFullName(booking);
  const covers = parseInt(document.getElementById('confirm-covers').value);
  const time = document.getElementById('confirm-time').value;
  const today = getTodayDateString();

  // Guest contact
  const rawPhone = getGuestContact(booking, 'phone') || getGuestContact(booking, 'mobile');
  const phone = formatPhoneForResos(rawPhone);
  const email = getGuestContact(booking, 'email');

  // Build custom fields
  const customFields = [];
  if (STATE.bookingRefFieldId) {
    customFields.push({
      _id: STATE.bookingRefFieldId,
      name: 'Booking #',
      value: String(booking.booking_id)
    });
  }
  if (STATE.hotelGuestFieldId && STATE.hotelGuestYesChoiceId) {
    customFields.push({
      _id: STATE.hotelGuestFieldId,
      name: 'Hotel Guest',
      value: STATE.hotelGuestYesChoiceId,
      multipleChoiceValueName: 'Yes'
    });
  }

  const bookingPayload = {
    date: today,
    time: time,
    people: covers,
    tables: [STATE.selectedTableId],
    guest: {
      name: guestName
    },
    status: 'approved',
    languageCode: 'en',
    customFields: customFields
  };

  // Only add contact info if available
  if (phone) bookingPayload.guest.phone = phone;
  if (email) bookingPayload.guest.email = email;

  // Disable button
  const createBtn = document.getElementById('create-booking-btn');
  createBtn.disabled = true;
  createBtn.classList.add('loading');
  hideFeedback();

  try {
    const resosApi = new ResosAPI(STATE.settings);
    await resosApi.createBooking(bookingPayload);

    // Success
    document.getElementById('success-message').textContent =
      `${guestName} - ${covers} covers at ${time}`;
    showView('success');

    // Mark as matched so it hides from the list
    STATE.matchedBookingIds.add(String(booking.booking_id));
  } catch (error) {
    console.error('Error creating booking:', error);
    showFeedback('Error: ' + error.message, 'error');
    createBtn.disabled = false;
  } finally {
    createBtn.classList.remove('loading');
  }
}

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
  const hasSettings = await loadSettings();

  if (!hasSettings || !STATE.settings.resosApiKey || !STATE.settings.newbookApiKey) {
    showView('not-configured');
    return;
  }

  await loadData();
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (STATE.settings) loadData();
  });

  // Settings
  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('open-settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Filter toggle
  document.getElementById('filter-matched').addEventListener('change', (e) => {
    STATE.filterHideMatched = e.target.checked;
    renderGuestList();
  });

  // Search
  document.getElementById('guest-search').addEventListener('input', (e) => {
    STATE.searchQuery = e.target.value;
    renderGuestList();
  });

  // Back to list
  document.getElementById('back-to-list-btn').addEventListener('click', () => {
    showView('guest-list');
  });

  // Covers/time change -> reload tables (debounced)
  document.getElementById('confirm-covers').addEventListener('change', debouncedLoadTables);
  document.getElementById('confirm-time').addEventListener('change', debouncedLoadTables);

  // Create booking
  document.getElementById('create-booking-btn').addEventListener('click', createBooking);

  // Error retry
  document.getElementById('error-retry-btn').addEventListener('click', () => {
    if (STATE.settings) loadData();
  });

  // Success done
  document.getElementById('success-done-btn').addEventListener('click', () => {
    renderGuestList();
    showView('guest-list');
  });
});

// Listen for settings updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'settingsUpdated') {
    STATE.settings = message.settings;
    loadData();
  }
});
