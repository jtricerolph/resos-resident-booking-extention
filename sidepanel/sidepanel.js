// Resos Resident Booking - Sidepanel Logic

// ============================================================
// STATE
// ============================================================
const STATE = {
  settings: null,
  view: 'loading',
  contextDate: null,       // YYYY-MM-DD or null (no day selected)
  isToday: false,
  newbookBookings: [],
  resosBookings: [],
  customFields: [],
  bookingRefFieldId: null,
  hotelGuestFieldId: null,
  hotelGuestYesChoiceId: null,
  dbbFieldId: null,
  dbbYesChoiceId: null,
  groupExcludeFieldId: null,
  matchedBookingIds: new Set(),
  matchedBookingResosMap: new Map(), // newbookBookingId -> resosBookingId
  packageBookingIds: new Set(),
  currentBaseUrl: null, // base URL for constructing Resos booking links
  selectedBooking: null,
  selectedTableId: null,
  selectedTimeSlot: null,  // { time, openingHourId }
  availableTables: [],
  filterHideMatched: true,
  searchQuery: ''
};

let tableLoadDebounce = null;

// ============================================================
// URL PARSING
// ============================================================
// Matches: /bookings/(timetable|list|floorplan)/(today|YYYY-MM-DD)
const DAY_VIEW_PATTERN = /\/bookings\/(?:timetable|list|floorplan)\/(today|\d{4}-\d{2}-\d{2})/i;

function parseDateFromUrl(url) {
  if (!url) return null;
  const match = url.match(DAY_VIEW_PATTERN);
  if (!match) return null;
  const dateStr = match[1];
  if (dateStr.toLowerCase() === 'today') return getTodayDateString();
  return dateStr;
}

// Extract base URL up to and including the date for constructing booking links
// e.g. https://app.resos.com/GwihQrTWk7QKEHna2/bookings/timetable/2026-02-05
const BASE_URL_PATTERN = /(https:\/\/app\.resos\.com\/[^/]+\/bookings\/(?:timetable|list|floorplan)\/(?:today|\d{4}-\d{2}-\d{2}))/i;

function parseBaseUrl(url) {
  if (!url) return null;
  const match = url.match(BASE_URL_PATTERN);
  if (!match) return null;
  // Replace /today with actual date so booking links work
  return match[1].replace(/\/today$/i, '/' + getTodayDateString());
}

function isDateToday(dateStr) {
  return dateStr === getTodayDateString();
}

function formatDateForDisplay(dateStr) {
  if (!dateStr) return '';
  if (isDateToday(dateStr)) return 'Today';
  const d = new Date(dateStr + 'T12:00:00');
  const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString('en-GB', options);
}

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

  async fetchStayingOnDate(dateStr) {
    const response = await fetch(`${this.baseUrl}/bookings_list`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        period_from: `${dateStr} 00:00:00`,
        period_to: `${dateStr} 23:59:59`,
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

  async fetchBookingsForDate(dateStr) {
    const fromDateTime = `${dateStr}T00:00:00`;
    const toDateTime = `${dateStr}T23:59:59`;
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

  async fetchAvailableTimes(dateStr, people) {
    const params = new URLSearchParams({
      date: dateStr,
      people: people.toString(),
      onlyBookableOnline: 'false'
    });

    const response = await fetch(`${this.baseUrl}/bookingFlow/times?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Resos available times error: ${response.status}`);
    }

    return await response.json();
  }

  async fetchAvailableTables(people, fromDateTime, toDateTime) {
    const params = new URLSearchParams({
      people: people.toString(),
      fromDateTime,
      toDateTime,
      returnAllTables: 'true'
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
    if (word.length > 1 && word[1] === "'") {
      return word[0].toUpperCase() + "'" + word[2].toUpperCase() + word.slice(3).toLowerCase();
    }
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
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  return '+44' + digits;
}

function getCurrentHHMM() {
  const now = new Date();
  return now.getHours() * 100 + now.getMinutes();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// "Table 1" → "T1", "Table 12" → "T12", "Table 1 + Table 2" → "T1+<wbr>2"
function shortenTableName(name) {
  if (!name) return '';
  const parts = name.split(/\s*\+\s*/);
  if (parts.length > 1) {
    const shortened = parts.map(p => escapeHtml(shortenSingleTable(p)));
    return shortened[0] + shortened.slice(1).map(s => '+<wbr>' + s.replace(/^T/, '')).join('');
  }
  return escapeHtml(shortenSingleTable(name));
}

function shortenSingleTable(name) {
  const match = name.match(/^table\s+(\d+)$/i);
  if (match) return 'T' + match[1];
  return name;
}

// Format HHMM int (e.g. 1800) to "18:00"
function formatHHMM(hhmm) {
  const h = Math.floor(hhmm / 100);
  const m = hhmm % 100;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  if (!STATE.contextDate) {
    showView('no-day');
    return;
  }

  showView('loading');

  try {
    const newbookApi = new NewbookAPI(STATE.settings);
    const resosApi = new ResosAPI(STATE.settings);

    // Parallel fetch
    const [newbookBookings, resosBookings, customFields] = await Promise.all([
      newbookApi.fetchStayingOnDate(STATE.contextDate),
      resosApi.fetchBookingsForDate(STATE.contextDate),
      resosApi.fetchCustomFields()
    ]);

    STATE.newbookBookings = newbookBookings;
    STATE.resosBookings = resosBookings;
    STATE.customFields = customFields;

    resolveCustomFieldMappings();
    buildMatchedSet();
    buildPackageSet();
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

  if (settings.bookingRefFieldId) {
    STATE.bookingRefFieldId = settings.bookingRefFieldId;
  } else {
    const field = STATE.customFields.find(f => {
      const name = (f.name || '').toLowerCase();
      return name.includes('booking') && name.includes('#');
    });
    STATE.bookingRefFieldId = field ? field._id : null;
  }

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

  // GROUP/EXCLUDE field (auto-detect only)
  const geField = STATE.customFields.find(f => (f.name || '') === 'GROUP/EXCLUDE');
  STATE.groupExcludeFieldId = geField ? geField._id : null;

  // DBB / Package field
  if (settings.dbbFieldId) {
    STATE.dbbFieldId = settings.dbbFieldId;
    const field = STATE.customFields.find(f => f._id === settings.dbbFieldId);
    if (field && field.multipleChoiceSelections) {
      const yesChoice = field.multipleChoiceSelections.find(c => c.name.toLowerCase() === 'yes');
      STATE.dbbYesChoiceId = yesChoice ? yesChoice._id : null;
    }
  } else {
    const field = STATE.customFields.find(f => {
      const name = (f.name || '').toLowerCase();
      return name === 'dbb';
    });
    if (field) {
      STATE.dbbFieldId = field._id;
      if (field.multipleChoiceSelections) {
        const yesChoice = field.multipleChoiceSelections.find(c => c.name.toLowerCase() === 'yes');
        STATE.dbbYesChoiceId = yesChoice ? yesChoice._id : null;
      }
    }
  }
}

// ============================================================
// MATCHING
// ============================================================
function buildMatchedSet() {
  STATE.matchedBookingIds.clear();
  STATE.matchedBookingResosMap.clear();

  const activeStatuses = new Set(['approved', 'arrived', 'seated', 'left']);

  // Build a lookup of Newbook group IDs for GROUP/EXCLUDE matching
  const groupIdToBookingIds = new Map();
  for (const nb of STATE.newbookBookings) {
    const gid = nb.bookings_group_id;
    if (gid) {
      const gidStr = String(gid);
      if (!groupIdToBookingIds.has(gidStr)) groupIdToBookingIds.set(gidStr, []);
      groupIdToBookingIds.get(gidStr).push(String(nb.booking_id));
    }
  }

  for (const resosBooking of STATE.resosBookings) {
    if (!activeStatuses.has(resosBooking.status)) continue;
    if (!resosBooking.customFields) continue;

    const resosId = resosBooking._id;

    // Check Booking # field
    if (STATE.bookingRefFieldId) {
      for (const cf of resosBooking.customFields) {
        const isBookingRefField = cf._id === STATE.bookingRefFieldId ||
          cf.id === STATE.bookingRefFieldId;
        if (isBookingRefField && cf.value) {
          const nbId = String(cf.value);
          STATE.matchedBookingIds.add(nbId);
          STATE.matchedBookingResosMap.set(nbId, resosId);
        }
      }
    }

    // Check GROUP/EXCLUDE field
    if (STATE.groupExcludeFieldId) {
      for (const cf of resosBooking.customFields) {
        const isGEField = cf._id === STATE.groupExcludeFieldId ||
          cf.id === STATE.groupExcludeFieldId;
        if (isGEField && cf.value) {
          const parsed = parseGroupExcludeField(String(cf.value));
          // Individual booking IDs: #12345
          for (const id of parsed.individuals) {
            STATE.matchedBookingIds.add(id);
            STATE.matchedBookingResosMap.set(id, resosId);
          }
          // Group IDs: G#5678 → find all Newbook bookings in that group
          for (const gid of parsed.groups) {
            const nbIds = groupIdToBookingIds.get(gid) || [];
            for (const nbId of nbIds) {
              STATE.matchedBookingIds.add(nbId);
              STATE.matchedBookingResosMap.set(nbId, resosId);
            }
          }
        }
      }
    }
  }
}

function parseGroupExcludeField(value) {
  const result = { groups: [], individuals: [], excludes: [] };
  if (!value) return result;

  const entries = value.split(',');
  for (let entry of entries) {
    entry = entry.trim();
    if (!entry) continue;
    if (entry.toUpperCase().startsWith('NOT-#')) {
      // Exclusion — not relevant for this extension, skip
      continue;
    } else if (entry.toUpperCase().startsWith('G#')) {
      const id = entry.substring(2).trim();
      if (id) result.groups.push(id);
    } else if (entry.startsWith('#')) {
      const id = entry.substring(1).trim();
      if (id) result.individuals.push(id);
    }
  }
  return result;
}

// ============================================================
// PACKAGE / DBB DETECTION
// ============================================================
function buildPackageSet() {
  STATE.packageBookingIds.clear();

  const packageName = (STATE.settings.packageInventoryName || '').trim().toLowerCase();
  if (!packageName) return;

  const dateStr = STATE.contextDate;
  if (!dateStr) return;

  for (const booking of STATE.newbookBookings) {
    if (!booking.inventory_items || !Array.isArray(booking.inventory_items)) continue;
    for (const item of booking.inventory_items) {
      if (item.stay_date === dateStr) {
        const desc = (item.description || '').toLowerCase();
        if (desc.includes(packageName)) {
          STATE.packageBookingIds.add(String(booking.booking_id));
          break;
        }
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

  const isSearching = STATE.searchQuery.trim().length > 0;
  if (STATE.filterHideMatched && !isSearching) {
    bookings = bookings.filter(b => !STATE.matchedBookingIds.has(String(b.booking_id)));
  }

  if (isSearching) {
    const q = STATE.searchQuery.toLowerCase();
    bookings = bookings.filter(b => {
      const name = getGuestFullName(b).toLowerCase();
      const room = (b.site_name || '').toLowerCase();
      const id = String(b.booking_id);
      return name.includes(q) || room.includes(q) || id.includes(q);
    });
  }

  document.getElementById('guest-count').textContent = bookings.length;

  if (bookings.length === 0) {
    const dateLabel = STATE.isToday ? 'tonight' : 'on ' + formatDateForDisplay(STATE.contextDate);
    container.innerHTML = `
      <div class="empty-list">
        <span class="material-symbols-outlined">check_circle</span>
        <p>${STATE.filterHideMatched ? 'All hotel guests have a Resos booking' : 'No hotel guests staying ' + dateLabel}</p>
      </div>
    `;
    return;
  }

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
  const bookingIdStr = String(booking.booking_id);
  const isMatched = STATE.matchedBookingIds.has(bookingIdStr);
  const isPackage = STATE.packageBookingIds.has(bookingIdStr);

  // Highlight package guests without a Resos booking
  if (isPackage && !isMatched) {
    card.classList.add('guest-card-package-alert');
  }

  let badges = '';
  if (isPackage) badges += '<span class="package-badge">DBB</span>';
  if (isMatched) badges += '<span class="matched-badge">Has booking</span>';

  const resosBookingId = STATE.matchedBookingResosMap.get(bookingIdStr);
  const arrowIcon = (isMatched && resosBookingId) ? 'open_in_new' : 'chevron_right';

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
    <div class="guest-card-badges">${badges}</div>
    <span class="material-symbols-outlined guest-card-arrow">${arrowIcon}</span>
  `;

  if (isMatched && resosBookingId && STATE.currentBaseUrl) {
    // Open the existing Resos booking in the main window
    card.addEventListener('click', () => {
      const bookingUrl = `${STATE.currentBaseUrl}/${resosBookingId}`;
      chrome.runtime.sendMessage({ action: 'navigateTab', url: bookingUrl });
    });
  } else {
    card.addEventListener('click', () => selectGuest(booking));
  }
  return card;
}

// ============================================================
// GUEST SELECTION
// ============================================================
function selectGuest(booking) {
  STATE.selectedBooking = booking;
  STATE.selectedTableId = null;
  STATE.selectedTimeSlot = null;

  const guestName = getGuestFullName(booking);
  const totalGuests = getTotalGuests(booking);

  document.getElementById('confirm-guest-name').textContent = guestName;
  document.getElementById('confirm-booking-id').textContent = booking.booking_id;
  document.getElementById('confirm-room').textContent = booking.site_name || 'N/A';
  document.getElementById('confirm-date').textContent = formatDateForDisplay(STATE.contextDate);

  // Reset sections
  document.getElementById('tables-section').classList.add('hidden');
  document.getElementById('timeslots-section').classList.add('hidden');
  document.getElementById('create-booking-btn').disabled = true;
  hideFeedback();

  // Unified: both today and future use covers + time slot selection
  document.getElementById('confirm-covers').value = totalGuests || 2;
  showView('confirm');
  loadAvailableTimeSlots();
}

// ============================================================
// TABLE LOADING (Today)
// ============================================================
async function loadAvailableTables() {
  const covers = parseInt(document.getElementById('confirm-covers').value);
  if (!covers || covers < 1 || !STATE.selectedTimeSlot) return;

  const time = STATE.selectedTimeSlot.time;
  const [hours, mins] = time.split(':').map(Number);
  const timeFormatted = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

  const dateStr = STATE.contextDate;
  const fromDateTime = `${dateStr}T${timeFormatted}:00`;

  const endDate = new Date();
  endDate.setHours(hours + 2, mins, 0, 0);
  const toDateTime = `${dateStr}T${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;

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

    const rendered = renderTableButtons(tables);
    if (!rendered) {
      document.getElementById('tables-empty').classList.remove('hidden');
    }
  } catch (error) {
    console.error('Error loading tables:', error);
    document.getElementById('tables-loading').classList.add('hidden');
    document.getElementById('tables-error').classList.remove('hidden');
    document.getElementById('tables-error-message').textContent = 'Error loading tables: ' + error.message;
  }
}

function getTableSortNumber(name) {
  if (!name) return 9999;
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 9999;
}

function renderTableButtons(tables) {
  const container = document.getElementById('tables-list');
  container.innerHTML = '';

  const filtered = tables.filter(t => {
    const name = t.name || '';
    const plusCount = (name.match(/\+/g) || []).length;
    return plusCount <= 1;
  });

  const grouped = new Map();
  for (const table of filtered) {
    const areaName = (table.area && table.area.name) || 'Other';
    if (!grouped.has(areaName)) grouped.set(areaName, []);
    grouped.get(areaName).push(table);
  }

  const defaultArea = (STATE.settings.defaultTableArea || '').trim().toLowerCase();
  const sections = []; // track { header, content } for accordion

  for (const [areaName, areaTables] of grouped) {
    areaTables.sort((a, b) => getTableSortNumber(a.name) - getTableSortNumber(b.name));

    // Determine if this area should be expanded
    const isExpanded = defaultArea ? areaName.toLowerCase() === defaultArea : true;

    if (grouped.size > 1 || areaName !== 'Other') {
      // Collapsible header
      const header = document.createElement('div');
      header.className = 'collapsible-header' + (isExpanded ? ' expanded' : '');
      header.innerHTML = `
        <span class="material-symbols-outlined collapsible-chevron">${isExpanded ? 'expand_more' : 'chevron_right'}</span>
        <span class="collapsible-title">${escapeHtml(areaName)}</span>
      `;
      container.appendChild(header);

      const content = document.createElement('div');
      content.className = 'collapsible-content';
      if (!isExpanded) content.classList.add('hidden');

      const grid = document.createElement('div');
      grid.className = 'tables-grid';

      for (const table of areaTables) {
        grid.appendChild(createTableButton(table, areaName, container));
      }

      content.appendChild(grid);
      container.appendChild(content);

      sections.push({ header, content });

      // Accordion handler — opening one closes others
      header.addEventListener('click', () => {
        const isNowExpanded = !content.classList.contains('hidden');
        if (isNowExpanded) {
          // Collapse this section
          content.classList.add('hidden');
          header.classList.remove('expanded');
          header.querySelector('.collapsible-chevron').textContent = 'chevron_right';
        } else {
          // Collapse all other sections first
          for (const s of sections) {
            s.content.classList.add('hidden');
            s.header.classList.remove('expanded');
            s.header.querySelector('.collapsible-chevron').textContent = 'chevron_right';
          }
          // Expand this section
          content.classList.remove('hidden');
          header.classList.add('expanded');
          header.querySelector('.collapsible-chevron').textContent = 'expand_more';
        }
      });
    } else {
      // Single "Other" area: flat grid, no header
      const grid = document.createElement('div');
      grid.className = 'tables-grid';
      for (const table of areaTables) {
        grid.appendChild(createTableButton(table, areaName, container));
      }
      container.appendChild(grid);
    }
  }

  return filtered.length > 0;
}

function createTableButton(table, areaName, container) {
  const btn = document.createElement('button');
  btn.className = 'table-btn';
  if (table.booked) {
    btn.classList.add('table-btn-booked');
  }
  const fullName = table.name || table._id;
  btn.innerHTML = shortenTableName(fullName);
  btn.dataset.tableId = table._id;
  btn.title = table.booked
    ? `${fullName} (${areaName}) — in use`
    : `${fullName} (${areaName})`;

  btn.addEventListener('click', () => {
    container.querySelectorAll('.table-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    STATE.selectedTableId = table._id;
    document.getElementById('create-booking-btn').disabled = false;
  });

  return btn;
}

// ============================================================
// TIME SLOT LOADING
// ============================================================
async function loadAvailableTimeSlots() {
  const covers = parseInt(document.getElementById('confirm-covers').value);
  if (!covers || covers < 1) return;

  // Reset time slot and table state
  STATE.selectedTimeSlot = null;
  STATE.selectedTableId = null;
  document.getElementById('tables-section').classList.add('hidden');
  document.getElementById('create-booking-btn').disabled = true;

  const section = document.getElementById('timeslots-section');
  section.classList.remove('hidden');
  document.getElementById('timeslots-loading').classList.remove('hidden');
  document.getElementById('timeslots-list').innerHTML = '';
  document.getElementById('timeslots-empty').classList.add('hidden');
  document.getElementById('timeslots-error').classList.add('hidden');

  try {
    const resosApi = new ResosAPI(STATE.settings);
    const times = await resosApi.fetchAvailableTimes(STATE.contextDate, covers);

    document.getElementById('timeslots-loading').classList.add('hidden');

    // Response is array of opening hour objects with availableTimes + unavailableTimes
    const periods = times || [];
    const hasAny = periods.some(p =>
      (p.availableTimes && p.availableTimes.length > 0) ||
      (p.unavailableTimes && p.unavailableTimes.length > 0));

    if (!hasAny) {
      document.getElementById('timeslots-empty').classList.remove('hidden');
      return;
    }

    renderTimeSlots(periods);
  } catch (error) {
    console.error('Error loading time slots:', error);
    document.getElementById('timeslots-loading').classList.add('hidden');
    document.getElementById('timeslots-error').classList.remove('hidden');
    document.getElementById('timeslots-error-message').textContent = 'Error loading times: ' + error.message;
  }
}

function parseTimeToHHMM(timeStr) {
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 100 + (parts[1] || 0);
}

function renderTimeSlots(periods) {
  const container = document.getElementById('timeslots-list');
  container.innerHTML = '';

  const nowHHMM = getCurrentHHMM();
  const sections = []; // track { header, content } for accordion

  // Default to last period with times (latest service, e.g. dinner)
  let defaultExpandIndex = -1;
  for (let i = periods.length - 1; i >= 0; i--) {
    const p = periods[i];
    if ((p.availableTimes && p.availableTimes.length > 0) ||
        (p.unavailableTimes && p.unavailableTimes.length > 0)) {
      defaultExpandIndex = i;
      break;
    }
  }

  let autoSelectBtn = null;

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const available = period.availableTimes || [];
    const unavailable = period.unavailableTimes || [];

    if (available.length === 0 && unavailable.length === 0) continue;

    // Combine and sort all times
    const availableSet = new Set(available);
    const allTimesSet = new Set([...available, ...unavailable]);
    const allSlots = [...allTimesSet]
      .map(t => ({ timeStr: t, hhmm: parseTimeToHHMM(t) }))
      .sort((a, b) => a.hhmm - b.hhmm);

    if (allSlots.length === 0) continue;

    const isExpanded = (i === defaultExpandIndex);
    const periodName = period.name ||
      `${allSlots[0].timeStr} - ${allSlots[allSlots.length - 1].timeStr}`;

    // Collapsible header
    const header = document.createElement('div');
    header.className = 'collapsible-header' + (isExpanded ? ' expanded' : '');
    header.innerHTML = `
      <span class="material-symbols-outlined collapsible-chevron">${isExpanded ? 'expand_more' : 'chevron_right'}</span>
      <span class="collapsible-title">${escapeHtml(periodName)}</span>
    `;
    container.appendChild(header);

    // Collapsible content
    const content = document.createElement('div');
    content.className = 'collapsible-content';
    if (!isExpanded) content.classList.add('hidden');

    const grid = document.createElement('div');
    grid.className = 'timeslots-grid';

    for (const slot of allSlots) {
      const isAvailable = availableSet.has(slot.timeStr);
      const btn = document.createElement('button');
      btn.className = 'timeslot-btn';
      if (!isAvailable) {
        btn.classList.add('timeslot-btn-booked');
      }
      btn.textContent = slot.timeStr;
      btn.title = isAvailable ? slot.timeStr : `${slot.timeStr} — no availability`;

      btn.addEventListener('click', () => {
        container.querySelectorAll('.timeslot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        STATE.selectedTimeSlot = {
          time: slot.timeStr,
          openingHourId: period._id
        };

        if (STATE.isToday) {
          document.getElementById('create-booking-btn').disabled = true;
          STATE.selectedTableId = null;
          loadAvailableTables();
        } else {
          document.getElementById('create-booking-btn').disabled = false;
        }
      });

      // Auto-select: first available slot >= now in default-expanded period (today only)
      if (STATE.isToday && i === defaultExpandIndex && isAvailable && !autoSelectBtn && slot.hhmm >= nowHHMM) {
        autoSelectBtn = btn;
      }

      grid.appendChild(btn);
    }

    content.appendChild(grid);
    container.appendChild(content);
    sections.push({ header, content });

    // Accordion toggle: opening one closes others
    header.addEventListener('click', () => {
      const isNowExpanded = !content.classList.contains('hidden');
      if (isNowExpanded) {
        // Collapse this one
        content.classList.add('hidden');
        header.classList.remove('expanded');
        header.querySelector('.collapsible-chevron').textContent = 'chevron_right';
      } else {
        // Collapse all others, expand this one
        for (const s of sections) {
          s.content.classList.add('hidden');
          s.header.classList.remove('expanded');
          s.header.querySelector('.collapsible-chevron').textContent = 'chevron_right';
        }
        content.classList.remove('hidden');
        header.classList.add('expanded');
        header.querySelector('.collapsible-chevron').textContent = 'expand_more';
      }
    });
  }

  // Auto-select next available time for today
  if (autoSelectBtn) {
    autoSelectBtn.click();
  }
}

function debouncedLoadTimeSlots() {
  clearTimeout(tableLoadDebounce);
  tableLoadDebounce = setTimeout(() => {
    loadAvailableTimeSlots();
  }, 500);
}

// ============================================================
// BOOKING CREATION
// ============================================================
async function createBooking() {
  const booking = STATE.selectedBooking;
  if (!booking) return;
  if (!STATE.selectedTimeSlot) return;
  if (STATE.isToday && !STATE.selectedTableId) return;

  const guestName = getGuestFullName(booking);
  const covers = parseInt(document.getElementById('confirm-covers').value);
  const time = STATE.selectedTimeSlot.time;
  const dateStr = STATE.contextDate;

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
  if (STATE.dbbFieldId && STATE.dbbYesChoiceId && STATE.packageBookingIds.has(String(booking.booking_id))) {
    customFields.push({
      _id: STATE.dbbFieldId,
      name: 'DBB',
      value: STATE.dbbYesChoiceId,
      multipleChoiceValueName: 'Yes'
    });
  }

  const bookingPayload = {
    date: dateStr,
    time: time,
    people: covers,
    guest: {
      name: guestName
    },
    status: 'approved',
    languageCode: 'en',
    customFields: customFields
  };

  // Include selected table (today)
  if (STATE.isToday && STATE.selectedTableId) {
    bookingPayload.tables = [STATE.selectedTableId];
  }

  // Include opening hour for both today and future
  if (STATE.selectedTimeSlot && STATE.selectedTimeSlot.openingHourId) {
    bookingPayload.openingHourId = STATE.selectedTimeSlot.openingHourId;
  }

  if (phone) bookingPayload.guest.phone = phone;
  if (email) bookingPayload.guest.email = email;

  const createBtn = document.getElementById('create-booking-btn');
  createBtn.disabled = true;
  createBtn.classList.add('loading');
  hideFeedback();

  try {
    const resosApi = new ResosAPI(STATE.settings);
    await resosApi.createBooking(bookingPayload);

    document.getElementById('success-message').textContent =
      `${guestName} - ${covers} covers at ${time} on ${formatDateForDisplay(dateStr)}`;
    showView('success');

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
// URL CHANGE HANDLING
// ============================================================
async function handleUrlChange(url) {
  const newDate = parseDateFromUrl(url);
  const oldDate = STATE.contextDate;

  STATE.contextDate = newDate;
  STATE.isToday = newDate ? isDateToday(newDate) : false;
  STATE.currentBaseUrl = parseBaseUrl(url);

  if (!newDate) {
    showView('no-day');
    return;
  }

  // Only reload if date actually changed
  if (newDate !== oldDate) {
    if (STATE.settings) {
      await loadData();
    }
  }
}

async function getCurrentTabUrl() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getActiveTabUrl' }, (response) => {
      resolve(response?.url || '');
    });
  });
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

  // Get current tab URL and parse date
  const url = await getCurrentTabUrl();
  STATE.contextDate = parseDateFromUrl(url);
  STATE.isToday = STATE.contextDate ? isDateToday(STATE.contextDate) : false;
  STATE.currentBaseUrl = parseBaseUrl(url);

  if (!STATE.contextDate) {
    showView('no-day');
    return;
  }

  await loadData();
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (STATE.settings && STATE.contextDate) loadData();
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

  // Covers change -> reload time slots (debounced)
  document.getElementById('confirm-covers').addEventListener('change', debouncedLoadTimeSlots);

  // Create booking
  document.getElementById('create-booking-btn').addEventListener('click', createBooking);

  // Error retry
  document.getElementById('error-retry-btn').addEventListener('click', () => {
    if (STATE.settings && STATE.contextDate) loadData();
  });

  // Success done
  document.getElementById('success-done-btn').addEventListener('click', () => {
    renderGuestList();
    showView('guest-list');
  });
});

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'settingsUpdated') {
    STATE.settings = message.settings;
    if (STATE.contextDate) loadData();
  } else if (message.action === 'urlChanged') {
    handleUrlChange(message.url);
  }
});
