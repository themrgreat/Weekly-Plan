console.clear();

/* ==========================================================================
   Zoho CRM Widget : Weekly Plan  -  Application layer
   --------------------------------------------------------------------------
   Architecture (single IIFE, no globals leaked except WeeklyPlan for debug):

     Log            console wrapper with a widget prefix
     Boundary       global error boundary -> never leaves a blank surface
     DateUtil       pure date helpers (next-3-Mondays logic lives here)
     Store          single source of truth + per-week draft cache (in-memory only)
     Validator      duplicate / empty / unlinked checks
     Lookup         CRM record search (Accounts / Vendors) + result cache
     Holidays       CRM business holidays -> auto-lock matching days
     Crm            record creation (Weekly_Planner + Meeting_Planned)
     Toast          transient feedback
     Modal          promise based confirm dialog
     Suggest        shared autocomplete popover for the lookup inputs
     View           DOM rendering (day cards, entry rows, badges, summary)
     App            bootstrap, SDK handshake, event wiring

   Module mapping (both fields are CRM lookups, not free text):

     "School"  ->  Accounts   name field: Account_Name
     "Dealer"  ->  Vendors    name field: Vendor_Name

   Data contract handed to Save (console only, per spec). `recordId` is the CRM
   record the row points at; it is '' only when the SDK is unavailable and the
   user fell back to typing a name by hand.

     state.days = [
       {
         id:        "2026-08-03",
         dayName:   "Monday",
         dayShort:  "Mon",
         dateISO:   "2026-08-03",
         dateLabel: "03 Aug 2026",
         status:    "Active",                           // Active | Holiday | Leave
         holidayName: "",                               // set when locked by CRM
         locked:    false,                              // CRM holiday -> not editable
         schools:   [{ id, recordId, name, reason, transport }], // recordId -> Accounts
         dealers:   [{ id, recordId, name, reason, transport }]  // recordId -> Vendors
       }, ... Saturday
     ]

   Save creates two things (see App.buildPlannerRecord / buildMeetingRecords):

     Weekly_Planner    1 record. Name is derived ("03 Aug 2026 – 08 Aug
                       2026"). Subform Plan_Details holds one row per visit;
                       a row is single-sided — School_Name OR Dealer_Name, never
                       both — with Purpose, Transport_Medium and Schedule_Status.
                       Holiday / Leave days contribute one status-only row.

     Meeting_Planned   one record per visit, plus one per Holiday / Leave day
                       (Day_Status mirrors Schedule_Status, no school/dealer
                       lookups set). Every meeting record — visit or off-day —
                       carries the Weekly_Planner lookup pointing back at the
                       planner created in the same save, so the week's meetings
                       hang off their planner in CRM.
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     CONFIG
     ====================================================================== */

  var CONFIG = {
    WIDGET_NAME: 'Weekly Plan',
    WEEKS_TO_SHOW: 4,          // next 4 Mondays
    DAYS_PER_WEEK: 6,          // Monday .. Saturday (Sunday excluded)
    MAX_ROWS_PER_TYPE: 25,     // safety cap per day / per type
    SDK_TIMEOUT_MS: 5000,      // stop waiting on the SDK after this
    TOAST_TIMEOUT_MS: 3800,
    WIDGET_CLOSE_DELAY_MS: 1500,   // let the success toast be seen before auto-closing

    /* Lookup autocomplete */
    SEARCH_DEBOUNCE_MS: 280,   // keystroke -> CRM search
    SEARCH_MIN_CHARS: 1,       // searchRecord needs at least one character
    SEARCH_MAX_RESULTS: 8,     // rows shown in the popover
    SEARCH_CACHE_MAX: 60,      // per-term result cache entries

    /* CRM write targets (module API names, not display labels) */
    PLANNER_MODULE: 'Weekly_Planner',
    PLANNER_SUBFORM: 'Plan_Details',
    PLANNER_DEFAULT_STATUS: 'Draft',   // Status (api name: Status) picklist default on create
    MEETING_MODULE: 'Meeting_Planned',
    /* Lookup on Meeting_Planned that points back at the Weekly_Planner record */
    MEETING_PLANNER_LOOKUP: 'Weekly_Planner',
    INSERT_BATCH_MAX: 100,     // insertRecord accepts at most 100 rows per call

    /* Business holidays (Deluge equivalent: invokeUrl + connection "zohocrm") */
    HOLIDAY_CONNECTION: 'zohocrm',
    HOLIDAY_URL: 'https://www.zohoapis.in/crm/v8/settings/holidays'
  };

  /* Purpose picklist — values must match the CRM picklist exactly. */
  var REASONS = [
    'Meeting',
    'Demo',
    'Collection',
    'Follow-up',
    'Complaint',
    'Training',
    'Service',
    'Payment Collection',
    'Other'
  ];

  /**
   * Transport_Medium picklist. Same contract as REASONS: every entry row owns
   * its own value, and the strings must match the CRM picklist exactly.
   */
  var TRANSPORTS = [
    'Own Vehicle',
    'Company Vehicle',
    'Two Wheeler',
    'Car',
    'Taxi / Cab',
    'Auto',
    'Bus',
    'Train',
    'Flight',
    'Walk'
  ];

  /* Schedule_Status picklist. Only ACTIVE days accept schools / dealers. */
  var STATUS_ACTIVE = 'Active';
  var STATUS_HOLIDAY = 'Holiday';
  var STATUS_LEAVE = 'Leave';
  var SCHEDULE_STATUSES = [STATUS_ACTIVE, STATUS_HOLIDAY, STATUS_LEAVE];

  /* Weekly_Planner Status picklist value that does NOT block re-creation. */
  var PLANNER_STATUS_REJECTED = 'Reject';

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * A "School" is an Accounts record and a "Dealer" is a Vendors record.
   * `module` / `nameField` drive ZOHO.CRM.API.searchRecord; everything the user
   * reads still says School / Dealer.
   */
  var ENTRY_META = {
    school: {
      key: 'schools', label: 'School', labelPlural: 'Schools',
      placeholder: 'Search schools…', module: 'Accounts', nameField: 'Account_Name'
    },
    dealer: {
      key: 'dealers', label: 'Dealer', labelPlural: 'Dealers',
      placeholder: 'Search dealers…', module: 'Vendors', nameField: 'Vendor_Name'
    }
  };

  var ICONS = {
    school:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M22 9 12 4 2 9l10 5 10-5Z"/>' +
      '<path d="M6 11.5V17c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5.5"/></svg>',
    dealer:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M4 21V8l8-5 8 5v13"/>' +
      '<path d="M9 21v-6h6v6"/></svg>',
    success:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>' +
      '<path d="M12 9v4M12 17h.01"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
  };

  /* ======================================================================
     LOG
     ====================================================================== */

  var Log = {
    _tag: '[' + CONFIG.WIDGET_NAME + ']',
    info: function () { this._out('log', arguments); },
    warn: function () { this._out('warn', arguments); },
    error: function () { this._out('error', arguments); },
    _out: function (level, args) {
      try {
        if (typeof console === 'undefined' || !console[level]) { return; }
        var list = Array.prototype.slice.call(args);
        list.unshift(this._tag);
        console[level].apply(console, list);
      } catch (e) { /* logging must never break the widget */ }
    }
  };

  /* ======================================================================
     DOM HELPERS
     ====================================================================== */

  var Dom = {
    /** Safe getElementById; logs (but never throws) when an element is absent. */
    byId: function (id) {
      var el = document.getElementById(id);
      if (!el) { Log.warn('Missing element #' + id); }
      return el;
    },
    on: function (el, type, handler, options) {
      if (el && el.addEventListener) { el.addEventListener(type, handler, options || false); }
    },
    show: function (el) { if (el) { el.hidden = false; } },
    hide: function (el) { if (el) { el.hidden = true; } },
    text: function (el, value) { if (el) { el.textContent = value == null ? '' : String(value); } },
    clear: function (el) { while (el && el.firstChild) { el.removeChild(el.firstChild); } },
    /** Clone a <template> body; returns null instead of throwing when missing. */
    fromTemplate: function (templateId) {
      try {
        var tpl = document.getElementById(templateId);
        if (!tpl || !tpl.content) { throw new Error('Template ' + templateId + ' unavailable'); }
        var frag = tpl.content.cloneNode(true);
        return frag.firstElementChild;
      } catch (err) {
        Log.error('Template clone failed:', err);
        return null;
      }
    }
  };

  /* ======================================================================
     BOUNDARY - global error boundary
     Guarantees the user always sees a message + recovery action.
     ====================================================================== */

  var Boundary = {
    _banner: null,
    _textEl: null,
    _count: 0,

    init: function () {
      this._banner = document.getElementById('globalError');
      this._textEl = document.getElementById('globalErrorText');

      Dom.on(document.getElementById('globalErrorReload'), 'click', function () {
        try { window.location.reload(); } catch (e) { Log.error('Reload failed:', e); }
      });
      Dom.on(document.getElementById('globalErrorDismiss'), 'click', this.hide.bind(this));

      window.onerror = function (message, source, line, col, error) {
        Boundary.report(error || message, 'window.onerror');
        return false; // keep native logging
      };

      Dom.on(window, 'unhandledrejection', function (event) {
        Boundary.report((event && event.reason) || 'Unhandled promise rejection', 'unhandledrejection');
      });
    },

    /** Show the banner and log full detail. Never throws. */
    report: function (error, context) {
      try {
        this._count++;
        Log.error('(' + (context || 'runtime') + ')', error);
        if (this._count > 20) { return; } // avoid feedback loops
        var msg = this.describe(error);
        Dom.text(this._textEl, msg + ' Your entries on screen are safe — you can keep working or reload.');
        Dom.show(this._banner);
      } catch (e) { /* last line of defence */ }
    },

    describe: function (error) {
      if (!error) { return 'An unexpected error occurred.'; }
      if (typeof error === 'string') { return error; }
      if (error.message) { return String(error.message); }
      return 'An unexpected error occurred.';
    },

    hide: function () { Dom.hide(this._banner); },

    /**
     * Wraps a handler so a thrown error surfaces in the banner instead of
     * silently killing the listener (a classic source of "dead" widgets).
     */
    guard: function (fn, context) {
      return function () {
        try {
          return fn.apply(this, arguments);
        } catch (err) {
          Boundary.report(err, context);
          return undefined;
        }
      };
    }
  };

  /* ======================================================================
     DATEUTIL - pure, testable date helpers
     ====================================================================== */

  var DateUtil = {
    /** Midnight copy of a date (guards against invalid input). */
    startOfDay: function (date) {
      var d = date instanceof Date && !isNaN(date.getTime()) ? new Date(date.getTime()) : new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    },

    addDays: function (date, days) {
      var d = this.startOfDay(date);
      d.setDate(d.getDate() + days);
      return d;
    },

    /**
     * Days from `from` until the NEXT Monday, strictly in the future.
     *   Sunday   -> 1  (tomorrow's Monday is included)
     *   Monday   -> 7  (today's Monday is skipped)
     *   Thursday -> 4
     */
    daysUntilNextMonday: function (from) {
      var dow = this.startOfDay(from).getDay();      // 0 = Sunday .. 6 = Saturday
      var delta = (8 - dow) % 7;
      return delta === 0 ? 7 : delta;
    },

    /** The next `count` Mondays after today (today excluded). */
    nextMondays: function (count, from) {
      var base = this.startOfDay(from || new Date());
      var first = this.addDays(base, this.daysUntilNextMonday(base));
      var list = [];
      var total = Math.max(1, count || CONFIG.WEEKS_TO_SHOW);
      for (var i = 0; i < total; i++) {
        list.push(this.addDays(first, i * 7));
      }
      return list;
    },

    /** "2026-08-03" - stable key, timezone independent (local parts). */
    toISO: function (date) {
      var d = this.startOfDay(date);
      return d.getFullYear() + '-' + this.pad(d.getMonth() + 1) + '-' + this.pad(d.getDate());
    },

    /** "04 Aug" — year appended only when it differs from the current year. */
    shortLabel: function (date, referenceYear) {
      var d = this.startOfDay(date);
      var label = this.pad(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()];
      var ref = typeof referenceYear === 'number' ? referenceYear : new Date().getFullYear();
      return d.getFullYear() !== ref ? label + ' ' + d.getFullYear() : label;
    },

    /** "03 Aug 2026" */
    longLabel: function (date) {
      var d = this.startOfDay(date);
      return this.pad(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
    },

    dayName: function (date) { return DAY_NAMES[this.startOfDay(date).getDay()]; },

    pad: function (n) { return (n < 10 ? '0' : '') + n; }
  };

  /* ======================================================================
     IDS
     ====================================================================== */

  var uid = (function () {
    var seq = 0;
    return function (prefix) {
      seq++;
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq;
    };
  })();

  /* ======================================================================
     STORE - single source of truth
     ====================================================================== */

  var state = {
    ready: false,
    sdkConnected: false,
    weeks: [],            // [{ id, date, label, endLabel, rangeLabel }]
    selectedWeekId: '',
    days: [],             // active week: 6 day objects (Mon..Sat)
    drafts: {},           // weekId -> serialised day list (other weeks kept alive)
    submitting: false,    // guards against a double click creating two planners
    createdPlanners: {}   // weekId -> Weekly_Planner id already created
  };

  var Store = {
    /** Build the week options from today's date. */
    buildWeeks: function () {
      var today = new Date();
      var year = today.getFullYear();
      var mondays = DateUtil.nextMondays(CONFIG.WEEKS_TO_SHOW, today);

      state.weeks = mondays.map(function (monday) {
        var saturday = DateUtil.addDays(monday, CONFIG.DAYS_PER_WEEK - 1);
        return {
          id: DateUtil.toISO(monday),
          date: monday,
          label: DateUtil.shortLabel(monday, year),
          rangeLabel: DateUtil.longLabel(monday) + '  –  ' + DateUtil.longLabel(saturday)
        };
      });

      return state.weeks;
    },

    getWeek: function (weekId) {
      for (var i = 0; i < state.weeks.length; i++) {
        if (state.weeks[i].id === weekId) { return state.weeks[i]; }
      }
      return null;
    },

    /** Create Monday..Saturday day objects for a week id. */
    createDays: function (weekId) {
      var week = this.getWeek(weekId);
      if (!week) { return []; }
      var days = [];
      for (var i = 0; i < CONFIG.DAYS_PER_WEEK; i++) {   // 0..5 -> Mon..Sat, Sunday never generated
        var date = DateUtil.addDays(week.date, i);
        var iso = DateUtil.toISO(date);
        var holiday = Holidays.forDate(iso);
        days.push({
          id: iso,
          dayName: DateUtil.dayName(date),
          dayShort: DateUtil.dayName(date).slice(0, 3),
          dateISO: iso,
          dateLabel: DateUtil.longLabel(date),
          // A CRM business holiday forces Holiday and locks the picklist.
          status: holiday ? STATUS_HOLIDAY : STATUS_ACTIVE,
          holidayName: holiday ? holiday.name : '',
          locked: !!holiday,
          schools: [],
          dealers: []
        });
      }
      return days;
    },

    /** Switch active week, restoring any cached draft for it. */
    selectWeek: function (weekId) {
      if (state.selectedWeekId && state.days.length) {
        this.cacheCurrentWeek();
      }
      state.selectedWeekId = weekId;
      state.days = this.hydrate(weekId);
      return state.days;
    },

    /** Rebuild days for a week from the draft cache (or fresh when absent). */
    hydrate: function (weekId) {
      var days = this.createDays(weekId);
      var draft = state.drafts[weekId];
      if (!draft || !Array.isArray(draft)) { return days; }

      try {
        days.forEach(function (day) {
          var saved = null;
          for (var i = 0; i < draft.length; i++) {
            if (draft[i] && draft[i].id === day.id) { saved = draft[i]; break; }
          }
          if (!saved) { return; }
          // A locked holiday always wins over whatever the draft remembered.
          if (!day.locked && SCHEDULE_STATUSES.indexOf(saved.status) > -1) {
            day.status = saved.status;
          }
          if (day.status !== STATUS_ACTIVE) { return; }
          ['schools', 'dealers'].forEach(function (key) {
            if (!Array.isArray(saved[key])) { return; }
            saved[key].slice(0, CONFIG.MAX_ROWS_PER_TYPE).forEach(function (entry) {
              if (!entry || typeof entry !== 'object') { return; }
              day[key].push({
                id: uid('e'),
                recordId: typeof entry.recordId === 'string' ? entry.recordId : '',
                name: typeof entry.name === 'string' ? entry.name.slice(0, 120) : '',
                reason: REASONS.indexOf(entry.reason) > -1 ? entry.reason : REASONS[0],
                // Drafts written before Transport_Medium existed fall back to
                // the first option rather than restoring an empty picklist.
                transport: TRANSPORTS.indexOf(entry.transport) > -1 ? entry.transport : TRANSPORTS[0]
              });
            });
          });
        });
      } catch (err) {
        Log.warn('Draft restore failed for ' + weekId + '; using an empty week.', err);
        return this.createDays(weekId);
      }
      return days;
    },

    cacheCurrentWeek: function () {
      if (!state.selectedWeekId) { return; }
      state.drafts[state.selectedWeekId] = JSON.parse(JSON.stringify(state.days));
    },

    /** Cache all in-memory drafts (current week included). Session-only, never touches disk. */
    persist: function () {
      try {
        this.cacheCurrentWeek();
      } catch (err) {
        Log.warn('Persist skipped:', err);
      }
    },

    getDay: function (dayId) {
      for (var i = 0; i < state.days.length; i++) {
        if (state.days[i].id === dayId) { return state.days[i]; }
      }
      return null;
    },

    listOf: function (day, type) {
      var meta = ENTRY_META[type];
      if (!day || !meta) { return []; }
      if (!Array.isArray(day[meta.key])) { day[meta.key] = []; }
      return day[meta.key];
    },

    addEntry: function (dayId, type) {
      var day = this.getDay(dayId);
      var list = this.listOf(day, type);
      if (!day || list.length >= CONFIG.MAX_ROWS_PER_TYPE) { return null; }
      var entry = {
        id: uid('e'), recordId: '', name: '',
        reason: REASONS[0], transport: TRANSPORTS[0]
      };
      list.push(entry);
      return entry;
    },

    getEntry: function (dayId, type, entryId) {
      var list = this.listOf(this.getDay(dayId), type);
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === entryId) { return list[i]; }
      }
      return null;
    },

    /** Record ids already used for a day+type, so the popover can flag them. */
    usedRecordIds: function (dayId, type, exceptEntryId) {
      var used = {};
      this.listOf(this.getDay(dayId), type).forEach(function (entry) {
        if (entry.recordId && entry.id !== exceptEntryId) { used[entry.recordId] = true; }
      });
      return used;
    },

    removeEntry: function (dayId, type, entryId) {
      var list = this.listOf(this.getDay(dayId), type);
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === entryId) { return list.splice(i, 1)[0]; }
      }
      return null;
    },

    updateEntry: function (dayId, type, entryId, field, value) {
      var list = this.listOf(this.getDay(dayId), type);
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === entryId) { list[i][field] = value; return list[i]; }
      }
      return null;
    },

    clearDay: function (dayId) {
      var day = this.getDay(dayId);
      if (!day) { return; }
      day.schools = [];
      day.dealers = [];
    },

    isActive: function (day) { return !!day && day.status === STATUS_ACTIVE; },

    /**
     * Set a day's Schedule_Status. Holiday / Leave drop any planned visits —
     * an off day carries no schools or dealers into the CRM payload.
     * @returns {boolean} false when the day is locked by a CRM holiday
     */
    setStatus: function (dayId, status) {
      var day = this.getDay(dayId);
      if (!day || day.locked || SCHEDULE_STATUSES.indexOf(status) < 0) { return false; }
      day.status = status;
      if (status !== STATUS_ACTIVE) { this.clearDay(dayId); }
      return true;
    },

    /** Reset the whole active week. */
    resetWeek: function () {
      state.days = this.createDays(state.selectedWeekId);
      delete state.drafts[state.selectedWeekId];
      this.persist();
      return state.days;
    },

    /** Aggregate counters used by the summary bar. */
    totals: function () {
      var out = { schools: 0, dealers: 0, days: 0, entries: 0, offDays: 0, incompleteDays: 0 };
      state.days.forEach(function (day) {
        if (day.status !== STATUS_ACTIVE) { out.offDays++; return; }
        var s = day.schools.length;
        var d = day.dealers.length;
        out.schools += s;
        out.dealers += d;
        if (s + d > 0) { out.days++; } else { out.incompleteDays++; }
      });
      out.entries = out.schools + out.dealers;
      return out;
    }
  };

  /* ======================================================================
     HOLIDAYS - CRM business holidays

     Deluge equivalent:
       invokeUrl [ url: ".../crm/v8/settings/holidays", type: GET,
                   connection: "zohocrm" ]

     From a widget the same call goes through ZOHO.CRM.CONNECTION.invoke, so a
     Connection named CONFIG.HOLIDAY_CONNECTION must exist in
     Setup > Developer Space > Connections with the ZohoCRM.settings scope.
     A failure here is never fatal: every day simply stays Active.
     ====================================================================== */

  var Holidays = {
    _byDate: {},
    _loaded: false,

    isLoaded: function () { return this._loaded; },

    /** @returns {?{date,name}} the holiday on that ISO date, if any */
    forDate: function (iso) {
      return this._byDate[iso] || null;
    },

    count: function () { return Object.keys(this._byDate).length; },

    _canInvoke: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM &&
                window.ZOHO.CRM.CONNECTION &&
                typeof window.ZOHO.CRM.CONNECTION.invoke === 'function');
    },

    /** Always resolves: { status: 'ok'|'skipped'|'error', count }. */
    load: function () {
      var self = this;
      if (!this._canInvoke()) {
        Log.warn('Holiday lookup skipped - no CRM connection available.');
        return Promise.resolve({ status: 'skipped', count: 0 });
      }

      try {
        return window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
          url: CONFIG.HOLIDAY_URL,
          method: 'GET',
          param_type: 1
        }).then(function (response) {
          var list = self._extract(response);
          self._index(list);
          self._loaded = true;
          Log.info('Loaded ' + self.count() + ' business holiday(s).');
          return { status: 'ok', count: self.count() };
        }).catch(function (err) {
          Log.warn('Holiday fetch failed:', err);
          return { status: 'error', count: 0 };
        });
      } catch (err) {
        Log.warn('Holiday fetch threw:', err);
        return Promise.resolve({ status: 'error', count: 0 });
      }
    },

    /**
     * CONNECTION.invoke wraps the upstream body, and how deeply depends on the
     * connection type. Unwrap defensively rather than trusting one shape.
     */
    _extract: function (response) {
      var candidates = [
        response,
        response && response.details,
        response && response.details && response.details.statusMessage,
        response && response.response,
        response && response.data
      ];

      for (var i = 0; i < candidates.length; i++) {
        var node = candidates[i];
        if (!node) { continue; }
        if (Array.isArray(node.holidays)) { return node.holidays; }
        // Some connections hand the body back as an unparsed JSON string.
        if (typeof node === 'string') {
          try {
            var parsed = JSON.parse(node);
            if (parsed && Array.isArray(parsed.holidays)) { return parsed.holidays; }
          } catch (e) { /* not JSON, keep looking */ }
        }
      }
      Log.warn('Holiday response had no "holidays" array.', response);
      return [];
    },

    /**
     * Index by exact ISO date. Matching on the full date (not just the `year`
     * field) is what keeps the 2027 rows in the feed from ever colouring a
     * 2026 day; the year check below is a second guard against bad data.
     */
    _index: function (list) {
      var map = {};
      (list || []).forEach(function (row) {
        if (!row || typeof row.date !== 'string') { return; }
        var iso = row.date.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) { return; }
        if (row.year && String(row.year) !== iso.slice(0, 4)) { return; }
        map[iso] = { date: iso, name: String(row.name || 'Business holiday') };
      });
      this._byDate = map;
    }
  };

  /* ======================================================================
     PLANNER LOCK - detect a Weekly_Planner this user already created

     On open, one search per visible week checks Weekly_Planner for a record
     whose Name is that week's range label ("10 Aug 2026 – 15 Aug 2026") AND
     whose Owner is the signed-in user. A hit means this user already planned
     that week, so it is disabled in the dropdown instead of re-created.

     The Owner filter is the standard lookup every module already carries —
     no custom field needed — which is what keeps the match scoped to the
     current user even though multiple people create Weekly_Planner records
     with names that otherwise collide (everyone's week starts the same
     Monday).  A failure here is never fatal: the week just stays selectable.

     A matching record only blocks re-creation while its Status is something
     other than "Rejected". A rejected plan is not "already planned" in any
     meaningful sense, so if every match for a week is Rejected the week stays
     open; a single non-Rejected match (Draft, Pending, Approved, ...) is
     enough to lock it.
     ====================================================================== */

  var PlannerLock = {
    _byWeek: {},           // weekId -> Weekly_Planner id this user already created
    _createdThisSession: {}, // weekId -> true; a fresh search must never override these
    _loaded: false,

    isLoaded: function () { return this._loaded; },
    isLocked: function (weekId) { return this._byWeek.hasOwnProperty(weekId); },
    plannerIdFor: function (weekId) { return this._byWeek[weekId] || ''; },
    isCreatedThisSession: function (weekId) { return !!this._createdThisSession[weekId]; },

    /** Lock a week immediately after this session creates its planner, so the
     *  dropdown reflects it without waiting on a fresh CRM search. This lock
     *  is authoritative: search results (which can lag right after an
     *  insert) are never allowed to clear it — see _searchWeek. */
    markCreated: function (weekId, plannerId) {
      this._byWeek[weekId] = String(plannerId || '');
      this._createdThisSession[weekId] = true;
      this._loaded = true;
    },

    _canSearch: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM &&
                window.ZOHO.CRM.API && typeof window.ZOHO.CRM.API.searchRecord === 'function');
    },

    /** Current user's CRM record id, or '' when the SDK cannot provide one. */
    currentUserId: function () {
      if (!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONFIG &&
            typeof window.ZOHO.CRM.CONFIG.getCurrentUser === 'function')) {
        return Promise.resolve('');
      }
      try {
        return window.ZOHO.CRM.CONFIG.getCurrentUser().then(function (response) {
          var user = response && response.users && response.users[0];
          return (user && user.id) ? String(user.id) : '';
        }).catch(function (err) {
          Log.warn('getCurrentUser failed:', err);
          return '';
        });
      } catch (err) {
        Log.warn('getCurrentUser threw:', err);
        return Promise.resolve('');
      }
    },

    /**
     * One Name+Owner search per week. Always resolves.
     * @returns {Promise<{status:string}>}
     */
    loadForWeeks: function (weeks) {
      var self = this;
      if (!this._canSearch() || !weeks || !weeks.length) {
        return Promise.resolve({ status: 'skipped' });
      }
      return this.currentUserId().then(function (ownerId) {
        if (!ownerId) { return { status: 'skipped' }; }
        return Promise.all(weeks.map(function (week) {
          return self._searchWeek(week, ownerId);
        })).then(function () {
          self._loaded = true;
          return { status: 'ok' };
        });
      });
    },

    _searchWeek: function (week, ownerId) {
      var self = this;

      // This session's own create is authoritative — a re-search right after
      // an insert can lag CRM's search index and come back empty, which must
      // never be read as "actually not locked".
      if (this._createdThisSession[week.id]) { return Promise.resolve(); }

      var name = App.rangeNameForWeek(week);
      var criteria = '((Name:equals:' + name + ')and(Owner:equals:' + ownerId + '))';

      try {
        return window.ZOHO.CRM.API.searchRecord({
          Entity: CONFIG.PLANNER_MODULE,
          Type: 'criteria',
          Query: criteria,
          // Status must be requested explicitly — searchRecord's default field
          // set is not guaranteed to include every picklist on the layout, and
          // the Reject check below is worthless against an undefined Status.
          Fields: ['Status'],
          delay: false
        }).then(function (response) {
          var rows = (response && Array.isArray(response.data)) ? response.data : [];
          // Every matching record for this Name+Owner must be inspected, not
          // just the first one: several Reject records plus a single
          // Pending/Approved/Draft one still lock the week. Re-evaluated fresh
          // on every call, so a week that was locked before now correctly
          // reopens once every match is Reject (or the record was deleted).
          var lockedId = '';
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].id && rows[i].Status !== PLANNER_STATUS_REJECTED) {
              lockedId = String(rows[i].id);
              break;
            }
          }
          if (lockedId) {
            self._byWeek[week.id] = lockedId;
          } else {
            delete self._byWeek[week.id];
          }
        }).catch(function (err) {
          // Zoho resolves "no match" without a data array; this net only
          // catches genuine transport failures, which must not block the UI.
          Log.warn('Planner lookup failed for ' + week.id + ':', err);
        });
      } catch (err) {
        Log.warn('Planner lookup threw for ' + week.id + ':', err);
        return Promise.resolve();
      }
    }
  };

  /* ======================================================================
     VALIDATOR
     Rules: no duplicate School / Dealer within the SAME day.
            Comparison trims whitespace and ignores case.
     ====================================================================== */

  var Validator = {
    normalize: function (value) {
      return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
    },

    /**
     * Validate one day+type list.
     *
     * Linked rows are deduplicated by CRM record id, so the same Account added
     * twice is caught even if its name was edited. Unlinked rows fall back to
     * the normalised name.
     *
     * @param {Object} options
     *   requireName - blank names become errors (save time only)
     *   requireLink - a typed name with no CRM record behind it is an error
     * @returns {Object} map of entryId -> { kind, message } (empty when clean)
     */
    checkList: function (day, type, options) {
      var opts = options || {};
      var errors = {};
      var seen = {};
      var meta = ENTRY_META[type];
      var list = Store.listOf(day, type);

      list.forEach(function (entry) {
        var raw = String(entry.name || '').trim();
        var linked = !!entry.recordId;
        var key = linked ? 'id:' + entry.recordId : 'name:' + Validator.normalize(raw);

        if (!raw) {
          // Blank rows only complain at save time, never while typing.
          if (opts.requireName) {
            errors[entry.id] = { kind: 'blank', message: meta.label + ' is required.' };
          }
          return;
        }

        if (seen[key]) {
          errors[entry.id] = {
            kind: 'duplicate',
            message: 'This ' + meta.label.toLowerCase() + ' is already added for ' + day.dayName + '.'
          };
          return;
        }
        seen[key] = entry.id;

        // A lookup must point at a real record — but only demand that when the
        // CRM search is actually reachable, or standalone mode becomes unusable.
        if (opts.requireLink && !linked && Lookup.isEnabled()) {
          errors[entry.id] = {
            kind: 'unlinked',
            message: 'Pick a ' + meta.label.toLowerCase() + ' from the suggestions.'
          };
        }
      });

      return errors;
    },

    /** Validate every day of the active week. */
    checkWeek: function (options) {
      var report = { valid: true, duplicates: 0, blanks: 0, unlinked: 0, byDay: {} };
      var tally = { duplicate: 'duplicates', blank: 'blanks', unlinked: 'unlinked' };

      state.days.forEach(function (day) {
        report.byDay[day.id] = {};

        // Holiday / Leave days carry no visits, so nothing to validate.
        if (day.status !== STATUS_ACTIVE) {
          report.byDay[day.id] = { school: {}, dealer: {} };
          return;
        }

        ['school', 'dealer'].forEach(function (type) {
          var errors = Validator.checkList(day, type, options);
          report.byDay[day.id][type] = errors;
          Object.keys(errors).forEach(function (id) {
            report.valid = false;
            report[tally[errors[id].kind]]++;
          });
        });
      });

      return report;
    }
  };

  /* ======================================================================
     LOOKUP - CRM record search over Accounts / Vendors
     Never rejects: every failure path resolves to a status the popover can
     render, so a blocked or slow CRM never produces an unhandled rejection.
     ====================================================================== */

  var Lookup = {
    _cache: {},
    _order: [],

    /** True only when the SDK handshake finished and searchRecord exists. */
    isEnabled: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM &&
                window.ZOHO.CRM.API && typeof window.ZOHO.CRM.API.searchRecord === 'function');
    },

    _key: function (module, term) { return module + '::' + term.toLowerCase(); },

    _remember: function (key, rows) {
      if (!this._cache.hasOwnProperty(key)) { this._order.push(key); }
      this._cache[key] = rows;
      while (this._order.length > CONFIG.SEARCH_CACHE_MAX) {
        delete this._cache[this._order.shift()];
      }
    },

    /**
     * @returns {Promise<{status:string, rows:Array<{recordId,name}>}>}
     *   status: 'ok' | 'short' | 'unavailable' | 'error'
     */
    search: function (type, term) {
      var meta = ENTRY_META[type];
      var text = String(term || '').trim();
      var self = this;

      if (!meta || text.length < CONFIG.SEARCH_MIN_CHARS) {
        return Promise.resolve({ status: 'short', rows: [] });
      }
      if (!this.isEnabled()) {
        return Promise.resolve({ status: 'unavailable', rows: [] });
      }

      var key = this._key(meta.module, text);
      if (this._cache.hasOwnProperty(key)) {
        return Promise.resolve({ status: 'ok', rows: this._cache[key] });
      }

      try {
        return window.ZOHO.CRM.API.searchRecord({
          Entity: meta.module,
          Type: 'word',
          Query: text,
          delay: false
        }).then(function (response) {
          var rows = self._normalise(response, meta);
          self._remember(key, rows);
          return { status: 'ok', rows: rows };
        }).catch(function (err) {
          Log.warn('searchRecord failed for ' + meta.module + ':', err);
          return { status: 'error', rows: [] };
        });
      } catch (err) {
        Log.warn('searchRecord threw for ' + meta.module + ':', err);
        return Promise.resolve({ status: 'error', rows: [] });
      }
    },

    /**
     * searchRecord resolves to { data: [...] } on hits, but to { status: 'nodata' }
     * (or nothing at all) when the module has no match — normalise all of it.
     */
    _normalise: function (response, meta) {
      var raw = (response && Array.isArray(response.data)) ? response.data : [];
      var rows = [];
      for (var i = 0; i < raw.length && rows.length < CONFIG.SEARCH_MAX_RESULTS; i++) {
        var rec = raw[i];
        if (!rec || !rec.id) { continue; }
        var name = rec[meta.nameField] || rec.Name || '';
        if (!name) { continue; }
        rows.push({ recordId: String(rec.id), name: String(name) });
      }
      return rows;
    }
  };

  /* ======================================================================
     TOAST
     ====================================================================== */

  var Toast = {
    _stack: null,

    init: function () { this._stack = document.getElementById('toastStack'); },

    show: function (type, title, text) {
      try {
        if (!this._stack) { Log.info(title, text || ''); return; }

        var el = document.createElement('div');
        el.className = 'toast toast--' + (type || 'info');

        var icon = document.createElement('span');
        icon.className = 'toast__icon';
        icon.innerHTML = ICONS[type] || ICONS.info;   // trusted, local constants only

        var body = document.createElement('div');
        body.className = 'toast__body';

        var titleEl = document.createElement('p');
        titleEl.className = 'toast__title';
        titleEl.textContent = title || '';
        body.appendChild(titleEl);

        if (text) {
          var textEl = document.createElement('p');
          textEl.className = 'toast__text';
          textEl.textContent = text;
          body.appendChild(textEl);
        }

        el.appendChild(icon);
        el.appendChild(body);
        this._stack.appendChild(el);

        var remove = function () {
          if (!el.parentNode) { return; }
          el.classList.add('is-leaving');
          window.setTimeout(function () {
            if (el.parentNode) { el.parentNode.removeChild(el); }
          }, 180);
        };

        Dom.on(el, 'click', remove);
        window.setTimeout(remove, CONFIG.TOAST_TIMEOUT_MS);
      } catch (err) {
        Log.warn('Toast failed:', err);
      }
    },

    success: function (t, m) { this.show('success', t, m); },
    error: function (t, m) { this.show('error', t, m); },
    warning: function (t, m) { this.show('warning', t, m); },
    info: function (t, m) { this.show('info', t, m); }
  };

  /* ======================================================================
     MODAL - promise-based confirm
     ====================================================================== */

  var Modal = {
    _el: null, _accept: null, _cancel: null, _icon: null, _resolve: null, _lastFocus: null,

    init: function () {
      this._el = document.getElementById('confirmModal');
      this._accept = document.getElementById('confirmAccept');
      this._cancel = document.getElementById('confirmCancel');
      this._icon = this._el ? this._el.querySelector('.modal__icon') : null;
      if (!this._el) { return; }

      Dom.on(this._accept, 'click', this._close.bind(this, true));
      Dom.on(this._cancel, 'click', this._close.bind(this, false));

      var self = this;
      Dom.on(this._el, 'click', function (event) {
        if (event.target && event.target.hasAttribute('data-close-modal')) { self._close(false); }
      });
      Dom.on(document, 'keydown', function (event) {
        if (event.key === 'Escape' && self._el && !self._el.hidden) { self._close(false); }
      });
    },

    /**
     * Returns a Promise<boolean>; falls back to window.confirm if markup is gone.
     * @param {string} [acceptLabel] text for the confirm button ("Yes, reset" default)
     * @param {string} [tone] 'primary' for constructive actions; danger otherwise
     */
    confirm: function (title, text, acceptLabel, tone) {
      var self = this;
      if (!this._el) {
        return Promise.resolve(window.confirm(title + '\n\n' + text));
      }

      // A second confirm while one is open would orphan the first promise.
      if (this._resolve) { this._close(false); }

      Dom.text(document.getElementById('confirmTitle'), title);
      Dom.text(document.getElementById('confirmText'), text);
      Dom.text(this._accept, acceptLabel || 'Yes, reset');

      // Creating records is constructive; destructive red would misread it.
      var primary = tone === 'primary';
      if (this._accept) {
        this._accept.className = 'btn ' + (primary ? 'btn--primary' : 'btn--danger');
      }
      if (this._icon) { this._icon.classList.toggle('modal__icon--primary', primary); }

      this._lastFocus = document.activeElement;
      Dom.show(this._el);
      window.setTimeout(function () { if (self._accept) { self._accept.focus(); } }, 40);

      return new Promise(function (resolve) { self._resolve = resolve; });
    },

    _close: function (result) {
      Dom.hide(this._el);
      if (this._lastFocus && this._lastFocus.focus) {
        try { this._lastFocus.focus(); } catch (e) { /* ignore */ }
      }
      var resolve = this._resolve;
      this._resolve = null;
      if (resolve) { resolve(!!result); }
    }
  };

  /* ======================================================================
     CRM - record creation (Weekly_Planner + Meeting_Planned)
     ====================================================================== */

  var Crm = {
    isReady: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.API &&
                typeof window.ZOHO.CRM.API.insertRecord === 'function');
    },

    /**
     * insertRecord replies with one row per submitted record, each carrying its
     * own status — a 200 does NOT mean every row was written.
     * @returns {{ids: string[], errors: string[]}}
     */
    _summarise: function (response) {
      var rows = (response && Array.isArray(response.data)) ? response.data : [];
      var out = { ids: [], errors: [] };

      if (!rows.length) {
        out.errors.push('CRM returned no result for the insert.');
        return out;
      }

      rows.forEach(function (row) {
        var ok = row && (row.code === 'SUCCESS' || row.status === 'success');
        if (ok && row.details && row.details.id) {
          out.ids.push(String(row.details.id));
          return;
        }
        var reason = (row && (row.message || row.code)) || 'Unknown error';
        // Field-level failures name the offending API field here.
        if (row && row.details && row.details.api_name) {
          reason += ' (' + row.details.api_name + ')';
        }
        out.errors.push(String(reason));
      });

      return out;
    },

    /** Insert one record. Rejects with a readable Error on any failure. */
    insertOne: function (module, data) {
      var self = this;
      return window.ZOHO.CRM.API.insertRecord({ Entity: module, APIData: data })
        .then(function (response) {
          var result = self._summarise(response);
          if (!result.ids.length) {
            throw new Error(module + ': ' + (result.errors[0] || 'insert failed'));
          }
          return result.ids[0];
        });
    },

    /**
     * Insert many records, chunked to the API's per-call ceiling and run in
     * series so a mid-way failure does not leave later batches racing.
     * @returns {Promise<{ids: string[], errors: string[]}>} never rejects
     */
    insertMany: function (module, list) {
      var self = this;
      var batches = [];
      for (var i = 0; i < list.length; i += CONFIG.INSERT_BATCH_MAX) {
        batches.push(list.slice(i, i + CONFIG.INSERT_BATCH_MAX));
      }

      var totals = { ids: [], errors: [] };

      return batches.reduce(function (chain, batch) {
        return chain.then(function () {
          return window.ZOHO.CRM.API.insertRecord({ Entity: module, APIData: batch })
            .then(function (response) {
              var result = self._summarise(response);
              totals.ids = totals.ids.concat(result.ids);
              totals.errors = totals.errors.concat(result.errors);
            })
            .catch(function (err) {
              totals.errors.push(Boundary.describe(err));
            });
        });
      }, Promise.resolve()).then(function () { return totals; });
    }
  };

  /* ======================================================================
     SUGGEST - autocomplete popover for the lookup inputs

     One shared panel lives on <body> and is positioned with `fixed` against
     the active input. It cannot live inside a day card: .day-card sets
     `overflow: hidden` for its rounded header/footer, which would clip the
     dropdown to the card. Only one row can be open at a time by design.
     ====================================================================== */

  var Suggest = {
    _panel: null,
    _list: null,
    _note: null,
    _input: null,      // the input currently being completed
    _ctx: null,        // { dayId, type, entryId }
    _rows: [],
    _active: -1,
    _seq: 0,           // discards responses that arrive out of order
    _timer: null,
    _open: false,

    init: function () {
      var panel = document.createElement('div');
      panel.className = 'suggest';
      panel.id = 'suggestPanel';
      panel.hidden = true;

      var list = document.createElement('ul');
      list.className = 'suggest__list';
      list.id = 'suggestList';
      list.setAttribute('role', 'listbox');

      var note = document.createElement('p');
      note.className = 'suggest__note';
      note.hidden = true;

      panel.appendChild(list);
      panel.appendChild(note);
      document.body.appendChild(panel);

      this._panel = panel;
      this._list = list;
      this._note = note;

      // mousedown, not click: the input's blur would tear the panel down first.
      Dom.on(list, 'mousedown', Boundary.guard(function (event) {
        var item = event.target && event.target.closest ? event.target.closest('[data-suggest-index]') : null;
        if (!item || item.getAttribute('aria-disabled') === 'true') {
          event.preventDefault();   // keep focus in the input either way
          return;
        }
        event.preventDefault();
        Suggest.choose(parseInt(item.getAttribute('data-suggest-index'), 10));
      }, 'suggest-pick'));

      Dom.on(document, 'mousedown', function (event) {
        if (!Suggest._open) { return; }
        if (panel.contains(event.target) || event.target === Suggest._input) { return; }
        Suggest.close();
      });

      Dom.on(window, 'resize', function () { Suggest.reposition(); });
      // Capture phase: the day grid or page can scroll, not just the window.
      window.addEventListener('scroll', function () { Suggest.reposition(); }, true);
    },

    isOpen: function () { return this._open; },

    /** Debounced search for the row that owns `input`. */
    request: function (input, ctx, term) {
      var self = this;
      this._input = input;
      this._ctx = ctx;

      if (this._timer) { window.clearTimeout(this._timer); }

      var text = String(term || '').trim();
      if (text.length < CONFIG.SEARCH_MIN_CHARS) { this.close(); return; }

      var token = ++this._seq;
      this._timer = window.setTimeout(function () {
        self._timer = null;
        Lookup.search(ctx.type, text).then(Boundary.guard(function (result) {
          // A newer keystroke already fired, or focus moved on.
          if (token !== self._seq || self._input !== input) { return; }
          self.render(result, text);
        }, 'suggest-render'));
      }, CONFIG.SEARCH_DEBOUNCE_MS);
    },

    render: function (result, term) {
      var meta = ENTRY_META[this._ctx.type];
      var used = Store.usedRecordIds(this._ctx.dayId, this._ctx.type, this._ctx.entryId);

      this._rows = result.rows || [];
      this._active = -1;
      Dom.clear(this._list);

      var self = this;
      var firstSelectable = -1;

      this._rows.forEach(function (row, index) {
        var item = document.createElement('li');
        item.className = 'suggest__item';
        item.setAttribute('role', 'option');
        item.setAttribute('data-suggest-index', index);
        item.id = 'suggestOption' + index;

        var name = document.createElement('span');
        name.className = 'suggest__name';
        name.textContent = row.name;          // textContent: CRM data is untrusted
        item.appendChild(name);

        if (used[row.recordId]) {
          item.classList.add('is-disabled');
          item.setAttribute('aria-disabled', 'true');
          var tag = document.createElement('span');
          tag.className = 'suggest__tag';
          tag.textContent = 'Already added';
          item.appendChild(tag);
        } else if (firstSelectable < 0) {
          firstSelectable = index;
        }

        self._list.appendChild(item);
      });

      var message = '';
      if (result.status === 'unavailable') {
        message = 'CRM lookup is unavailable here — type the name manually.';
      } else if (result.status === 'error') {
        message = 'Could not reach ' + meta.module + '. Try again in a moment.';
      } else if (!this._rows.length) {
        message = 'No ' + meta.labelPlural.toLowerCase() + ' match “' + term + '”.';
      }

      Dom.text(this._note, message);
      this._note.hidden = !message;

      if (!this._rows.length && !message) { this.close(); return; }

      this.open();
      if (firstSelectable > -1) { this.highlight(firstSelectable); }
    },

    open: function () {
      this._panel.hidden = false;
      this._open = true;
      if (this._input) {
        this._input.setAttribute('aria-expanded', 'true');
      }
      this.reposition();
    },

    close: function () {
      if (this._timer) { window.clearTimeout(this._timer); this._timer = null; }
      this._seq++;                       // invalidate any in-flight response
      this._panel.hidden = true;
      this._open = false;
      this._active = -1;
      this._rows = [];
      if (this._input) {
        this._input.setAttribute('aria-expanded', 'false');
        this._input.removeAttribute('aria-activedescendant');
      }
      this._input = null;
      this._ctx = null;
    },

    /** Anchor the panel to the input, flipping above it when space is tight. */
    reposition: function () {
      if (!this._open || !this._input) { return; }

      var rect = this._input.getBoundingClientRect();
      // Input scrolled out of the viewport: nothing sensible to anchor to.
      if (rect.bottom < 0 || rect.top > window.innerHeight) { this.close(); return; }

      var width = Math.max(rect.width, 220);
      var panel = this._panel;
      panel.style.width = width + 'px';
      panel.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))) + 'px';

      var height = panel.offsetHeight;
      var spaceBelow = window.innerHeight - rect.bottom;
      panel.style.top = (spaceBelow < height + 12 && rect.top > height + 12)
        ? Math.round(rect.top - height - 6) + 'px'
        : Math.round(rect.bottom + 6) + 'px';
    },

    highlight: function (index) {
      var items = this._list.children;
      if (!items.length) { return; }

      for (var i = 0; i < items.length; i++) { items[i].classList.remove('is-active'); }

      this._active = index;
      var item = items[index];
      if (!item) { return; }

      item.classList.add('is-active');
      if (item.scrollIntoView) { item.scrollIntoView({ block: 'nearest' }); }
      if (this._input) { this._input.setAttribute('aria-activedescendant', item.id); }
    },

    /** Arrow-key navigation that steps over "already added" rows. */
    move: function (delta) {
      if (!this._open || !this._rows.length) { return; }
      var items = this._list.children;
      var index = this._active;

      for (var step = 0; step < items.length; step++) {
        index = (index + delta + items.length) % items.length;
        if (items[index].getAttribute('aria-disabled') !== 'true') {
          this.highlight(index);
          return;
        }
      }
    },

    /** Commit the highlighted row (or `index`) into the store and the input. */
    choose: function (index) {
      var pick = this._rows[typeof index === 'number' ? index : this._active];
      var ctx = this._ctx;
      var input = this._input;
      if (!pick || !ctx || !input) { return false; }

      Store.updateEntry(ctx.dayId, ctx.type, ctx.entryId, 'recordId', pick.recordId);
      Store.updateEntry(ctx.dayId, ctx.type, ctx.entryId, 'name', pick.name);

      // Assigning .value does not fire `input`, so onFieldChange will not race
      // us and blank out the recordId we just stored.
      input.value = pick.name;

      this.close();

      var day = Store.getDay(ctx.dayId);
      if (day) {
        View.markLinked(ctx.dayId, ctx.type, ctx.entryId, true);
        App.revalidateDay(day, ctx.type, { requireName: false });
        App.clearWarningWhenClean();
      }
      Store.persist();
      return true;
    },

    /** Drop the panel if it belongs to a row that is going away. */
    closeFor: function (entryId) {
      if (this._open && this._ctx && this._ctx.entryId === entryId) { this.close(); }
    }
  };

  /* ======================================================================
     VIEW - rendering layer
     Day cards are built once per week; row add/remove touches only the
     affected node so typing focus is never lost.
     ====================================================================== */

  var View = {
    els: {},
    /** dayId -> { card, rowsByType, badge, empty, groups, counts, clearBtn } */
    cards: {},

    init: function () {
      this.els = {
        weekSelect: Dom.byId('weekSelect'),
        dayGrid: Dom.byId('dayGrid'),
        fallback: Dom.byId('fallbackPanel'),
        fallbackTitle: Dom.byId('fallbackTitle'),
        fallbackText: Dom.byId('fallbackText'),
        fallbackRetry: Dom.byId('fallbackRetry'),
        summaryRange: Dom.byId('summaryRange'),
        statSchools: Dom.byId('statSchools'),
        statDealers: Dom.byId('statDealers'),
        statDays: Dom.byId('statDays'),
        footerHint: Dom.byId('footerHint'),
        resetBtn: Dom.byId('resetBtn'),
        saveBtn: Dom.byId('saveBtn')
      };
    },

    /* --------------------------- week dropdown --------------------------- */

    /** @param {?Object} lock PlannerLock (or omitted before that check has run) */
    renderWeekOptions: function (weeks, selectedId, lock) {
      var select = this.els.weekSelect;
      if (!select) { return; }
      Dom.clear(select);

      if (!weeks || !weeks.length) {
        var none = document.createElement('option');
        none.textContent = 'No weeks available';
        none.value = '';
        select.appendChild(none);
        select.disabled = true;
        return;
      }

      select.disabled = false;
      weeks.forEach(function (week) {
        var option = document.createElement('option');
        option.value = week.id;
        var locked = !!(lock && lock.isLocked(week.id));
        option.textContent = week.label + (locked ? ' — already planned' : ''); // "04 Aug" or "04 Aug — already planned"
        option.disabled = locked;
        select.appendChild(option);
      });
      select.value = selectedId || weeks[0].id;
    },

    /* ----------------------------- day grid ------------------------------ */

    renderWeek: function (days) {
      var grid = this.els.dayGrid;
      if (!grid) { return; }

      // The popover is anchored to an input that is about to be destroyed.
      Suggest.close();

      this.cards = {};
      Dom.clear(grid);

      if (!days || !days.length) {
        this.showFallback('Week could not be generated',
          'We could not build the days for this week. Pick another week or reload the widget.');
        return;
      }

      this.hideFallback();

      var frag = document.createDocumentFragment();
      var built = 0;

      days.forEach(function (day, index) {
        var card = View.buildDayCard(day, index);
        if (card) { frag.appendChild(card); built++; }
      });

      if (!built) {
        this.showFallback('Nothing to display',
          'The day cards could not be rendered. Please reload the widget.');
        return;
      }

      grid.appendChild(frag);
      Dom.show(grid);
      this.refreshSummary();
    },

    buildDayCard: function (day, index) {
      var card = Dom.fromTemplate('tplDayCard');
      if (!card) { return null; }

      card.setAttribute('data-day-id', day.id);
      card.style.animationDelay = Math.min(index * 45, 250) + 'ms';

      Dom.text(card.querySelector('[data-day-initial]'), day.dayShort.toUpperCase());
      Dom.text(card.querySelector('[data-day-name]'), day.dayName);
      Dom.text(card.querySelector('[data-day-date]'), day.dateLabel);

      var refs = {
        card: card,
        badge: card.querySelector('[data-day-badge]'),
        empty: card.querySelector('[data-empty-day]'),
        clearBtn: card.querySelector('[data-action="clear-day"]'),
        status: card.querySelector('[data-day-status]'),
        statusNote: card.querySelector('[data-status-note]'),
        addBtns: card.querySelectorAll('[data-action="add-entry"]'),
        groups: {},
        rows: {},
        counts: {}
      };

      if (refs.status) {
        SCHEDULE_STATUSES.forEach(function (value) {
          var option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          refs.status.appendChild(option);
        });
        refs.status.value = day.status;
        refs.status.setAttribute('aria-label', 'Schedule status for ' + day.dayName);
      }

      ['school', 'dealer'].forEach(function (type) {
        var group = card.querySelector('[data-group="' + type + '"]');
        refs.groups[type] = group;
        refs.rows[type] = group ? group.querySelector('[data-rows]') : null;
        refs.counts[type] = group ? group.querySelector('[data-group-count]') : null;
      });

      this.cards[day.id] = refs;

      // Restored draft rows
      ['school', 'dealer'].forEach(function (type) {
        Store.listOf(day, type).forEach(function (entry) {
          View.appendRow(day, type, entry, { silent: true });
        });
      });

      this.refreshDay(day);
      return card;
    },

    /* ---------------------------- entry rows ----------------------------- */

    appendRow: function (day, type, entry, options) {
      var refs = this.cards[day.id];
      var meta = ENTRY_META[type];
      if (!refs || !refs.rows[type] || !meta) { return null; }

      var row = Dom.fromTemplate('tplEntryRow');
      if (!row) { return null; }

      row.setAttribute('data-entry-id', entry.id);
      row.setAttribute('data-entry-type', type);

      var icon = row.querySelector('[data-entry-icon]');
      if (icon) { icon.innerHTML = ICONS[type] || ''; }  // trusted local constant

      row.classList.toggle('is-linked', !!entry.recordId);

      var input = row.querySelector('[data-entry-input="name"]');
      if (input) {
        input.placeholder = meta.placeholder;
        input.value = entry.name || '';
        input.setAttribute('aria-label', meta.label + ' for ' + day.dayName +
          ' (search ' + meta.module + ')');
        // Combobox wiring for the shared Suggest popover.
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', 'suggestList');
        input.setAttribute('aria-expanded', 'false');
      }

      // Purpose and Transport_Medium are filled the same way: options from the
      // constant list, current value clamped to something that list contains.
      [
        { field: 'reason', options: REASONS, value: entry.reason },
        { field: 'transport', options: TRANSPORTS, value: entry.transport }
      ].forEach(function (spec) {
        var select = row.querySelector('[data-entry-input="' + spec.field + '"]');
        if (!select) { return; }
        spec.options.forEach(function (name) {
          var option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        });
        select.value = spec.options.indexOf(spec.value) > -1 ? spec.value : spec.options[0];
      });

      refs.rows[type].appendChild(row);

      if (!options || !options.silent) {
        if (input) {
          try { input.focus(); } catch (e) { /* focus is best effort */ }
        }
      }
      return row;
    },

    /** Green tick + tinted icon once the row points at a real CRM record. */
    markLinked: function (dayId, type, entryId, linked) {
      var refs = this.cards[dayId];
      if (!refs || !refs.rows[type]) { return; }
      var row = refs.rows[type].querySelector('[data-entry-id="' + entryId + '"]');
      if (row) { row.classList.toggle('is-linked', !!linked); }
    },

    removeRow: function (dayId, type, entryId) {
      var refs = this.cards[dayId];
      if (!refs || !refs.rows[type]) { return; }
      var row = refs.rows[type].querySelector('[data-entry-id="' + entryId + '"]');
      if (!row) { return; }
      row.classList.add('is-removing');
      window.setTimeout(function () {
        if (row.parentNode) { row.parentNode.removeChild(row); }
      }, 140);
    },

    /* ------------------------- targeted refreshes ------------------------ */

    /** Badge, counters, empty state and group visibility for one day. */
    refreshDay: function (day) {
      var refs = this.cards[day.id];
      if (!refs) { return; }

      var counts = { school: day.schools.length, dealer: day.dealers.length };
      var total = counts.school + counts.dealer;
      var active = Store.isActive(day);

      ['school', 'dealer'].forEach(function (type) {
        if (refs.groups[type]) { refs.groups[type].hidden = counts[type] === 0; }
        Dom.text(refs.counts[type], counts[type]);
      });

      if (refs.empty) { refs.empty.hidden = total > 0 || !active; }
      if (refs.clearBtn) { refs.clearBtn.hidden = total === 0 || !active; }
      refs.card.classList.toggle('is-planned', active && total > 0);

      this.applyStatus(day, refs);

      if (refs.badge) {
        Dom.text(refs.badge, this.badgeText(day, counts.school, counts.dealer));
        refs.badge.className = 'badge ' + (!active
          ? 'badge--off'
          : (total > 0 ? 'badge--active' : 'badge--muted'));
      }

      this.refreshSummary();
    },

    /**
     * Reflect Schedule_Status on the card. The greyed-out look comes from CSS,
     * but the controls are also really disabled — `pointer-events: none` alone
     * still leaves them reachable by keyboard.
     */
    applyStatus: function (day, refs) {
      refs = refs || this.cards[day.id];
      if (!refs) { return; }

      var active = Store.isActive(day);

      refs.card.classList.toggle('is-off', !active);
      refs.card.classList.toggle('is-locked', !!day.locked);

      if (refs.status) {
        refs.status.value = day.status;
        refs.status.disabled = !!day.locked;
      }

      if (refs.addBtns) {
        Array.prototype.forEach.call(refs.addBtns, function (btn) { btn.disabled = !active; });
      }
      if (refs.clearBtn) { refs.clearBtn.disabled = !active; }

      Array.prototype.forEach.call(
        refs.card.querySelectorAll('[data-entry-input], [data-action="delete-entry"]'),
        function (el) { el.disabled = !active; }
      );

      if (refs.statusNote) {
        var note = '';
        if (day.locked) {
          note = day.holidayName + ' — business holiday in CRM, this day is locked.';
        } else if (day.status === STATUS_LEAVE) {
          note = 'Marked as leave. No visits will be planned for this day.';
        } else if (day.status === STATUS_HOLIDAY) {
          note = 'Marked as holiday. No visits will be planned for this day.';
        }
        Dom.text(refs.statusNote, note);
        refs.statusNote.hidden = !note;
      }
    },

    /** "No Plans" | "Holiday" | "2 Schools | 1 Dealer" */
    badgeText: function (day, schools, dealers) {
      if (day && day.status !== STATUS_ACTIVE) { return day.status; }
      var parts = [];
      if (schools > 0) { parts.push(schools + ' ' + (schools === 1 ? 'School' : 'Schools')); }
      if (dealers > 0) { parts.push(dealers + ' ' + (dealers === 1 ? 'Dealer' : 'Dealers')); }
      return parts.length ? parts.join(' | ') : 'No Plans';
    },

    refreshSummary: function () {
      var totals = Store.totals();
      Dom.text(this.els.statSchools, totals.schools);
      Dom.text(this.els.statDealers, totals.dealers);
      Dom.text(this.els.statDays, totals.days);

      var week = Store.getWeek(state.selectedWeekId);
      Dom.text(this.els.summaryRange, week ? week.rangeLabel : '—');

      this.refreshSaveEnabled();

      if (this.els.footerHint && !this.els.footerHint.classList.contains('is-warning')) {
        var hint;
        if (totals.entries === 0 && totals.offDays === 0) {
          hint = 'Add schools and dealers to each day, then save your plan.';
        } else {
          var parts = [];
          if (totals.entries) {
            parts.push(totals.entries + ' visit' + (totals.entries === 1 ? '' : 's') +
              ' planned across ' + totals.days + ' day' + (totals.days === 1 ? '' : 's'));
          }
          if (totals.offDays) {
            parts.push(totals.offDays + ' day' + (totals.offDays === 1 ? '' : 's') + ' off');
          }
          if (totals.incompleteDays) {
            parts.push(totals.incompleteDays + ' Active day' + (totals.incompleteDays === 1 ? '' : 's') +
              ' still need' + (totals.incompleteDays === 1 ? 's' : '') + ' a school or dealer');
          }
          hint = parts.join(' · ') + '.';
        }
        Dom.text(this.els.footerHint, hint);
      }
    },

    /**
     * A week that is all holiday / leave is still worth recording. Every
     * Active day, though, needs at least one visit. A week whose planner was
     * already created this session stays disabled even if the user starts
     * typing into the (now empty) form again — otherwise Save would create a
     * second Weekly_Planner for the same week.
     */
    refreshSaveEnabled: function () {
      if (!this.els.saveBtn) { return; }
      var totals = Store.totals();
      var alreadyCreated = !!state.createdPlanners[state.selectedWeekId];
      var saveable = !alreadyCreated && (totals.entries > 0 || totals.offDays > 0) && totals.incompleteDays === 0;
      this.els.saveBtn.disabled = !saveable || state.submitting;
    },

    /**
     * Lock the footer while records are being written to CRM.
     * Deliberately does NOT call refreshSummary(): unbusying happens after the
     * result hint is written, and refreshSummary would overwrite it.
     */
    setBusy: function (busy) {
      if (this.els.saveBtn) {
        this.els.saveBtn.disabled = !!busy;
        this.els.saveBtn.classList.toggle('is-busy', !!busy);
      }
      if (this.els.resetBtn) { this.els.resetBtn.disabled = !!busy; }
      if (this.els.weekSelect) { this.els.weekSelect.disabled = !!busy; }
      if (!busy) { this.refreshSaveEnabled(); }
    },

    /**
     * Writes the footer hint. A warning hint is "sticky": refreshSummary()
     * leaves it alone until the app explicitly clears it.
     */
    setHint: function (message, isWarning) {
      if (!this.els.footerHint) { return; }
      this.els.footerHint.classList.toggle('is-warning', !!isWarning);
      Dom.text(this.els.footerHint, message);
    },

    isHintWarning: function () {
      return !!(this.els.footerHint && this.els.footerHint.classList.contains('is-warning'));
    },

    /* ----------------------------- validation ---------------------------- */

    /** Paint / clear error messages for one day+type. */
    paintErrors: function (day, type, errors) {
      var refs = this.cards[day.id];
      if (!refs || !refs.rows[type]) { return; }

      var rows = refs.rows[type].querySelectorAll('[data-entry-row]');
      Array.prototype.forEach.call(rows, function (row) {
        var id = row.getAttribute('data-entry-id');
        var input = row.querySelector('[data-entry-input="name"]');
        var errorEl = row.querySelector('[data-entry-error]');
        var message = errors[id] ? errors[id].message : '';

        if (input) { input.classList.toggle('is-invalid', !!message); }
        if (errorEl) {
          Dom.text(errorEl, message || '');
          errorEl.hidden = !message;
        }
      });
    },

    /** Focus the first invalid input across the week. */
    focusFirstError: function () {
      var invalid = document.querySelector('.input.is-invalid');
      if (!invalid) { return; }
      try {
        if (invalid.scrollIntoView) { invalid.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        invalid.focus({ preventScroll: true });
      } catch (e) {
        try { invalid.focus(); } catch (e2) { /* ignore */ }
      }
    },

    /* ------------------------- fallback surface -------------------------- */

    showFallback: function (title, text) {
      Dom.text(this.els.fallbackTitle, title);
      Dom.text(this.els.fallbackText, text);
      Dom.show(this.els.fallback);
      Dom.hide(this.els.dayGrid);
    },

    hideFallback: function () {
      Dom.hide(this.els.fallback);
      Dom.show(this.els.dayGrid);
    },

    isFallbackVisible: function () {
      return !!(this.els.fallback && !this.els.fallback.hidden);
    }
  };

  /* ======================================================================
     APP - bootstrap + event wiring
     ====================================================================== */

  var App = {
    init: function () {
      Boundary.init();
      Toast.init();
      Modal.init();
      Suggest.init();
      View.init();

      // Render the UI first, then talk to the SDK: a slow or missing SDK must
      // never leave the user staring at skeletons.
      this.bootUI();
      this.bindEvents();
      this.connectSDK();
    },

    /* ----------------------------- UI boot ------------------------------- */

    bootUI: function () {
      try {
        var weeks = Store.buildWeeks();

        if (!weeks.length) {
          View.renderWeekOptions([], '');
          View.showFallback('No upcoming weeks found',
            'We could not calculate the next Mondays. Please reload the widget.');
          return;
        }

        state.drafts = {};

        View.renderWeekOptions(weeks, weeks[0].id, PlannerLock);
        this.loadWeek(weeks[0].id);
        state.ready = true;

        // bootUI also runs from the "Try again" fallback retry (e.g. after
        // every visible week showed as already planned), not just the very
        // first boot. At true startup sdkConnected is still false and this
        // is a no-op, same as the first PageLoad — but on a retry it must
        // re-run the same CRM lock check onPageLoad does, or a week that was
        // never actually re-verified would render as open again.
        if (state.sdkConnected) {
          this.loadHolidays();
          this.loadPlannerLocks();
        }
      } catch (err) {
        Boundary.report(err, 'bootUI');
        View.showFallback('Widget could not start',
          'An error occurred while preparing the weekly plan. Use “Try again” or reload the widget.');
      }
    },

    loadWeek: function (weekId) {
      try {
        var days = Store.selectWeek(weekId);
        View.renderWeek(days);
        this.revalidate({ requireName: false, paintOnly: true });
      } catch (err) {
        Boundary.report(err, 'loadWeek');
        View.showFallback('Week could not be loaded',
          'Something went wrong while building this week. Try selecting another week.');
      }
    },

    /* ---------------------------- SDK handshake -------------------------- */

    /**
     * Initialises the Zoho Embedded App SDK.
     * The UI is already interactive at this point; a failure here only
     * downgrades the widget to standalone mode (with a single info toast).
     */
    connectSDK: function () {
      var self = this;

      if (window.__ZOHO_SDK_FAILED__ || typeof window.ZOHO === 'undefined' ||
          !window.ZOHO.embeddedApp || typeof window.ZOHO.embeddedApp.init !== 'function') {
        Log.warn('Zoho SDK unavailable - running in standalone mode.');
        this.announceStandalone();
        return;
      }

      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) { return; }
        settled = true;
        Log.warn('Zoho SDK init timed out after ' + CONFIG.SDK_TIMEOUT_MS + 'ms.');
        self.announceStandalone();
      }, CONFIG.SDK_TIMEOUT_MS);

      try {
        // PageLoad must be subscribed BEFORE init() or the event is missed.
        // Zoho refires PageLoad on every widget refresh, not just the first
        // load, so this is also the hook that re-runs the planner-lock check
        // — without it, a refresh would let a user re-create a record for a
        // week already planned.
        window.ZOHO.embeddedApp.on('PageLoad', Boundary.guard(function (data) {
          Log.info('PageLoad', data);
          self.onPageLoad();
        }, 'PageLoad'));

        window.ZOHO.embeddedApp.init()
          .then(function () {
            if (settled) { return; }
            settled = true;
            window.clearTimeout(timer);
            state.sdkConnected = true;
            Log.info('Zoho Embedded App SDK ready.');
            self.resizeWidget();
            self.loadHolidays();
            self.loadPlannerLocks();
          })
          .catch(function (err) {
            if (settled) { return; }
            settled = true;
            window.clearTimeout(timer);
            Log.warn('SDK init rejected - standalone mode.', err);
            self.announceStandalone();
          });
      } catch (err) {
        settled = true;
        window.clearTimeout(timer);
        Log.warn('SDK init threw - standalone mode.', err);
        this.announceStandalone();
      }
    },

    /**
     * Without the SDK there is no ZOHO.CRM.API.searchRecord, so the lookup
     * cannot suggest anything. Say so once — silence here reads as a bug.
     */
    announceStandalone: function () {
      if (this._standaloneAnnounced) { return; }
      this._standaloneAnnounced = true;
      Toast.warning('Lookup unavailable',
        'Schools (Accounts) and Dealers (Vendors) cannot be searched outside CRM. ' +
        'You can still type names manually.');
    },

    _standaloneAnnounced: false,

    /**
     * Holidays arrive after the first paint (the UI must not wait on the SDK),
     * so the visible week is re-stamped once they land.
     */
    loadHolidays: function () {
      return Holidays.load().then(Boundary.guard(function (result) {
        if (result.status !== 'ok') { return result; }

        var locked = App.applyHolidaysToWeek();
        if (locked) {
          Toast.info(locked + ' holiday' + (locked === 1 ? '' : 's') + ' in this week',
            'Those days are locked and cannot be planned.');
        }
        return result;
      }, 'load-holidays'));
    },

    /**
     * Stamp CRM holidays onto the active week. A holiday overrides whatever the
     * user or a draft had set, and wipes any visits already on that day.
     * @returns {number} how many days were newly locked
     */
    applyHolidaysToWeek: function () {
      var changed = 0;

      state.days.forEach(function (day) {
        var holiday = Holidays.forDate(day.dateISO);
        if (!holiday) { return; }
        if (day.locked && day.status === STATUS_HOLIDAY && day.holidayName === holiday.name) { return; }

        day.locked = true;
        day.holidayName = holiday.name;
        day.status = STATUS_HOLIDAY;
        day.schools = [];
        day.dealers = [];
        changed++;
      });

      if (changed) {
        View.renderWeek(state.days);
        this.revalidate({ requireName: false });
        Store.persist();
      }
      return changed;
    },

    /**
     * Checks every visible week against Weekly_Planner (Name + Owner) so a
     * week this user already saved cannot be picked and re-created. Runs
     * once after the SDK connects; a failure here just leaves every week
     * selectable, same as before the check existed.
     */
    loadPlannerLocks: function () {
      return PlannerLock.loadForWeeks(state.weeks).then(Boundary.guard(function (result) {
        if (result.status === 'ok') { App.applyPlannerLocks(); }
        return result;
      }, 'load-planner-locks'));
    },

    /**
     * Disable locked weeks in the dropdown and hop off one if it is currently
     * selected. Runs after every fresh search (initial load, Zoho's refresh,
     * and the "Try again" retry alike), so this also has to UNLOCK a week
     * whose only matching record(s) turned out to be Reject — otherwise a
     * week checked once would stay stuck behind a stale lock forever,
     * including the "all weeks already planned" fallback never clearing.
     */
    applyPlannerLocks: function () {
      var lockedCount = 0;
      var reopened = false;

      state.weeks.forEach(function (week) {
        if (PlannerLock.isLocked(week.id)) {
          state.createdPlanners[week.id] = PlannerLock.plannerIdFor(week.id);
          lockedCount++;
        } else if (state.createdPlanners.hasOwnProperty(week.id)) {
          // Was locked, isn't anymore (e.g. every match is now Reject) — the
          // session-created case can't reach here since PlannerLock.isLocked
          // stays true for those (see PlannerLock.markCreated).
          delete state.createdPlanners[week.id];
          reopened = true;
        }
      });

      View.renderWeekOptions(state.weeks, state.selectedWeekId, PlannerLock);
      if (lockedCount) {
        Toast.info(lockedCount + ' week' + (lockedCount === 1 ? '' : 's') + ' already planned',
          'You already created a weekly plan for ' + (lockedCount === 1 ? 'that week' : 'those weeks') + '.');
      }

      if (PlannerLock.isLocked(state.selectedWeekId)) {
        var open = null;
        for (var i = 0; i < state.weeks.length; i++) {
          if (!PlannerLock.isLocked(state.weeks[i].id)) { open = state.weeks[i]; break; }
        }

        if (open) {
          this.loadWeek(open.id);
          if (View.els.weekSelect) { View.els.weekSelect.value = open.id; }
        } else {
          View.showFallback('All upcoming weeks are already planned',
            'You have already created a weekly plan for every week shown here.');
        }
        return;
      }

      // Selected week is open. If it just reopened (or the fallback panel is
      // still showing from before), get its actual form back on screen.
      if (reopened || View.isFallbackVisible()) {
        this.loadWeek(state.selectedWeekId);
      } else {
        View.refreshSaveEnabled();
      }
    },

    /**
     * Fires on every Zoho widget refresh (not just the first load). The initial
     * PageLoad arrives before embeddedApp.init() resolves, so sdkConnected is
     * still false then and this is a no-op — the init().then() flow already
     * runs the first planner-lock check. Once sdkConnected is true, any later
     * PageLoad means the user refreshed, so the same check must run again or
     * a week already planned would silently become creatable.
     */
    onPageLoad: function () {
      if (!state.sdkConnected) { return; }
      Log.info('Widget refreshed - re-validating planner locks.');
      this.loadHolidays();
      this.loadPlannerLocks();
    },

    /** Best-effort widget resize; silently ignored outside CRM. */
    resizeWidget: function () {
      try {
        if (state.sdkConnected && window.ZOHO.CRM && window.ZOHO.CRM.UI && window.ZOHO.CRM.UI.Resize) {
          window.ZOHO.CRM.UI.Resize({ height: '760', width: '100%' });
        }
      } catch (err) {
        Log.warn('Resize unsupported here.', err);
      }
    },

    /**
     * The record is already safely in CRM at this point, so there is nothing
     * left for the widget to do — close it instead of leaving the user to
     * find their own way back. The delay lets the success toast be seen.
     * closeReload (when available) also refreshes the page behind it so any
     * related list picks up the new record; close() is the fallback.
     */
    closeWidget: function () {
      window.setTimeout(function () {
        try {
          var popup = window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.UI && window.ZOHO.CRM.UI.Popup;
          if (popup && typeof popup.closeReload === 'function') {
            popup.closeReload();
          } else if (popup && typeof popup.close === 'function') {
            popup.close();
          } else {
            Log.warn('No widget close API available in this context.');
          }
        } catch (err) {
          Log.warn('Widget close failed:', err);
        }
      }, CONFIG.WIDGET_CLOSE_DELAY_MS);
    },

    /* ------------------------------ events ------------------------------- */

    bindEvents: function () {
      var grid = View.els.dayGrid;

      // Week change
      Dom.on(View.els.weekSelect, 'change', Boundary.guard(function (event) {
        var weekId = event.target.value;
        if (!weekId || weekId === state.selectedWeekId) { return; }
        App.loadWeek(weekId);
        var week = Store.getWeek(weekId);
        Toast.info('Week switched', week ? 'Now planning the week of ' + week.label + '.' : '');
      }, 'week-change'));

      // Delegated clicks: add row / delete row / clear day
      Dom.on(grid, 'click', Boundary.guard(function (event) {
        var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
        if (!target) { return; }
        var action = target.getAttribute('data-action');

        if (action === 'add-entry') { App.onAddEntry(target); }
        else if (action === 'delete-entry') { App.onDeleteEntry(target); }
        else if (action === 'clear-day') { App.onClearDay(target); }
      }, 'grid-click'));

      // Delegated typing (name inputs) -> state update + lookup search
      Dom.on(grid, 'input', Boundary.guard(function (event) {
        var input = event.target;
        if (!input || input.getAttribute('data-entry-input') !== 'name') { return; }
        App.onFieldChange(input, 'name', input.value);

        var ctx = App.contextOf(input);
        if (ctx && ctx.entryId) { Suggest.request(input, ctx, input.value); }
      }, 'grid-input'));

      // Re-open suggestions when focusing a row that has text but no record yet
      Dom.on(grid, 'focusin', Boundary.guard(function (event) {
        var input = event.target;
        if (!input || input.getAttribute('data-entry-input') !== 'name') { return; }
        var ctx = App.contextOf(input);
        if (!ctx || !ctx.entryId) { return; }
        var entry = Store.getEntry(ctx.dayId, ctx.type, ctx.entryId);
        if (entry && entry.name && !entry.recordId) { Suggest.request(input, ctx, entry.name); }
      }, 'grid-focusin'));

      Dom.on(grid, 'focusout', Boundary.guard(function (event) {
        var input = event.target;
        if (!input || input.getAttribute('data-entry-input') !== 'name') { return; }
        // Let a mousedown on the panel win the race against blur.
        window.setTimeout(function () {
          if (document.activeElement !== input) { Suggest.closeFor(App.entryIdOf(input)); }
        }, 120);
      }, 'grid-focusout'));

      // Delegated purpose / transport + schedule-status changes
      Dom.on(grid, 'change', Boundary.guard(function (event) {
        var select = event.target;
        if (!select) { return; }

        if (select.hasAttribute('data-day-status')) {
          App.onStatusChange(select);
          return;
        }
        var field = select.getAttribute('data-entry-input');
        if (field !== 'reason' && field !== 'transport') { return; }
        App.onFieldChange(select, field, select.value);
      }, 'grid-change'));

      // Keyboard: the open suggestion list gets first refusal on the arrows,
      // Enter and Escape. Only then does Enter mean "add another row".
      Dom.on(grid, 'keydown', Boundary.guard(function (event) {
        var input = event.target;
        if (!input || input.getAttribute('data-entry-input') !== 'name') { return; }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (Suggest.isOpen()) {
            event.preventDefault();
            Suggest.move(event.key === 'ArrowDown' ? 1 : -1);
          } else {
            var openCtx = App.contextOf(input);
            if (openCtx && openCtx.entryId && input.value.trim()) {
              event.preventDefault();
              Suggest.request(input, openCtx, input.value);
            }
          }
          return;
        }

        if (event.key === 'Escape') {
          if (Suggest.isOpen()) { event.preventDefault(); Suggest.close(); }
          return;
        }

        if (event.key === 'Tab') {
          // Tabbing away commits the highlighted record rather than losing it.
          if (Suggest.isOpen()) { Suggest.choose(); }
          return;
        }

        if (event.key !== 'Enter') { return; }
        event.preventDefault();

        if (Suggest.isOpen() && Suggest.choose()) { return; }

        // Adding a fresh row while this one is still blank just makes clutter.
        if (!input.value.trim()) { return; }

        var ctx = App.contextOf(input);
        if (ctx) { App.addEntry(ctx.dayId, ctx.type); }
      }, 'grid-keydown'));

      // Footer actions
      Dom.on(View.els.resetBtn, 'click', Boundary.guard(this.onReset, 'reset'));
      Dom.on(View.els.saveBtn, 'click', Boundary.guard(this.onSave, 'save'));

      // Fallback retry
      Dom.on(View.els.fallbackRetry, 'click', Boundary.guard(function () {
        Boundary.hide();
        App.bootUI();
      }, 'fallback-retry'));

      // Warn before losing unsaved work (ignored inside some CRM sandboxes)
      Dom.on(window, 'beforeunload', function (event) {
        try {
          if (Store.totals().entries > 0) {
            event.preventDefault();
            event.returnValue = '';
          }
        } catch (e) { /* ignore */ }
      });
    },

    /** Resolve { dayId, type, entryId } from any node inside a card. */
    contextOf: function (node) {
      if (!node || !node.closest) { return null; }
      var card = node.closest('[data-day-card]');
      if (!card) { return null; }
      var row = node.closest('[data-entry-row]');
      var button = node.closest('[data-type]');
      return {
        dayId: card.getAttribute('data-day-id'),
        type: row ? row.getAttribute('data-entry-type') : (button ? button.getAttribute('data-type') : null),
        entryId: row ? row.getAttribute('data-entry-id') : null
      };
    },

    /* ---------------------------- row actions ---------------------------- */

    onAddEntry: function (button) {
      var ctx = this.contextOf(button);
      if (!ctx || !ctx.dayId || !ENTRY_META[ctx.type]) {
        Toast.error('Could not add row', 'Please reload the widget and try again.');
        return;
      }
      this.addEntry(ctx.dayId, ctx.type);
    },

    addEntry: function (dayId, type) {
      var day = Store.getDay(dayId);
      var meta = ENTRY_META[type];
      if (!day || !meta) { return; }

      if (Store.listOf(day, type).length >= CONFIG.MAX_ROWS_PER_TYPE) {
        Toast.warning('Limit reached',
          'You can add up to ' + CONFIG.MAX_ROWS_PER_TYPE + ' ' + meta.labelPlural.toLowerCase() +
          ' for ' + day.dayName + '.');
        return;
      }

      var entry = Store.addEntry(dayId, type);
      if (!entry) { return; }

      View.appendRow(day, type, entry);
      View.refreshDay(day);
      Store.persist();
    },

    onDeleteEntry: function (button) {
      var ctx = this.contextOf(button);
      if (!ctx || !ctx.dayId || !ctx.entryId) { return; }

      var day = Store.getDay(ctx.dayId);
      var removed = Store.removeEntry(ctx.dayId, ctx.type, ctx.entryId);
      if (!day || !removed) { return; }

      Suggest.closeFor(ctx.entryId);
      View.removeRow(ctx.dayId, ctx.type, ctx.entryId);
      View.refreshDay(day);
      this.revalidateDay(day, ctx.type, { requireName: false });
      this.clearWarningWhenClean();
      Store.persist();
    },

    /**
     * Schedule status changed. Switching away from Active discards that day's
     * visits, so confirm first when there is something to lose — and put the
     * dropdown back if the user says no.
     */
    onStatusChange: function (select) {
      var ctx = this.contextOf(select);
      var day = ctx ? Store.getDay(ctx.dayId) : null;
      if (!day) { return; }

      var next = select.value;
      var previous = day.status;
      if (next === previous) { return; }

      if (day.locked) {
        select.value = previous;
        Toast.warning('Locked by CRM',
          day.dateLabel + ' is ' + day.holidayName + ', a business holiday. Its status cannot be changed.');
        return;
      }

      var planned = day.schools.length + day.dealers.length;

      if (next !== STATUS_ACTIVE && planned > 0) {
        Modal.confirm('Mark ' + day.dayName + ' as ' + next + '?',
          'The ' + planned + ' visit' + (planned === 1 ? '' : 's') + ' planned for ' +
          day.dateLabel + ' will be removed.',
          'Yes, mark ' + next)
          .then(Boundary.guard(function (ok) {
            if (!ok) { select.value = previous; return; }
            App.commitStatus(day, next);
          }, 'status-confirm'));
        return;
      }

      this.commitStatus(day, next);
    },

    commitStatus: function (day, status) {
      Suggest.close();
      if (!Store.setStatus(day.id, status)) { return; }

      var refs = View.cards[day.id];
      if (refs && status !== STATUS_ACTIVE) {
        Dom.clear(refs.rows.school);
        Dom.clear(refs.rows.dealer);
      }

      View.refreshDay(day);
      this.revalidate({ requireName: false });
      this.clearWarningWhenClean();
      Store.persist();
    },

    onClearDay: function (button) {
      var ctx = this.contextOf(button);
      var day = ctx ? Store.getDay(ctx.dayId) : null;
      if (!day) { return; }

      Modal.confirm('Clear ' + day.dayName + '?',
        'All schools and dealers planned for ' + day.dateLabel + ' will be removed.',
        'Yes, clear day')
        .then(Boundary.guard(function (ok) {
          if (!ok) { return; }
          Suggest.close();
          Store.clearDay(day.id);
          var refs = View.cards[day.id];
          if (refs) {
            Dom.clear(refs.rows.school);
            Dom.clear(refs.rows.dealer);
          }
          View.refreshDay(day);
          Store.persist();
          Toast.success(day.dayName + ' cleared', 'You can start planning this day again.');
        }, 'clear-day-confirm'));
    },

    /** Live field edit: update state, re-run duplicate checks for that group. */
    onFieldChange: function (node, field, value) {
      var ctx = this.contextOf(node);
      if (!ctx || !ctx.dayId || !ctx.entryId) { return; }

      Store.updateEntry(ctx.dayId, ctx.type, ctx.entryId, field, value);

      if (field === 'name') {
        // Typing over a chosen record breaks the link — the text no longer
        // provably names that Account/Vendor, so drop the stale recordId.
        var entry = Store.getEntry(ctx.dayId, ctx.type, ctx.entryId);
        if (entry && entry.recordId) {
          Store.updateEntry(ctx.dayId, ctx.type, ctx.entryId, 'recordId', '');
          View.markLinked(ctx.dayId, ctx.type, ctx.entryId, false);
        }

        var day = Store.getDay(ctx.dayId);
        if (day) { this.revalidateDay(day, ctx.type, { requireName: false }); }
        this.clearWarningWhenClean();
      }
      this.schedulePersist();
    },

    entryIdOf: function (node) {
      var ctx = this.contextOf(node);
      return ctx ? ctx.entryId : null;
    },

    /** Drops the sticky save-error hint as soon as the week validates again. */
    clearWarningWhenClean: function () {
      if (!View.isHintWarning()) { return; }
      if (Validator.checkWeek({ requireName: true, requireLink: true }).valid) {
        View.setHint('', false);
        View.refreshSummary();
      }
    },

    /** Debounced persistence so typing does not hammer localStorage. */
    schedulePersist: (function () {
      var timer = null;
      return function () {
        if (timer) { window.clearTimeout(timer); }
        timer = window.setTimeout(function () {
          timer = null;
          Store.persist();
        }, 400);
      };
    })(),

    /* ----------------------------- validation ---------------------------- */

    revalidateDay: function (day, type, options) {
      var errors = Validator.checkList(day, type, options || {});
      View.paintErrors(day, type, errors);
      return errors;
    },

    /** Re-run validation over the whole week and paint the results. */
    revalidate: function (options) {
      var opts = options || {};
      var report = Validator.checkWeek({
        requireName: !!opts.requireName,
        requireLink: !!opts.requireLink
      });
      state.days.forEach(function (day) {
        ['school', 'dealer'].forEach(function (type) {
          View.paintErrors(day, type, report.byDay[day.id][type]);
        });
      });
      return report;
    },

    /* --------------------------- footer actions -------------------------- */

    onReset: function () {
      var totals = Store.totals();
      if (totals.entries === 0) {
        Toast.info('Nothing to reset', 'This week has no planned visits yet.');
        return;
      }

      var week = Store.getWeek(state.selectedWeekId);
      Modal.confirm('Reset this week?',
        'All schools and dealers added for the week of ' + (week ? week.label : 'this week') +
        ' will be removed. This cannot be undone.',
        'Yes, reset week')
        .then(Boundary.guard(function (ok) {
          if (!ok) { return; }
          var days = Store.resetWeek();
          View.renderWeek(days);
          View.setHint('Week cleared. Start adding visits again.', false);
          Toast.success('Week reset', 'All entries for this week have been cleared.');
        }, 'reset-confirm'));
    },

    /* ------------------------- CRM payload builders ---------------------- */

    /**
     * "03 Aug 2026 – 08 Aug 2026" — derived, never typed by the user.
     * Built from the dates rather than reused from week.rangeLabel: that label
     * is padded with double spaces for the summary bar, which would leak into
     * the record name.
     */
    plannerName: function () {
      var week = Store.getWeek(state.selectedWeekId);
      return week ? this.rangeNameForWeek(week) : state.selectedWeekId;
    },

    /** Same "03 Aug 2026 – 08 Aug 2026" label, for any week (not just the selected one). */
    rangeNameForWeek: function (week) {
      if (!week) { return ''; }
      var saturday = DateUtil.addDays(week.date, CONFIG.DAYS_PER_WEEK - 1);
      return DateUtil.longLabel(week.date) + ' – ' + DateUtil.longLabel(saturday);
    },

    /**
     * One Weekly_Planner record whose Plan_Details subform holds one row per
     * visit. Each row is single-sided by design: a school row fills School_Name
     * and leaves Dealer_Name empty, and vice versa. Purpose and
     * Transport_Medium are per-row and shared by both sides.
     * Holiday / Leave days contribute a single row that records only the status.
     */
    buildPlannerRecord: function () {
      var rows = [];

      state.days.forEach(function (day) {
        if (!Store.isActive(day)) {
          rows.push({
            Date: day.dateISO,
            Schedule_Status: day.status
          });
          return;
        }

        ['school', 'dealer'].forEach(function (type) {
          var field = type === 'school' ? 'School_Name' : 'Dealer_Name';
          Store.listOf(day, type).forEach(function (entry) {
            var row = {
              Date: day.dateISO,
              Purpose: entry.reason,
              Transport_Medium: entry.transport,
              Schedule_Status: STATUS_ACTIVE
            };
            row[field] = { id: entry.recordId };
            rows.push(row);
          });
        });
      });

      var record = { Name: this.plannerName(), Status: CONFIG.PLANNER_DEFAULT_STATUS };
      record[CONFIG.PLANNER_SUBFORM] = rows;
      return record;
    },

    /**
     * Meeting_Planned is one record per visit, not per week: every school and
     * every dealer on an active day becomes its own row. Holiday / Leave days
     * still produce one record so the day is accounted for, with Day_Status
     * mirroring Schedule_Status and no school/dealer lookup attached.
     *
     * The Weekly_Planner lookup is NOT set here — the planner id only exists
     * once that record has been written, so App.submit stamps it on.
     */
    buildMeetingRecords: function () {
      var records = [];

      state.days.forEach(function (day) {
        if (!Store.isActive(day)) {
          records.push({
            Name: day.dateLabel + ' / ' + day.status,
            Date: day.dateISO,
            Day_Status: day.status
          });
          return;
        }

        ['school', 'dealer'].forEach(function (type) {
          var meta = ENTRY_META[type];
          var field = type === 'school' ? 'School_Name' : 'Dealer_Name';

          Store.listOf(day, type).forEach(function (entry) {
            var record = {
              Name: day.dateLabel + ' / ' + entry.name,
              Date: day.dateISO,
              Type: meta.label,              // "School" / "Dealer"
              Purpose: entry.reason,
              Transport_Medium: entry.transport,
              Day_Status: STATUS_ACTIVE
            };
            record[field] = { id: entry.recordId };
            records.push(record);
          });
        });
      });

      return records;
    },

    /**
     * Point every meeting record at the planner that was just created, so the
     * week's meetings are associated with their Weekly_Planner record in CRM.
     * Mutates in place: these objects are only ever used for this one insert.
     */
    linkMeetingsToPlanner: function (meetings, plannerId) {
      if (!plannerId) { return meetings; }
      meetings.forEach(function (record) {
        record[CONFIG.MEETING_PLANNER_LOOKUP] = { id: plannerId };
      });
      return meetings;
    },

    onSave: function () {
      var totals = Store.totals();

      if (state.submitting) { return; }

      if (totals.entries === 0 && totals.offDays === 0) {
        Toast.warning('Nothing to save', 'Add at least one school or dealer before saving.');
        View.setHint('Add at least one visit before saving.', true);
        return;
      }

      if (totals.incompleteDays > 0) {
        Toast.error('School or Dealer required',
          totals.incompleteDays + ' Active day' + (totals.incompleteDays === 1 ? '' : 's') +
          ' need at least one School or Dealer, or mark ' +
          (totals.incompleteDays === 1 ? 'it' : 'them') + ' as Holiday/Leave.');
        View.setHint('Add at least one School or Dealer to every Active day before saving.', true);
        return;
      }

      // Blank names and unresolved lookups are enforced only at save time.
      var report = App.revalidate({ requireName: true, requireLink: true });

      if (!report.valid) {
        var messages = [];
        if (report.duplicates) {
          messages.push(report.duplicates + ' duplicate entr' + (report.duplicates === 1 ? 'y' : 'ies'));
        }
        if (report.blanks) {
          messages.push(report.blanks + ' empty name' + (report.blanks === 1 ? '' : 's'));
        }
        if (report.unlinked) {
          messages.push(report.unlinked + ' unmatched record' + (report.unlinked === 1 ? '' : 's'));
        }
        Toast.error('Please fix ' + messages.join(' and '), 'Highlighted rows need your attention.');
        View.setHint('Fix the highlighted rows, then save again.', true);
        View.focusFirstError();
        return;
      }

      var week = Store.getWeek(state.selectedWeekId);

      // The PlannerLock dropdown check runs on load and on every widget
      // refresh, but a click can land before that background search finishes
      // (or before a refresh has even happened). Re-verify against CRM right
      // here, at the moment records would actually be written, instead of
      // trusting whatever state.createdPlanners happened to hold when the
      // Save button was last drawn — that is what let a refreshed widget
      // create a second record for an already-planned week.
      state.submitting = true;
      View.refreshSaveEnabled();

      App.recheckPlannerLock(week).then(Boundary.guard(function (locked) {
        state.submitting = false;
        View.refreshSaveEnabled();

        if (locked) {
          View.renderWeekOptions(state.weeks, state.selectedWeekId, PlannerLock);
          Toast.error('Already planned',
            'A ' + CONFIG.PLANNER_MODULE + ' record already exists for this week — it cannot be created again.');
          View.setHint('This week already has a ' + CONFIG.PLANNER_MODULE +
            ' record. Pick a different week.', true);
          return;
        }

        // Trim stored names so the saved payload is clean.
        state.days.forEach(function (day) {
          ['schools', 'dealers'].forEach(function (key) {
            day[key].forEach(function (entry) {
              entry.name = String(entry.name || '').trim().replace(/\s+/g, ' ');
            });
          });
        });

        Store.persist();

        var planner = App.buildPlannerRecord();
        var meetings = App.buildMeetingRecords();

        Log.info('Weekly Planner payload', planner);
        Log.info('Meeting Planned payload (' + meetings.length + ' record(s))', meetings);

        if (!Crm.isReady()) {
          // Outside CRM there is nothing to write to; log so the shape is checkable.
          Toast.warning('Not connected to CRM',
            'The plan was validated and logged to the console, but no records were created.');
          View.setHint('Not connected to CRM — nothing was created.', true);
          return;
        }

        var summary = [
          totals.entries + ' visit' + (totals.entries === 1 ? '' : 's')
        ];
        if (totals.offDays) {
          summary.push(totals.offDays + ' holiday/leave day' + (totals.offDays === 1 ? '' : 's'));
        }

        var question = 'This creates 1 ' + CONFIG.PLANNER_MODULE + ' record and ' + meetings.length + ' ' +
          CONFIG.MEETING_MODULE + ' record' + (meetings.length === 1 ? '' : 's') + ' — ' +
          summary.join(', ') + '.';

        Modal.confirm('Create weekly plan?', question, 'Yes, create records', 'primary')
          .then(Boundary.guard(function (ok) {
            if (ok) { App.submit(planner, meetings); }
          }, 'save-confirm'));
      }, 'save-lock-check'));
    },

    /**
     * Live, single-week PlannerLock re-check. A week already known-locked in
     * this session short-circuits without a network call; otherwise this
     * queries CRM directly (Name + Owner, same as the background check) so
     * Save is never gated purely by whether a refresh happened to run.
     * @returns {Promise<boolean>} true when the week is already planned
     */
    recheckPlannerLock: function (week) {
      if (!week) { return Promise.resolve(false); }
      if (state.createdPlanners[week.id]) { return Promise.resolve(true); }

      return PlannerLock.loadForWeeks([week]).then(function () {
        if (!PlannerLock.isLocked(week.id)) { return false; }
        state.createdPlanners[week.id] = PlannerLock.plannerIdFor(week.id);
        return true;
      });
    },

    /**
     * Create the planner, then its meetings. The two inserts are deliberately
     * sequential: if the planner cannot be written there is no point creating
     * orphan meeting records.
     */
    submit: function (planner, meetings) {
      state.submitting = true;
      View.setBusy(true);
      View.setHint('Creating records in CRM…', false);

      var plannerId = '';

      Crm.insertOne(CONFIG.PLANNER_MODULE, planner)
        .then(function (id) {
          plannerId = id;
          Log.info('Created ' + CONFIG.PLANNER_MODULE + ' ' + id);
          if (!meetings.length) { return { ids: [], errors: [] }; }
          // Only now does the lookup have something to point at.
          App.linkMeetingsToPlanner(meetings, plannerId);
          Log.info('Meeting Planned payload linked to ' + CONFIG.PLANNER_MODULE + ' ' + plannerId, meetings);
          return Crm.insertMany(CONFIG.MEETING_MODULE, meetings);
        })
        .then(Boundary.guard(function (result) {
          var weekId = state.selectedWeekId;
          state.createdPlanners[weekId] = plannerId;
          // Lock the week immediately (refreshSaveEnabled reads this) so Save
          // cannot fire again for it even if closeWidget() cannot actually
          // close the popup here (e.g. standalone/dev preview).
          PlannerLock.markCreated(weekId, plannerId);

          if (result.errors.length) {
            // The planner exists but some meetings did not make it — say so
            // plainly rather than reporting a clean success. The form is left
            // as-is so the user can see what was entered while it failed.
            Log.error('Meeting insert errors:', result.errors);
            Toast.error('Planner created, ' + result.errors.length + ' meeting(s) failed',
              result.errors[0]);
            View.setHint('Planner ' + plannerId + ' created, but ' + result.errors.length +
              ' of ' + meetings.length + ' meeting records failed. See the console.', true);
            return;
          }

          // Success: clear the entered data and re-render so the form cannot
          // be resubmitted for this week, then restore the success hint
          // (renderWeek's summary refresh would otherwise show the default one).
          var days = Store.resetWeek();
          View.renderWeek(days);
          View.renderWeekOptions(state.weeks, state.selectedWeekId, PlannerLock);

          Toast.success('Weekly plan created',
            CONFIG.PLANNER_MODULE + ' record + ' + result.ids.length + ' ' +
            CONFIG.MEETING_MODULE + ' record' + (result.ids.length === 1 ? '' : 's') + ' created.');
          View.setHint('Created planner ' + plannerId + ' with ' + result.ids.length +
            ' meeting record' + (result.ids.length === 1 ? '' : 's') + '.', false);
          App.closeWidget();
        }, 'submit-done'))
        .catch(Boundary.guard(function (err) {
          var message = Boundary.describe(err);
          Log.error('Save failed:', err);
          Toast.error('Could not create the plan', message);
          View.setHint(plannerId
            ? 'Planner ' + plannerId + ' was created, but the meeting records failed: ' + message
            : 'Nothing was created — ' + message, true);
        }, 'submit-failed'))
        .then(function () {
          state.submitting = false;
          View.setBusy(false);
        });
    }
  };

  /* ======================================================================
     BOOTSTRAP
     ====================================================================== */

  function start() {
    try {
      App.init();
    } catch (err) {
      // Absolute last resort: the app failed before its own boundary existed.
      Boundary.report(err, 'bootstrap');
      try {
        var grid = document.getElementById('dayGrid');
        var fallback = document.getElementById('fallbackPanel');
        if (grid) { grid.hidden = true; }
        if (fallback) { fallback.hidden = false; }
      } catch (e) { /* nothing more we can do */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* Exposed for debugging / future CRM integration hooks. */
  window.WeeklyPlan = {
    state: state,
    Store: Store,
    DateUtil: DateUtil,
    Validator: Validator,
    Lookup: Lookup,
    Suggest: Suggest,
    Holidays: Holidays,
    PlannerLock: PlannerLock,
    Crm: Crm,
    View: View,
    App: App,
    modules: {
      school: ENTRY_META.school.module,
      dealer: ENTRY_META.dealer.module,
      planner: CONFIG.PLANNER_MODULE,
      meeting: CONFIG.MEETING_MODULE,
      meetingPlannerLookup: CONFIG.MEETING_PLANNER_LOOKUP
    },
    version: '1.3.0'
  };
})();
