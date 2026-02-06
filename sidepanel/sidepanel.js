// Resos NewBook Assistant - Sidepanel Logic

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
  orphanResosBookings: [],  // Resos bookings with hotel ref not found in Newbook
  currentBaseUrl: null, // base URL for constructing Resos booking links
  selectedBooking: null,
  selectedTableId: null,
  selectedTimeSlot: null,  // { time, openingHourId }
  availableTables: [],
  filterHideMatched: true,
  searchQuery: ''
};

let tableLoadDebounce = null;
let autoRefreshTimer = null;
let lastCheckTime = null;
let refreshTimerInterval = null;
let lastDataHash = null;
let successCountdownTimer = null;
let successCountdownSeconds = 0;

// Connect a port so background can track when the sidepanel opens/closes
chrome.runtime.connect({ name: 'sidepanel' });

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

  async fetchOpeningHours() {
    const response = await fetch(`${this.baseUrl}/openingHours`, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Resos opening hours error: ${response.status}`);
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

  async updateBooking(bookingId, data) {
    const response = await fetch(`${this.baseUrl}/bookings/${bookingId}`, {
      method: 'PUT',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errorBody = await response.text();
        errorDetail = errorBody ? ` - ${errorBody}` : '';
      } catch (_) {}
      throw new Error(`Resos update booking error: ${response.status}${errorDetail}`);
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
    detectOrphanBookings();
    renderGuestList();
    showView('guest-list');

    // Store hash for silent refresh comparison
    lastDataHash = computeDataHash(newbookBookings, resosBookings);
    resetAutoRefreshTimer();
    startRefreshTimerDisplay();
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
// ORPHAN BOOKING DETECTION
// ============================================================
function detectOrphanBookings() {
  STATE.orphanResosBookings = [];

  if (!STATE.bookingRefFieldId) return;

  const activeStatuses = new Set(['approved', 'arrived', 'seated', 'left']);
  const newbookIds = new Set(STATE.newbookBookings.map(b => String(b.booking_id)));

  for (const resosBooking of STATE.resosBookings) {
    if (!activeStatuses.has(resosBooking.status)) continue;
    if (!resosBooking.customFields) continue;

    // Check if this booking has a hotel booking reference
    for (const cf of resosBooking.customFields) {
      const isBookingRefField = cf._id === STATE.bookingRefFieldId ||
        cf.id === STATE.bookingRefFieldId;
      if (isBookingRefField && cf.value) {
        const refId = String(cf.value).trim();
        // If this reference is not in the current Newbook bookings list, it's an orphan
        if (refId && !newbookIds.has(refId)) {
          STATE.orphanResosBookings.push({
            resosBooking,
            hotelBookingRef: refId
          });
        }
        break;
      }
    }
  }
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

  // Show hidden matched count when filter is active
  const hiddenCountEl = document.getElementById('hidden-count');
  if (STATE.filterHideMatched && !isSearching) {
    const hiddenCount = STATE.newbookBookings.filter(b => STATE.matchedBookingIds.has(String(b.booking_id))).length;
    if (hiddenCount > 0) {
      hiddenCountEl.textContent = hiddenCount;
      hiddenCountEl.classList.remove('hidden');
    } else {
      hiddenCountEl.classList.add('hidden');
    }
  } else {
    hiddenCountEl.classList.add('hidden');
  }

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

  bookings.sort((a, b) => {
    const roomA = a.site_name || '';
    const roomB = b.site_name || '';
    const numA = parseInt(roomA, 10);
    const numB = parseInt(roomB, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return roomA.localeCompare(roomB, undefined, { numeric: true });
  });

  for (const booking of bookings) {
    container.appendChild(createGuestCard(booking));
  }

  updateStatsBar();
  updateMarkLeftButton();
  renderOrphanWarning();
}

function renderOrphanWarning() {
  const container = document.getElementById('orphan-warning');
  const list = document.getElementById('orphan-list');

  if (!STATE.orphanResosBookings || STATE.orphanResosBookings.length === 0) {
    container.classList.add('hidden');
    return;
  }

  list.innerHTML = '';

  for (const { resosBooking, hotelBookingRef } of STATE.orphanResosBookings) {
    const li = document.createElement('li');

    // Time
    const time = resosBooking.dateTime
      ? new Date(resosBooking.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    // Guest name
    const name = (resosBooking.guest && resosBooking.guest.name) ||
      resosBooking.name ||
      `Booking ${resosBooking._id.slice(-6)}`;

    // Covers
    const covers = resosBooking.people || 1;

    li.innerHTML = `<span>${escapeHtml(time)} - ${escapeHtml(name)} (${covers}pax) [#${escapeHtml(hotelBookingRef)}]</span>`;

    // Make clickable to open in Resos
    if (STATE.currentBaseUrl) {
      li.classList.add('clickable');
      li.addEventListener('click', () => {
        const bookingUrl = `${STATE.currentBaseUrl}/${resosBooking._id}`;
        chrome.runtime.sendMessage({ action: 'navigateTab', url: bookingUrl });
      });
    }

    list.appendChild(li);
  }

  container.classList.remove('hidden');
}

function getNewbookStatusClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'unconfirmed': return 'nb-status-unconfirmed';
    case 'confirmed': return 'nb-status-confirmed';
    case 'arrived': return 'nb-status-arrived';
    case 'departed': return 'nb-status-departed';
    default: return 'nb-status-default';
  }
}

function getStayNightIcons(booking) {
  if (!booking.booking_arrival || !booking.booking_departure) return '';
  const arrivalDate = booking.booking_arrival.split(' ')[0];
  const departureDate = booking.booking_departure.split(' ')[0];
  // Last night = the day before departure (checkout morning)
  const depDate = new Date(departureDate + 'T12:00:00');
  depDate.setDate(depDate.getDate() - 1);
  const lastNightDate = `${depDate.getFullYear()}-${String(depDate.getMonth() + 1).padStart(2, '0')}-${String(depDate.getDate()).padStart(2, '0')}`;

  const isFirstNight = arrivalDate === STATE.contextDate;
  const isLastNight = lastNightDate === STATE.contextDate;

  let icons = '';
  if (isFirstNight) icons += '<span class="material-symbols-outlined night-icon night-icon-arrive" title="First night (arriving)">flight_land</span>';
  if (isLastNight) icons += '<span class="material-symbols-outlined night-icon night-icon-depart" title="Last night (departing)">flight_takeoff</span>';
  return icons;
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

  const resosBookingId = STATE.matchedBookingResosMap.get(bookingIdStr);
  const arrowIcon = (isMatched && resosBookingId) ? 'open_in_new' : 'chevron_right';

  const status = booking.booking_status || '';
  const statusClass = getNewbookStatusClass(status);
  const nightIcons = getStayNightIcons(booking);

  const dbbInline = isPackage ? `<span class="package-badge">DBB ${totalGuests}pax</span>` : '';
  const matchedIcon = isMatched ? '<span class="material-symbols-outlined matched-icon" title="Has Resos booking">restaurant</span>' : '';

  card.innerHTML = `
    <div class="guest-card-main">
      <div class="guest-card-name">
        ${escapeHtml(guestName)}
        <span class="nb-status-badge ${statusClass}">${escapeHtml(status).toUpperCase()}</span>
        ${nightIcons}
      </div>
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
        ${dbbInline}
      </div>
    </div>
    ${matchedIcon}
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
    const [times, openingHours] = await Promise.all([
      resosApi.fetchAvailableTimes(STATE.contextDate, covers),
      resosApi.fetchOpeningHours()
    ]);

    document.getElementById('timeslots-loading').classList.add('hidden');

    // Build opening hours lookup by _id
    const ohMap = new Map();
    for (const oh of openingHours) {
      ohMap.set(oh._id, oh);
    }

    // Response is array of opening hour period objects with availableTimes
    const periods = times || [];
    const hasAny = periods.some(p =>
      ohMap.has(p._id) ||
      (p.availableTimes && p.availableTimes.length > 0));

    if (!hasAny) {
      document.getElementById('timeslots-empty').classList.remove('hidden');
      return;
    }

    renderTimeSlots(periods, ohMap);
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

function generateSlotsFromRange(openStr, closeStr, intervalMinutes = 15) {
  const openHHMM = parseTimeToHHMM(openStr);
  const closeHHMM = parseTimeToHHMM(closeStr);
  const slots = [];
  let current = openHHMM;
  while (current < closeHHMM) {
    const h = Math.floor(current / 100);
    const m = current % 100;
    slots.push({
      timeStr: `${h}:${String(m).padStart(2, '0')}`,
      hhmm: current
    });
    // Advance by interval
    const totalMins = h * 60 + m + intervalMinutes;
    current = Math.floor(totalMins / 60) * 100 + (totalMins % 60);
  }
  return slots;
}

function renderTimeSlots(periods, ohMap) {
  const container = document.getElementById('timeslots-list');
  container.innerHTML = '';

  const nowHHMM = getCurrentHHMM();
  const sections = []; // track { header, content } for accordion

  // Default to last period with any data (latest service, e.g. dinner)
  let defaultExpandIndex = -1;
  for (let i = periods.length - 1; i >= 0; i--) {
    const p = periods[i];
    if (ohMap.has(p._id) || (p.availableTimes && p.availableTimes.length > 0)) {
      defaultExpandIndex = i;
      break;
    }
  }

  let autoSelectBtn = null;

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const available = period.availableTimes || [];

    // Normalize available times to "H:MM" format for consistent lookup
    const normalizedAvailable = new Set(available.map(t => {
      const parts = t.split(':');
      return parseInt(parts[0]) + ':' + (parts[1] || '00').padStart(2, '0');
    }));

    // Build slot list from opening hours (open to close-duration at interval steps)
    const oh = ohMap.get(period._id);
    let allSlots;
    if (oh && oh.open != null && oh.close != null) {
      const interval = (oh.seating && oh.seating.interval) || 15;
      const duration = (oh.seating && oh.seating.duration) || 120;
      const openMins = Math.floor(oh.open / 100) * 60 + (oh.open % 100);
      const closeMins = Math.floor(oh.close / 100) * 60 + (oh.close % 100);
      // Last bookable slot: close minus duration (booking must fit within hours)
      const lastBookableMins = closeMins - duration;
      // Pass lastBookable + interval as exclusive end so last slot is included
      const endMins = lastBookableMins + interval;
      const fmtMins = (mins) => {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}:${String(m).padStart(2, '0')}`;
      };
      allSlots = generateSlotsFromRange(fmtMins(openMins), fmtMins(endMins), interval);
    } else if (available.length > 0) {
      // Fallback: just show available times directly (all clickable)
      allSlots = available
        .map(t => ({ timeStr: t, hhmm: parseTimeToHHMM(t) }))
        .sort((a, b) => a.hhmm - b.hhmm);
    } else {
      continue; // no opening hours and no available times
    }

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
      const isAvailable = normalizedAvailable.has(slot.timeStr);
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

      // Auto-select: slot closest to current time in default-expanded period (today, for walk-ins)
      if (STATE.isToday && i === defaultExpandIndex && !autoSelectBtn && slot.hhmm >= nowHHMM) {
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
    source: 'api',
    note: 'Created by Resos NewBook Assistant',
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
  if (email) {
    bookingPayload.guest.email = email;
    // Send notification email if setting enabled and email available
    if (STATE.settings.sendGuestNotification) {
      bookingPayload.guest.notificationEmail = true;
    }
  }

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
    startSuccessCountdown();

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
// AUTO-REFRESH
// ============================================================
function resetAutoRefreshTimer() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;

  const seconds = STATE.settings && STATE.settings.autoRefreshSeconds;
  if (!seconds || seconds <= 0) return;

  // Only auto-refresh when on the guest list view
  if (STATE.view !== 'guest-list') return;
  if (!STATE.contextDate || !STATE.settings) return;

  autoRefreshTimer = setTimeout(() => {
    if (STATE.view === 'guest-list' && STATE.contextDate && STATE.settings) {
      silentRefresh();
    }
  }, seconds * 1000);
}

function startRefreshTimerDisplay() {
  lastCheckTime = Date.now();
  updateRefreshTimerDisplay();

  // Clear any existing interval
  if (refreshTimerInterval) clearInterval(refreshTimerInterval);

  // Update every second
  refreshTimerInterval = setInterval(updateRefreshTimerDisplay, 1000);
}

function updateRefreshTimerDisplay() {
  const timerEl = document.getElementById('refresh-timer');
  if (!timerEl || !lastCheckTime) {
    if (timerEl) timerEl.textContent = '';
    return;
  }

  const elapsed = Math.floor((Date.now() - lastCheckTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  timerEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
}

function computeDataHash(newbookBookings, resosBookings) {
  // Create a simple hash from booking IDs and key fields
  const nbIds = newbookBookings.map(b => `${b.booking_id}:${b.booking_status}`).sort().join(',');
  const rsIds = resosBookings.map(b => `${b._id}:${b.status}:${b.people}`).sort().join(',');
  return nbIds + '|' + rsIds;
}

// ============================================================
// SUCCESS COUNTDOWN
// ============================================================
function startSuccessCountdown() {
  clearSuccessCountdown();
  successCountdownSeconds = 10;
  updateSuccessCountdownDisplay();

  successCountdownTimer = setInterval(() => {
    successCountdownSeconds--;
    updateSuccessCountdownDisplay();

    if (successCountdownSeconds <= 0) {
      clearSuccessCountdown();
      triggerSuccessDone();
    }
  }, 1000);
}

function updateSuccessCountdownDisplay() {
  const el = document.getElementById('success-countdown');
  if (el) {
    el.textContent = `Returning in ${successCountdownSeconds}s...`;
  }
}

function clearSuccessCountdown() {
  if (successCountdownTimer) {
    clearInterval(successCountdownTimer);
    successCountdownTimer = null;
  }
  const el = document.getElementById('success-countdown');
  if (el) el.textContent = '';
}

function triggerSuccessDone() {
  renderGuestList();
  showView('guest-list');
  resetAutoRefreshTimer();
}

async function silentRefresh() {
  if (!STATE.settings || !STATE.contextDate) return;

  try {
    const newbookApi = new NewbookAPI(STATE.settings);
    const resosApi = new ResosAPI(STATE.settings);

    const [newbookBookings, resosBookings] = await Promise.all([
      newbookApi.fetchStayingOnDate(STATE.contextDate),
      resosApi.fetchBookingsForDate(STATE.contextDate)
    ]);

    // Update the check time
    startRefreshTimerDisplay();

    // Compare with previous data
    const newHash = computeDataHash(newbookBookings, resosBookings);
    if (newHash === lastDataHash) {
      // No changes, just reset the auto-refresh timer
      resetAutoRefreshTimer();
      return;
    }

    // Data changed - update state and re-render
    lastDataHash = newHash;
    STATE.newbookBookings = newbookBookings;
    STATE.resosBookings = resosBookings;

    buildMatchedSet();
    buildPackageSet();
    detectOrphanBookings();
    renderGuestList();
    resetAutoRefreshTimer();
  } catch (error) {
    console.error('Silent refresh error:', error);
    // Don't show error to user for silent refresh, just reset timer
    resetAutoRefreshTimer();
  }
}

// ============================================================
// MARK PAST AS LEFT
// ============================================================
function isBookingPast(booking) {
  // For past dates, all bookings are considered past
  if (STATE.contextDate < getTodayDateString()) return true;
  // For today, check if booking time + duration has elapsed
  if (!booking.dateTime) return false;
  const start = new Date(booking.dateTime).getTime();
  const durationMs = (booking.duration || 0) * 60000;
  return (start + durationMs) <= Date.now();
}

function updateStatsBar() {
  const total = STATE.newbookBookings.length;
  const matched = STATE.newbookBookings.filter(b => STATE.matchedBookingIds.has(String(b.booking_id))).length;

  let arrivalsTotal = 0, arrivalsMatched = 0;
  let departuresTotal = 0, departuresMatched = 0;

  for (const booking of STATE.newbookBookings) {
    const isMatched = STATE.matchedBookingIds.has(String(booking.booking_id));

    if (booking.booking_arrival) {
      const arrivalDate = booking.booking_arrival.split(' ')[0];
      if (arrivalDate === STATE.contextDate) {
        arrivalsTotal++;
        if (isMatched) arrivalsMatched++;
      }
    }
    if (booking.booking_departure) {
      const departureDate = booking.booking_departure.split(' ')[0];
      const depDate = new Date(departureDate + 'T12:00:00');
      depDate.setDate(depDate.getDate() - 1);
      const lastNightDate = `${depDate.getFullYear()}-${String(depDate.getMonth() + 1).padStart(2, '0')}-${String(depDate.getDate()).padStart(2, '0')}`;
      if (lastNightDate === STATE.contextDate) {
        departuresTotal++;
        if (isMatched) departuresMatched++;
      }
    }
  }

  // Resos booking stats
  const activeStatuses = new Set(['approved', 'arrived', 'seated', 'left']);
  let resosTotalBookings = 0, resosTotalCovers = 0;
  let dbbBookings = 0, dbbCovers = 0;
  let nonResidentBookings = 0, nonResidentCovers = 0;
  let hotelGuestBookings = 0, hotelGuestCovers = 0;

  for (const b of STATE.resosBookings) {
    if (!activeStatuses.has(b.status)) continue;

    resosTotalBookings++;
    resosTotalCovers += b.people || 0;

    let isHotelGuest = false;
    let isDbb = false;

    if (b.customFields) {
      for (const cf of b.customFields) {
        if (STATE.hotelGuestFieldId && STATE.hotelGuestYesChoiceId &&
            (cf._id === STATE.hotelGuestFieldId || cf.id === STATE.hotelGuestFieldId) &&
            cf.value === STATE.hotelGuestYesChoiceId) {
          isHotelGuest = true;
        }
        if (STATE.dbbFieldId && STATE.dbbYesChoiceId &&
            (cf._id === STATE.dbbFieldId || cf.id === STATE.dbbFieldId) &&
            cf.value === STATE.dbbYesChoiceId) {
          isDbb = true;
        }
      }
    }

    if (isDbb) {
      dbbBookings++;
      dbbCovers += b.people || 0;
    }

    if (isHotelGuest) {
      hotelGuestBookings++;
      hotelGuestCovers += b.people || 0;
    } else {
      nonResidentBookings++;
      nonResidentCovers += b.people || 0;
    }
  }

  document.getElementById('stat-total').textContent = `${matched}/${total}`;
  document.getElementById('stat-arrivals').textContent = `${arrivalsMatched}/${arrivalsTotal}`;
  document.getElementById('stat-departures').textContent = `${departuresMatched}/${departuresTotal}`;
  document.getElementById('stat-resos-total').textContent = `${resosTotalBookings} (${resosTotalCovers})`;
  document.getElementById('stat-dbb').textContent = `${dbbBookings} (${dbbCovers})`;
  document.getElementById('stat-nonresident').textContent = `${nonResidentBookings} (${nonResidentCovers})`;
  document.getElementById('stat-hotelguest').textContent = `${hotelGuestBookings} (${hotelGuestCovers})`;
}

function updateMarkLeftButton() {
  const btn = document.getElementById('mark-all-left-btn');
  const count = STATE.resosBookings.filter(
    b => (b.status === 'seated' || b.status === 'arrived') && isBookingPast(b)
  ).length;

  const isTodayOrPast = STATE.contextDate && STATE.contextDate <= getTodayDateString();
  if (isTodayOrPast && count > 0) {
    btn.classList.remove('hidden');
    btn.innerHTML = `<span class="material-symbols-outlined">logout</span> Mark past as left (${count})`;
    btn.disabled = false;
  } else {
    btn.classList.add('hidden');
  }
}

async function markAllAsLeft() {
  const btn = document.getElementById('mark-all-left-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">sync</span> Refreshing...';

  try {
    const resosApi = new ResosAPI(STATE.settings);

    // Fresh fetch to pick up any changes made in Resos since last load
    const freshBookings = await resosApi.fetchBookingsForDate(STATE.contextDate);
    STATE.resosBookings = freshBookings;
    buildMatchedSet();
    detectOrphanBookings();
    renderGuestList();

    // Update hash for silent refresh comparison
    lastDataHash = computeDataHash(STATE.newbookBookings, freshBookings);
    startRefreshTimerDisplay();

    const targetBookings = freshBookings.filter(
      b => (b.status === 'seated' || b.status === 'arrived') && isBookingPast(b)
    );

    if (targetBookings.length === 0) {
      btn.innerHTML = '<span class="material-symbols-outlined">check</span> No past bookings to update';
      setTimeout(() => {
        btn.innerHTML = '<span class="material-symbols-outlined">logout</span> Mark past as left';
      }, 2000);
      return;
    }

    // Populate and show confirmation modal
    showMarkLeftModal(targetBookings);
  } catch (error) {
    btn.textContent = 'Error: ' + error.message;
    setTimeout(() => {
      btn.innerHTML = '<span class="material-symbols-outlined">logout</span> Mark past as left';
      btn.disabled = false;
    }, 3000);
  }
}

function showMarkLeftModal(targetBookings) {
  const modal = document.getElementById('mark-left-modal');
  const list = document.getElementById('mark-left-modal-list');
  list.innerHTML = '';

  for (const b of targetBookings) {
    const li = document.createElement('li');
    const name = (b.guest && b.guest.name) || b.name || `Booking ${b._id.slice(-6)}`;
    const time = b.dateTime
      ? new Date(b.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    li.innerHTML = `<span>${escapeHtml(name)}${time ? ' &middot; ' + time : ''}</span>
      <span class="modal-list-status">${b.status}</span>`;
    list.appendChild(li);
  }

  // Store targets for confirm handler
  modal.dataset.bookingIds = JSON.stringify(targetBookings.map(b => b._id));
  modal.classList.remove('hidden');
}

async function confirmMarkAllAsLeft() {
  const modal = document.getElementById('mark-left-modal');
  const confirmBtn = document.getElementById('mark-left-confirm');
  const ids = JSON.parse(modal.dataset.bookingIds || '[]');

  if (ids.length === 0) { modal.classList.add('hidden'); return; }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Updating...';

  try {
    const resosApi = new ResosAPI(STATE.settings);
    const results = await Promise.allSettled(
      ids.map(id => resosApi.updateBooking(id, { status: 'left' }))
    );

    const failed = results.filter(r => r.status === 'rejected').length;

    // Update local state
    for (const b of STATE.resosBookings) {
      if (ids.includes(b._id)) b.status = 'left';
    }
    buildMatchedSet();
    detectOrphanBookings();
    renderGuestList();

    modal.classList.add('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';

    const mainBtn = document.getElementById('mark-all-left-btn');
    if (failed === 0) {
      mainBtn.innerHTML = '<span class="material-symbols-outlined">check</span> All marked as left';
    } else {
      mainBtn.textContent = `${ids.length - failed} updated, ${failed} failed`;
    }
    setTimeout(() => {
      mainBtn.innerHTML = '<span class="material-symbols-outlined">logout</span> Mark past as left';
      mainBtn.disabled = false;
    }, 2000);
  } catch (error) {
    confirmBtn.textContent = 'Error';
    setTimeout(() => {
      modal.classList.add('hidden');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }, 2000);
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
  document.getElementById('settings-btn')?.addEventListener('click', () => {
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
    clearSuccessCountdown();
    triggerSuccessDone();
  });

  // Mark all as left
  document.getElementById('mark-all-left-btn').addEventListener('click', markAllAsLeft);
  document.getElementById('mark-left-confirm').addEventListener('click', confirmMarkAllAsLeft);
  document.getElementById('mark-left-cancel').addEventListener('click', () => {
    document.getElementById('mark-left-modal').classList.add('hidden');
    document.getElementById('mark-all-left-btn').disabled = false;
  });

  // Reset auto-refresh timer on any user interaction
  document.addEventListener('click', resetAutoRefreshTimer);
  document.addEventListener('keydown', resetAutoRefreshTimer);
});

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'settingsUpdated') {
    STATE.settings = message.settings;
    resetAutoRefreshTimer();
    if (STATE.contextDate) loadData();
  } else if (message.action === 'urlChanged') {
    handleUrlChange(message.url);
  }
});
