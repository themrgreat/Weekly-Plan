console.clear();

/* ==========================================================================
   Zoho CRM Widget : Weekly Plan  -  Application layer
   --------------------------------------------------------------------------
   Architecture (single IIFE, no globals leaked except WeeklyPlan for debug):

     Log            console wrapper with a widget prefix
     Boundary       global error boundary -> never leaves a blank surface
     DateUtil       pure date helpers (next-4-Mondays logic lives here)
     Store          single source of truth + per-week draft cache (in-memory only)
     Holidays       CRM business holidays -> auto-lock matching days
     Settings       admin-controlled Current/Previous week access (CRM Variables)
     Users          active CRM users for Team Member, scoped by Region
     PlannerLock    detects a Weekly_Planner this user already created
     Validator      duplicate / empty / unlinked checks
     Lookup         CRM record search (Accounts / Vendors) + result cache
     Toast          transient feedback
     Modal          promise based confirm dialog
     Crm            record creation (Weekly_Planner)
     Suggest        shared autocomplete popover for the lookup inputs
     View           DOM rendering (day cards, entry rows, badges, summary)
     AdminSettings  admin-only "Schedule access" panel
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
         status:    "Active",                 // Active | Holiday | Leave | Team Working
         holidayName: "",                               // set when locked by CRM
         locked:    false,                              // CRM holiday -> not editable
         schools:   [{ id, recordId, name, reason, transport }], // recordId -> Accounts, Active only
         dealers:   [{ id, recordId, name, reason, transport }], // recordId -> Vendors, Active only
         teamMemberId: ""                               // set only while status is Team Working
       }, ... Saturday
     ]

   Save creates one record (see App.buildPlannerRecord):

     Weekly_Planner    1 record. Name is derived ("03 Aug 2026 – 08 Aug
                       2026"). Subform Plan_Details holds one row per visit;
                       a row is single-sided — School_Name OR Dealer_Name, never
                       both — with Purpose, Transport_Medium and Schedule_Status.
                       Holiday / Leave days contribute one status-only row.
                       Team Working days contribute one status-only row too,
                       carrying just Team_Member — School/Dealer never appear
                       on a Team Working day, so they are neither shown in the
                       UI nor mandatory to save one.
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

    /* Business holidays (Deluge equivalent: invokeUrl + connection "zohocrm") */
    HOLIDAY_CONNECTION: 'zohocrm',
    HOLIDAY_URL: 'https://www.zohoapis.in/crm/v8/settings/holidays',

    /**
     * Admin-controlled Current/Previous week schedule access. Only this CRM
     * user id sees the "Enable Past Weeks" control. Applies to every user
     * once enabled — there is no per-user targeting.
     *
     * Backed by two plain Checkbox Variables (Setup > Developer Space >
     * Variables, group api_name "General"), read/written through the same
     * CONNECTION.invoke pattern as Holidays above — the "zohocrm" connection
     * must additionally be granted ZohoCRM.settings.variables.ALL. Both
     * variables must already exist (created manually in the CRM UI); this
     * widget only reads/updates their value, it does not create them.
     */
    ADMIN_USER_ID: '1343779000000459001',
    SETTINGS_API_DOMAIN: 'https://www.zohoapis.in',
    SETTINGS_VARIABLE_GROUP: 'General',
    ENABLE_VARIABLE_NAME: 'isEnable',
    CURRENT_VARIABLE_NAME: 'isCurrentWeek',
    PREVIOUS_VARIABLE_NAME: 'isPreviousWeek',

    /**
     * Team Member - single-user lookup, per day, shown only while that day's
     * Schedule_Status is "Team Working" (replacing School/Dealer entirely for
     * that day). Same api name as the Plan_Details subform field it's saved
     * into (see App.buildPlannerRecord). The active-user list backing the
     * picklist is fetched once per session via the same CONNECTION.invoke
     * pattern as Holidays/Settings above.
     */
    TEAM_MEMBER_FIELD: 'Team_Member',
    USERS_URL: 'https://www.zohoapis.in/crm/v8/users?type=ActiveUsers',

    /**
     * Users module custom field. The Team Member picklist is scoped to only
     * the signed-in user's own region (see Users.load()) — never shown as a
     * separate frontend filter, purely a backend narrowing of the same list.
     *
     * Fetched via CURRENT_USER_URL, NOT ZOHO.CRM.CONFIG.getCurrentUser() —
     * getCurrentUser() returns a fixed set of ~27 standard fields and never
     * includes custom fields, confirmed by inspecting its response in this
     * CRM org (no Region, no custom field of any kind present).
     */
    REGION_FIELD: 'Region',
    /** Region value meaning "all regions": a user with this region sees every user. */
    REGION_ALL: 'All',
    CURRENT_USER_URL: 'https://www.zohoapis.in/crm/v8/users?type=CurrentUser',

    /**
     * Global Multi-Line CRM Variable (group SETTINGS_VARIABLE_GROUP) holding
     * user ids that are listed in EVERY user's Team Member picklist regardless
     * of their region (temporary visibility for e.g. an owner with no region).
     * Value is free-form text containing the ids ("{}" / blank = none) - see
     * Users._parseIds().
     */
    TEMPORARY_VISIBLE_VARIABLE_NAME: 'temporaryVisibleUserIds'
  };

  /* Purpose picklist — values must match the CRM picklist exactly. */
  var REASONS = [
    'Cold Call',
    'Relationship Meeting',
    'Sample Book Submission',
    'Gift Distribution',
    'Payment Collection',
    'Post-sales Service',
    'Workshop/Webinar Invitation',
    'Work from Home',
    'Team Meeting'
  ];

  /**
   * Transport_Medium picklist. Same contract as REASONS: every entry row owns
   * its own value, and the strings must match the CRM picklist exactly.
   */
  var TRANSPORTS = [
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

  /* Schedule_Status picklist. ACTIVE and TEAM_WORKING both accept schools / dealers. */
  var STATUS_ACTIVE = 'Active';
  var STATUS_HOLIDAY = 'Holiday';
  var STATUS_LEAVE = 'Leave';
  var STATUS_TEAM_WORKING = 'Team Working';
  var SCHEDULE_STATUSES = [STATUS_ACTIVE, STATUS_HOLIDAY, STATUS_LEAVE, STATUS_TEAM_WORKING];

  /**
   * Active and Team Working are functionally identical — both are "working"
   * days that accept School / Dealer visits. Holiday and Leave are not.
   * Single source of truth so the two statuses never drift apart again.
   */
  function isPlannableStatus(status) {
    return status === STATUS_ACTIVE || status === STATUS_TEAM_WORKING;
  }

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

    /**
     * The Monday of the week containing `from` — "Current Monday" for the
     * past-weeks feature. Today if today is Mon..Sat; last week's Monday if
     * today is Sunday (weeks in this widget run Monday..Saturday only).
     */
    currentMonday: function (from) {
      var base = this.startOfDay(from || new Date());
      var back = (base.getDay() + 6) % 7;   // Mon->0, Tue->1, ... Sun->6
      return this.addDays(base, -back);
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
    /** Shared {id, date, label, rangeLabel} shape used by every week option. */
    _weekDescriptor: function (monday, year) {
      var saturday = DateUtil.addDays(monday, CONFIG.DAYS_PER_WEEK - 1);
      return {
        id: DateUtil.toISO(monday),
        date: monday,
        label: DateUtil.shortLabel(monday, year),
        rangeLabel: DateUtil.longLabel(monday) + '  –  ' + DateUtil.longLabel(saturday)
      };
    },

    /** Build the week options from today's date. */
    buildWeeks: function () {
      var today = new Date();
      var year = today.getFullYear();
      var mondays = DateUtil.nextMondays(CONFIG.WEEKS_TO_SHOW, today);
      var self = this;

      state.weeks = mondays.map(function (monday) {
        return self._weekDescriptor(monday, year);
      });

      return state.weeks;
    },

    /**
     * Admin-controlled past-weeks feature: reconciles Current Monday and/or
     * Previous Monday against `settings` ahead of the existing next-4-week
     * options — adds either one that should be shown and isn't there yet,
     * removes either one that shouldn't be shown but still is (e.g. the
     * Admin just disabled it). Idempotent and safe to call on every refresh.
     * Current/Previous Monday are never part of the plain next-4-week list
     * (nextMondays always starts strictly after today), so there is no
     * collision risk when stripping them out to recompute.
     * @param {{enabled:boolean, showCurrent:boolean, showPrevious:boolean}} settings
     * @returns {boolean} true if state.weeks actually changed
     */
    applyScheduleRange: function (settings) {
      var today = new Date();
      var year = today.getFullYear();
      var currentMonday = DateUtil.currentMonday(today);
      var previousMonday = DateUtil.addDays(currentMonday, -7);
      var currentId = DateUtil.toISO(currentMonday);
      var previousId = DateUtil.toISO(previousMonday);

      var beforeIds = state.weeks.map(function (week) { return week.id; }).join(',');

      state.weeks = state.weeks.filter(function (week) {
        return week.id !== currentId && week.id !== previousId;
      });

      var enabled = !!(settings && settings.enabled);
      var prepend = [];
      if (enabled && settings.showPrevious) { prepend.push(this._weekDescriptor(previousMonday, year)); }
      if (enabled && settings.showCurrent) { prepend.push(this._weekDescriptor(currentMonday, year)); }
      if (prepend.length) { state.weeks = prepend.concat(state.weeks); }

      var afterIds = state.weeks.map(function (week) { return week.id; }).join(',');
      return beforeIds !== afterIds;
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
          dealers: [],
          teamMemberId: ''
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
          if (!isPlannableStatus(day.status)) { return; }

          if (day.status === STATUS_TEAM_WORKING) {
            // Restored as-is; a since-deactivated user just shows the
            // placeholder in the select instead of a matching name.
            day.teamMemberId = typeof saved.teamMemberId === 'string' ? saved.teamMemberId : '';
            return;
          }

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

    /** Active and Team Working both count as "on" — see isPlannableStatus. */
    isActive: function (day) { return !!day && isPlannableStatus(day.status); },

    /**
     * Set a day's Schedule_Status. Holiday / Leave drop any planned visits —
     * an off day carries no schools or dealers into the CRM payload. Team
     * Working also drops them: School/Dealer are Active-only, replaced for
     * that day by the single Team Member field (see setTeamMember).
     * @returns {boolean} false when the day is locked by a CRM holiday
     */
    setStatus: function (dayId, status) {
      var day = this.getDay(dayId);
      if (!day || day.locked || SCHEDULE_STATUSES.indexOf(status) < 0) { return false; }
      day.status = status;
      if (!isPlannableStatus(status) || status === STATUS_TEAM_WORKING) { this.clearDay(dayId); }
      return true;
    },

    /** Team Member is per-day and only meaningful while status is Team Working. */
    setTeamMember: function (dayId, teamMemberId) {
      var day = this.getDay(dayId);
      if (!day) { return null; }
      day.teamMemberId = typeof teamMemberId === 'string' ? teamMemberId : '';
      return day;
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
      var out = {
        schools: 0, dealers: 0, days: 0, entries: 0,
        teamAssigned: 0, offDays: 0, incompleteDays: 0
      };
      state.days.forEach(function (day) {
        if (!isPlannableStatus(day.status)) { out.offDays++; return; }
        if (day.status === STATUS_TEAM_WORKING) {
          if (day.teamMemberId) { out.teamAssigned++; } else { out.incompleteDays++; }
          return;
        }
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
    load: async function () {
      if (!this._canInvoke()) {
        Log.warn('Holiday lookup skipped - no CRM connection available.');
        return { status: 'skipped', count: 0 };
      }

      try {
        var response = await window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
          url: CONFIG.HOLIDAY_URL,
          method: 'GET',
          param_type: 1
        });
        var list = this._extract(response);
        this._index(list);
        this._loaded = true;
        Log.info('Loaded ' + this.count() + ' business holiday(s).');
        return { status: 'ok', count: this.count() };
      } catch (err) {
        Log.warn('Holiday fetch failed:', err);
        return { status: 'error', count: 0 };
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
     SETTINGS - Admin-controlled Current/Previous week schedule access

     Stored as three Checkbox Zoho CRM Variables (isEnable / isCurrentWeek /
     isPreviousWeek, group General), through the same CONNECTION.invoke
     pattern Holidays uses above — see CONFIG.SETTINGS_* for the one-time CRM
     setup this needs.

     A failure here is never fatal: load() always resolves (to defaults when
     nothing is configured yet or the call fails), same as Holidays. Only
     save() — an explicit Admin action — rejects, so the settings panel can
     show why.
     ====================================================================== */

  var Settings = {
    _cache: null,               // last-loaded { enabled, showCurrent, showPrevious }
    _enabledVariableId: '',     // internal ids, needed to PUT an update
    _currentVariableId: '',
    _previousVariableId: '',
    _loaded: false,

    defaults: function () {
      return { enabled: false, showCurrent: false, showPrevious: false };
    },

    _canInvoke: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM &&
                window.ZOHO.CRM.CONNECTION &&
                typeof window.ZOHO.CRM.CONNECTION.invoke === 'function');
    },

    _getUrl: function (variableName) {
      return CONFIG.SETTINGS_API_DOMAIN + '/crm/v8/settings/variables/' +
        variableName + '?group=' + CONFIG.SETTINGS_VARIABLE_GROUP;
    },

    /**
     * CONNECTION.invoke wraps the upstream body, and how deeply depends on
     * the connection type — same defensive unwrap Holidays._extract uses.
     */
    _extractVariable: function (response) {
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
        if (typeof node === 'string') {
          try { node = JSON.parse(node); } catch (e) { continue; }
        }
        if (Array.isArray(node.variables) && node.variables[0]) { return node.variables[0]; }
        if (node.value !== undefined || node.id !== undefined) { return node; }
      }
      return null;
    },

    /** Checkbox variables come back as the string "ON"/"OFF" (confirmed live; also accept true/"true" defensively). */
    _toBool: function (value) {
      if (typeof value === 'boolean') { return value; }
      var normalized = String(value).trim().toLowerCase();
      return normalized === 'on' || normalized === 'true';
    },

    _loadOne: async function (variableName) {
      var response = await window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
        url: this._getUrl(variableName),
        method: 'GET',
        param_type: 1
      });
      return this._extractVariable(response);
    },

    /** Always resolves to a settings object — defaults when unset or unreachable. */
    load: async function () {
      if (this._loaded && this._cache) { return this._cache; }
      if (!this._canInvoke()) { return this.defaults(); }

      try {
        var rows = await Promise.all([
          this._loadOne(CONFIG.ENABLE_VARIABLE_NAME),
          this._loadOne(CONFIG.CURRENT_VARIABLE_NAME),
          this._loadOne(CONFIG.PREVIOUS_VARIABLE_NAME)
        ]);
        var enabledRow = rows[0];
        var currentRow = rows[1];
        var previousRow = rows[2];
        if (enabledRow && enabledRow.id) { this._enabledVariableId = String(enabledRow.id); }
        if (currentRow && currentRow.id) { this._currentVariableId = String(currentRow.id); }
        if (previousRow && previousRow.id) { this._previousVariableId = String(previousRow.id); }

        this._cache = {
          enabled: this._toBool(enabledRow && enabledRow.value),
          showCurrent: this._toBool(currentRow && currentRow.value),
          showPrevious: this._toBool(previousRow && previousRow.value)
        };
        this._loaded = true;
        return this._cache;
      } catch (err) {
        Log.warn('Schedule-access settings load failed - using defaults.', err);
        this._cache = this.defaults();
        this._loaded = true;
        return this._cache;
      }
    },

    /**
     * Checkbox variables take literal "ON"/"OFF" strings, confirmed live —
     * not "true"/"false" and not a JSON boolean, both of which the API
     * rejects with an INVALID_DATA/expected_data_type "checkbox" error.
     * A successful PUT's extracted row looks like
     * {code:"SUCCESS", details:{id}, message, status:"success"} — the id
     * lives under `details`, not at the top level.
     */
    _saveOne: async function (variableId, boolValue) {
      var response = await window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
        url: CONFIG.SETTINGS_API_DOMAIN + '/crm/v8/settings/variables',
        method: 'PUT',
        param_type: 2,
        parameters: { variables: [{ id: variableId, value: boolValue ? 'ON' : 'OFF' }] }
      });
      var row = this._extractVariable(response);
      var ok = !!row && (row.code === 'SUCCESS' || row.status === 'success');
      if (!ok) {
        var reason = (row && (row.message || row.code)) || 'Save failed.';
        throw new Error(String(reason));
      }
    },

    /**
     * Admin-only write: all three Variables must already exist (created
     * manually in the CRM UI — this widget never creates them). Rejects
     * with a readable Error on failure — the caller shows it.
     */
    save: async function (settings) {
      if (!this._canInvoke()) { throw new Error('Not connected to CRM.'); }
      var haveIds = this._enabledVariableId && this._currentVariableId && this._previousVariableId;
      if (!haveIds) { await this.load(); }
      haveIds = this._enabledVariableId && this._currentVariableId && this._previousVariableId;
      if (!haveIds) {
        throw new Error('Could not find the "' + CONFIG.ENABLE_VARIABLE_NAME + '" / "' +
          CONFIG.CURRENT_VARIABLE_NAME + '" / "' + CONFIG.PREVIOUS_VARIABLE_NAME +
          '" variables in the "' + CONFIG.SETTINGS_VARIABLE_GROUP + '" group.');
      }

      await Promise.all([
        this._saveOne(this._enabledVariableId, !!settings.enabled),
        this._saveOne(this._currentVariableId, !!settings.showCurrent),
        this._saveOne(this._previousVariableId, !!settings.showPrevious)
      ]);

      this._cache = {
        enabled: !!settings.enabled,
        showCurrent: !!settings.showCurrent,
        showPrevious: !!settings.showPrevious
      };
      this._loaded = true;
      return this._cache;
    }
  };

  /* ======================================================================
     USERS - active CRM users, for the Team Member lookup

     Team Member is a single-select field, so unlike Lookup (Accounts /
     Vendors, searched per keystroke) the whole active-user list is fetched
     once via CONNECTION.invoke (same pattern as Holidays/Settings above) and
     cached for the session; the picklist just filters/selects locally.
     A failure here is never fatal: the Team Member field is simply empty,
     same fail-safe contract as Holidays/Settings.

     Scoped to the signed-in user's own CONFIG.REGION_FIELD value (via
     PlannerLock.currentUser(), which already fetches this user once for the
     Weekly_Planner Owner check) and excludes the signed-in user themself —
     backend-only filtering, no region control is ever shown in the UI.
     Region "All" (CONFIG.REGION_ALL) is viewer-side only: a signed-in user
     whose region is All sees every user. A user whose region is All is NOT
     shown to other regions - use the global
     CONFIG.TEMPORARY_VISIBLE_VARIABLE_NAME CRM Variable for users that must
     be seen by everyone whatever their region. Any other user with an empty
     region is hidden; if the current user has no region value, only
     variable-listed users are shown.
     ====================================================================== */

  var Users = {
    _list: [],       // [{id, name}], active users in the current user's own region, self excluded
    _loaded: false,
    _regionPromise: null,   // shared in-flight / settled current-user region fetch
    _loadPromise: null,     // shared in-flight / settled user-list fetch
    _currentUserRegion: '',

    isLoaded: function () { return this._loaded; },
    list: function () { return this._list; },

    _canInvoke: function () {
      return !!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM &&
                window.ZOHO.CRM.CONNECTION && typeof window.ZOHO.CRM.CONNECTION.invoke === 'function');
    },

    /**
     * CONNECTION.invoke wraps the upstream body, and how deeply depends on
     * the connection type - same defensive unwrap Holidays/Settings use.
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
        if (typeof node === 'string') {
          try { node = JSON.parse(node); } catch (e) { continue; }
        }
        if (Array.isArray(node.users)) { return node.users; }
      }
      return [];
    },

    /** Region as a trimmed string; handles plain values and {name|value} objects. '' when unset. */
    _regionValue: function (raw) {
      if (raw === undefined || raw === null) { return ''; }
      if (typeof raw === 'object') { raw = raw.name || raw.value || raw.display_value || ''; }
      return String(raw).trim();
    },

    /**
     * Current signed-in user's CONFIG.REGION_FIELD value, fetched from the
     * full user record (v8/users?type=CurrentUser) — NOT from
     * ZOHO.CRM.CONFIG.getCurrentUser(), which only ever returns a fixed
     * standard field set and never custom fields (confirmed by inspection:
     * its response carries no Region, no custom field at all). Loads once
     * per session (the in-flight promise is shared, so concurrent callers
     * all get the real value); a failure resolves to '' so only variable-listed
     * users are listed rather than blocking the picklist.
     */
    _loadCurrentUserRegion: function () {
      if (!this._regionPromise) { this._regionPromise = this._fetchCurrentUserRegion(); }
      return this._regionPromise;
    },

    _fetchCurrentUserRegion: async function () {
      if (!this._canInvoke()) { return this._currentUserRegion; }

      try {
        var response = await window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
          url: CONFIG.CURRENT_USER_URL,
          method: 'GET',
          param_type: 1
        });
        var rows = this._extract(response);
        var row = rows && rows[0];
        var rawRegion = row ? row[CONFIG.REGION_FIELD] : undefined;
        this._currentUserRegion = this._regionValue(rawRegion);

        // Region debug: shows whether the field is on the record at all
        // (under CONFIG.REGION_FIELD or any region-ish key) and its raw value.
        var regionKeys = row ? Object.keys(row).filter(function (k) { return /region/i.test(k); }) : [];
        Log.info('[Region] CurrentUser record fetched:', !!row,
          '| total keys:', row ? Object.keys(row).length : 0,
          '| keys matching /region/i:', regionKeys,
          '| ' + CONFIG.REGION_FIELD + ' raw value:', rawRegion,
          '| resolved region:', this._currentUserRegion || '(empty)');
        if (!this._currentUserRegion) {
          Log.warn('[Region] Current user has no ' + CONFIG.REGION_FIELD + ' value — only variable-listed users will be listed.' +
            (regionKeys.length && regionKeys.indexOf(CONFIG.REGION_FIELD) === -1
              ? ' A region-ish key exists though (' + regionKeys.join(', ') + ') — check CONFIG.REGION_FIELD.'
              : ''));
        }
      } catch (err) {
        Log.warn('[Region] Current user region fetch failed - only variable-listed users will be listed.', err);
      }

      return this._currentUserRegion;
    },

    /**
     * User ids out of a variable value. Deliberately format-agnostic: pulls
     * every run of 10+ digits, so "id1,id2", newline/space separated, a JSON
     * array, and the "{}" / blank "empty" values all work (empty -> []).
     */
    _parseIds: function (value) {
      if (value === undefined || value === null) { return []; }
      return String(value).match(/\d{10,}/g) || [];
    },

    /**
     * Ids from the temporary-visibility variable, as { userId: true }.
     * Never throws: a missing/unreadable variable just contributes no ids.
     */
    _loadVisibleIds: async function () {
      var name = CONFIG.TEMPORARY_VISIBLE_VARIABLE_NAME;
      var all = {};
      try {
        var row = await Settings._loadOne(name);
        var ids = this._parseIds(row && row.value);
        Log.info('[Region] Variable "' + name + '":', row ? 'found' : 'NOT found',
          '| raw value:', row ? row.value : undefined, '| parsed ids:', ids);
        ids.forEach(function (id) { all[id] = true; });
      } catch (err) {
        Log.warn('[Region] Variable "' + name + '" load failed - treated as empty.', err);
      }
      return all;
    },

    /**
     * Always resolves; loads once per session then serves the cached list.
     * Overlapping calls (first boot + a Zoho PageLoad refresh) share one
     * fetch instead of racing each other.
     */
    load: function () {
      if (this._loaded) { return Promise.resolve(this._list); }
      if (!this._canInvoke()) { return Promise.resolve(this._list); }
      if (!this._loadPromise) { this._loadPromise = this._fetchList(); }
      return this._loadPromise;
    },

    _fetchList: async function () {
      try {
        var owner = await PlannerLock.currentUser();
        var region = await this._loadCurrentUserRegion();
        var visibleIds = await this._loadVisibleIds();

        var response = await window.ZOHO.CRM.CONNECTION.invoke(CONFIG.HOLIDAY_CONNECTION, {
          url: CONFIG.USERS_URL,
          method: 'GET',
          param_type: 1
        });
        var extracted = this._extract(response);

        var self = this;
        var rows = extracted
          .filter(function (u) { return u && u.id && (u.full_name || u.name) && String(u.id) !== owner.id; });

        // Region debug: is the field coming back on the ActiveUsers rows, and
        // how are the values distributed (counts per region)?
        var regionCounts = {};
        rows.forEach(function (u) {
          var key = self._regionValue(u[CONFIG.REGION_FIELD]) || '(empty)';
          regionCounts[key] = (regionCounts[key] || 0) + 1;
        });
        Log.info('[Region] ActiveUsers fetched:', extracted.length, '| excl. self:', rows.length,
          '| field "' + CONFIG.REGION_FIELD + '" present on first row:',
          rows.length ? (CONFIG.REGION_FIELD in rows[0]) : 'n/a',
          '| region distribution:', regionCounts);

        // A user is listed when (a) the signed-in user's region is "All" -
        // every user is visible, (b) their id is in the temporary-visibility
        // variable - region ignored - or (c) their region equals the
        // signed-in user's. Anyone else, including users with an empty
        // region or region "All" (when the viewer is not All), is hidden.
        // If the signed-in user has no region of their own, only (b)
        // applies. Region compare is case-insensitive.
        var allRegion = CONFIG.REGION_ALL.toLowerCase();
        var wanted = region.toLowerCase();
        var seesAll = wanted === allRegion;
        var viaAll = [];
        var viaRegion = [];
        var viaVariable = [];
        rows = rows.filter(function (u) {
          var name = u.full_name || u.name;
          var userRegion = self._regionValue(u[CONFIG.REGION_FIELD]).toLowerCase();
          if (seesAll) { viaAll.push(name); return true; }
          if (visibleIds[String(u.id)]) { viaVariable.push(name); return true; }
          if (wanted && userRegion === wanted) { viaRegion.push(name); return true; }
          return false;
        });
        Log.info('[Region] Signed-in region "' + region + '"' + (seesAll ? ' (All -> sees every region)' : '') +
          ' | listed via All:', viaAll.length, '| via variable:', viaVariable.length, viaVariable,
          '| via same region:', viaRegion.length);

        this._list = rows
          .map(function (u) { return { id: String(u.id), name: String(u.full_name || u.name) }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
        Log.info('Loaded ' + this._list.length + ' active user(s) for Team Member' +
          (region ? ' (region "' + region + '")' : ' (no region on current user - variable-listed users only)') + '.');
      } catch (err) {
        Log.warn('Active user list load failed - Team Member picklist will be empty.', err);
      }
      this._loaded = true;
      return this._list;
    }
  };

  /* ======================================================================
     PLANNER LOCK - detect a Weekly_Planner this user already created

     On open, one search per visible week checks Weekly_Planner for a record
     whose Name is that week's range label plus the owner's name
     ("10 Aug 2026 – 15 Aug 2026 - Jane Doe") AND whose Owner is the signed-in
     user. A hit means this user already planned that week, so it is disabled
     in the dropdown instead of re-created.

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
    _ownerId: '',           // cached once fetched — the signed-in user never changes mid-session
    _ownerName: '',

    isLoaded: function () { return this._loaded; },
    isLocked: function (weekId) { return this._byWeek.hasOwnProperty(weekId); },
    plannerIdFor: function (weekId) { return this._byWeek[weekId] || ''; },
    isCreatedThisSession: function (weekId) { return !!this._createdThisSession[weekId]; },
    /** Signed-in user's display name, or '' before it has been fetched. */
    ownerName: function () { return this._ownerName; },

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

    /**
     * Current user's CRM record id + display name, or '' when the SDK cannot
     * provide them. getCurrentUser() only ever returns a fixed ~27-field
     * standard set (confirmed by inspection) — it never carries custom
     * fields, so region is intentionally NOT read here; see
     * Users._loadCurrentUserRegion() for that.
     */
    currentUser: async function () {
      if (this._ownerId) { return { id: this._ownerId, name: this._ownerName }; }
      if (!(state.sdkConnected && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONFIG &&
            typeof window.ZOHO.CRM.CONFIG.getCurrentUser === 'function')) {
        return { id: '', name: '' };
      }
      try {
        var response = await window.ZOHO.CRM.CONFIG.getCurrentUser();
        var user = response && response.users && response.users[0];
        var id = (user && user.id) ? String(user.id) : '';
        var name = (user && (user.full_name || user.name)) ? String(user.full_name || user.name) : '';
        if (id) { this._ownerId = id; this._ownerName = name; }
        return { id: id, name: name };
      } catch (err) {
        Log.warn('getCurrentUser failed:', err);
        return { id: '', name: '' };
      }
    },

    /**
     * One Name+Owner search per week. Always resolves.
     * @returns {Promise<{status:string}>}
     */
    loadForWeeks: async function (weeks) {
      if (!this._canSearch() || !weeks || !weeks.length) {
        return { status: 'skipped' };
      }
      var self = this;
      var owner = await this.currentUser();
      if (!owner.id) { return { status: 'skipped' }; }

      await Promise.all(weeks.map(function (week) {
        return self._searchWeek(week, owner.id, owner.name);
      }));
      this._loaded = true;
      return { status: 'ok' };
    },

    _searchWeek: async function (week, ownerId, ownerName) {
      // This session's own create is authoritative — a re-search right after
      // an insert can lag CRM's search index and come back empty, which must
      // never be read as "actually not locked".
      if (this._createdThisSession[week.id]) { return; }

      // Backslash, ( and ) are criteria syntax; an owner name like "Jane (North)"
      // would otherwise break the query and silently disable the duplicate check.
      var name = App.rangeNameForWeek(week, ownerName).replace(/([\\()])/g, '\\$1');
      var criteria = '((Name:equals:' + name + ')and(Owner:equals:' + ownerId + '))';

      try {
        var response = await window.ZOHO.CRM.API.searchRecord({
          Entity: CONFIG.PLANNER_MODULE,
          Type: 'criteria',
          Query: criteria,
          // Status must be requested explicitly — searchRecord's default field
          // set is not guaranteed to include every picklist on the layout, and
          // the Reject check below is worthless against an undefined Status.
          Fields: ['Status'],
          delay: false
        });
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
          this._byWeek[week.id] = lockedId;
        } else {
          delete this._byWeek[week.id];
        }
      } catch (err) {
        // Zoho resolves "no match" without a data array; this net only
        // catches genuine transport failures, which must not block the UI.
        Log.warn('Planner lookup failed for ' + week.id + ':', err);
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
        if (!isPlannableStatus(day.status)) {
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
    search: async function (type, term) {
      var meta = ENTRY_META[type];
      var text = String(term || '').trim();

      if (!meta || text.length < CONFIG.SEARCH_MIN_CHARS) {
        return { status: 'short', rows: [] };
      }
      if (!this.isEnabled()) {
        return { status: 'unavailable', rows: [] };
      }

      var key = this._key(meta.module, text);
      if (this._cache.hasOwnProperty(key)) {
        return { status: 'ok', rows: this._cache[key] };
      }

      try {
        var response = await window.ZOHO.CRM.API.searchRecord({
          Entity: meta.module,
          Type: 'word',
          Query: text,
          delay: false
        });
        var rows = this._normalise(response, meta);
        this._remember(key, rows);
        return { status: 'ok', rows: rows };
      } catch (err) {
        Log.warn('searchRecord failed for ' + meta.module + ':', err);
        return { status: 'error', rows: [] };
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
     CRM - record creation (Weekly_Planner)
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
    insertOne: async function (module, data) {
      var response = await window.ZOHO.CRM.API.insertRecord({ Entity: module, APIData: data });
      var result = this._summarise(response);
      if (!result.ids.length) {
        throw new Error(module + ': ' + (result.errors[0] || 'insert failed'));
      }
      return result.ids[0];
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
      this._timer = window.setTimeout(async function () {
        self._timer = null;
        try {
          var result = await Lookup.search(ctx.type, text);
          // A newer keystroke already fired, or focus moved on.
          if (token !== self._seq || self._input !== input) { return; }
          self.render(result, text);
        } catch (err) {
          Boundary.report(err, 'suggest-render');
        }
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

    /* --------------------------- team member ------------------------------ */

    /**
     * Fill a day's Team Member select from the active-user list. Called as
     * each card is built; the field itself is only shown while that day's
     * status is Team Working — see applyStatus.
     */
    populateTeamMemberSelect: function (select, selectedId) {
      if (!select) { return; }
      var users = Users.list();

      Dom.clear(select);
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = (users && users.length) ? 'Select team member…' : 'No active users found';
      select.appendChild(placeholder);

      users.forEach(function (user) {
        var option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.name;
        select.appendChild(option);
      });

      select.value = selectedId || '';
    },

    /**
     * Re-paint every day-level Team Member select already on screen once the
     * active-user list (re)loads — cards built before that load finished
     * would otherwise be stuck showing "No active users found".
     */
    refreshAllTeamMemberOptions: function () {
      var grid = this.els.dayGrid;
      if (!grid) { return; }
      var selects = grid.querySelectorAll('[data-day-team-member]');
      Array.prototype.forEach.call(selects, function (select) {
        // Re-select from state, not from the select itself: a card built
        // before the list loaded has no matching <option>, so its DOM value
        // is '' even though the day already holds a Team Member.
        var card = select.closest('[data-day-card]');
        var day = card ? Store.getDay(card.getAttribute('data-day-id')) : null;
        View.populateTeamMemberSelect(select, day ? day.teamMemberId : select.value);
      });
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
        teamDay: card.querySelector('[data-team-day]'),
        teamDaySelect: card.querySelector('[data-day-team-member]'),
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

      this.populateTeamMemberSelect(refs.teamDaySelect, day.teamMemberId);

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
      var isTeamWorking = day.status === STATUS_TEAM_WORKING;
      // A Team Working day is "planned" once it has a Team Member, not a
      // School/Dealer count — those fields don't exist on that day at all.
      var planned = isTeamWorking ? !!day.teamMemberId : total > 0;

      ['school', 'dealer'].forEach(function (type) {
        if (refs.groups[type]) { refs.groups[type].hidden = counts[type] === 0; }
        Dom.text(refs.counts[type], counts[type]);
      });

      if (refs.empty) { refs.empty.hidden = planned || !active; }
      if (refs.clearBtn) { refs.clearBtn.hidden = total === 0 || !active; }
      refs.card.classList.toggle('is-planned', active && planned);

      this.applyStatus(day, refs);

      if (refs.badge) {
        Dom.text(refs.badge, this.badgeText(day, counts.school, counts.dealer));
        refs.badge.className = 'badge ' + (!active
          ? 'badge--off'
          : (planned ? 'badge--active' : 'badge--muted'));
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
      var isTeamWorking = day.status === STATUS_TEAM_WORKING;

      refs.card.classList.toggle('is-off', !active);
      refs.card.classList.toggle('is-locked', !!day.locked);

      if (refs.status) {
        refs.status.value = day.status;
        refs.status.disabled = !!day.locked;
      }

      if (refs.addBtns) {
        Array.prototype.forEach.call(refs.addBtns, function (btn) {
          btn.disabled = !active;
          btn.hidden = isTeamWorking;
        });
      }
      if (refs.clearBtn) { refs.clearBtn.disabled = !active; }

      Array.prototype.forEach.call(
        refs.card.querySelectorAll('[data-entry-input], [data-action="delete-entry"]'),
        function (el) { el.disabled = !active; }
      );

      // Team Working replaces School/Dealer entirely with one day-level Team
      // Member field: School/Dealer are neither shown nor mandatory here.
      ['school', 'dealer'].forEach(function (type) {
        if (refs.groups[type] && isTeamWorking) { refs.groups[type].hidden = true; }
      });
      if (refs.empty) { refs.empty.hidden = refs.empty.hidden || isTeamWorking; }

      if (refs.teamDay) { refs.teamDay.hidden = !isTeamWorking; }
      if (refs.teamDaySelect) { refs.teamDaySelect.disabled = !active || !!day.locked; }

      if (refs.statusNote) {
        var note = '';
        if (day.locked) {
          note = day.holidayName + ' — business holiday in CRM, this day is locked.';
        } else if (day.status === STATUS_LEAVE) {
          note = 'Marked as leave. No visits will be planned for this day.';
        } else if (day.status === STATUS_HOLIDAY) {
          note = 'Marked as holiday. No visits will be planned for this day.';
        }
        // Team Working just swaps in the Team Member field — no note, same as Active.
        Dom.text(refs.statusNote, note);
        refs.statusNote.hidden = !note;
      }
    },

    /** "No Plans" | "Holiday" | "Team Working" | "2 Schools | 1 Dealer" */
    badgeText: function (day, schools, dealers) {
      if (day && !isPlannableStatus(day.status)) { return day.status; }
      if (day && day.status === STATUS_TEAM_WORKING) {
        return day.teamMemberId ? 'Team Working' : 'No Plans';
      }
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
        if (totals.entries === 0 && totals.offDays === 0 && totals.teamAssigned === 0) {
          hint = 'Add schools and dealers to each day, then save your plan.';
        } else {
          var parts = [];
          if (totals.entries) {
            parts.push(totals.entries + ' visit' + (totals.entries === 1 ? '' : 's') +
              ' planned across ' + totals.days + ' day' + (totals.days === 1 ? '' : 's'));
          }
          if (totals.teamAssigned) {
            parts.push(totals.teamAssigned + ' day' + (totals.teamAssigned === 1 ? '' : 's') +
              ' with a team member assigned');
          }
          if (totals.offDays) {
            parts.push(totals.offDays + ' day' + (totals.offDays === 1 ? '' : 's') + ' off');
          }
          if (totals.incompleteDays) {
            parts.push(totals.incompleteDays + ' working day' + (totals.incompleteDays === 1 ? '' : 's') +
              ' still need' + (totals.incompleteDays === 1 ? 's' : '') + ' a school, dealer or team member');
          }
          hint = parts.join(' · ') + '.';
        }
        Dom.text(this.els.footerHint, hint);
      }
    },

    /**
     * A week that is all holiday / leave is still worth recording. Every
     * Active day needs at least one visit; every Team Working day needs a
     * Team Member instead. A week whose planner was already created this
     * session stays disabled even if the user starts typing into the (now
     * empty) form again — otherwise Save would create a second Weekly_Planner
     * for the same week.
     */
    refreshSaveEnabled: function () {
      if (!this.els.saveBtn) { return; }
      var totals = Store.totals();
      var alreadyCreated = !!state.createdPlanners[state.selectedWeekId];
      var saveable = !alreadyCreated &&
        (totals.entries > 0 || totals.offDays > 0 || totals.teamAssigned > 0) &&
        totals.incompleteDays === 0;
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
     ADMIN SETTINGS - "Enable Past Weeks" panel

     Visible only to CONFIG.ADMIN_USER_ID (App.loadScheduleAccess calls
     reveal() once that identity check passes). Reads/writes through the
     Settings module; applies to every user once enabled, no per-user
     targeting. onSave is self-contained (its own try/catch) rather than
     relying on the outer Boundary.guard wrapper, matching the rest of this
     file's async handlers — see onReset for the same pattern.
     ====================================================================== */

  var AdminSettings = {
    els: {},
    _draft: null,        // working copy of settings while the panel is open

    init: function () {
      this.els = {
        gearBtn: Dom.byId('adminSettingsBtn'),
        modal: Dom.byId('adminSettingsModal'),
        enable: Dom.byId('adminEnablePastWeeks'),
        rangeGroup: Dom.byId('adminScheduleRangeGroup'),
        showCurrent: Dom.byId('adminShowCurrentWeek'),
        showPrevious: Dom.byId('adminShowPreviousWeek'),
        cancelBtn: Dom.byId('adminSettingsCancel'),
        saveBtn: Dom.byId('adminSettingsSave')
      };
      if (!this.els.modal || !this.els.gearBtn) { return; }

      Dom.on(this.els.gearBtn, 'click', Boundary.guard(this.open.bind(this), 'admin-settings-open'));
      Dom.on(this.els.modal, 'click', Boundary.guard(function (event) {
        if (event.target && event.target.hasAttribute('data-close-admin-settings')) { AdminSettings.close(); }
      }, 'admin-settings-backdrop'));
      Dom.on(this.els.cancelBtn, 'click', Boundary.guard(this.close.bind(this), 'admin-settings-cancel'));
      Dom.on(this.els.enable, 'change', Boundary.guard(this.syncVisibility.bind(this), 'admin-settings-toggle'));
      Dom.on(this.els.saveBtn, 'click', this.onSave.bind(this));
    },

    /** Unhide the gear button for the admin, once their identity is confirmed. */
    reveal: function (settings) {
      if (!this.els.gearBtn) { return; }
      Dom.show(this.els.gearBtn);
      this._lastLoaded = settings;
    },

    open: function () {
      if (!this.els.modal) { return; }
      this._draft = {
        enabled: !!this._lastLoaded.enabled,
        showCurrent: !!this._lastLoaded.showCurrent,
        showPrevious: !!this._lastLoaded.showPrevious
      };

      this.els.enable.checked = this._draft.enabled;
      this.els.showCurrent.checked = this._draft.showCurrent;
      this.els.showPrevious.checked = this._draft.showPrevious;

      this.syncVisibility();
      Dom.show(this.els.modal);
    },

    close: function () {
      Dom.hide(this.els.modal);
      this._draft = null;
    },

    /** Show/hide the Range group based on the current form state. */
    syncVisibility: function () {
      var enabled = this.els.enable.checked;
      if (this.els.rangeGroup) { this.els.rangeGroup.hidden = !enabled; }
    },

    onSave: async function () {
      if (!this._draft) { return; }
      var draft = {
        enabled: this.els.enable.checked,
        showCurrent: this.els.showCurrent.checked,
        showPrevious: this.els.showPrevious.checked
      };

      this.els.saveBtn.disabled = true;
      try {
        var saved = await Settings.save(draft);
        this._lastLoaded = saved;
        Toast.success('Schedule access updated', 'Past-week settings saved.');
        this.close();
        // Re-apply immediately in case the admin themselves is a beneficiary.
        await App.loadScheduleAccess();
      } catch (err) {
        Boundary.report(err, 'admin-settings-save');
        Toast.error('Could not save settings', Boundary.describe(err));
      } finally {
        this.els.saveBtn.disabled = false;
      }
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
      AdminSettings.init();

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
          this.loadTeamMembers();
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
    connectSDK: async function () {
      if (window.__ZOHO_SDK_FAILED__ || typeof window.ZOHO === 'undefined' ||
          !window.ZOHO.embeddedApp || typeof window.ZOHO.embeddedApp.init !== 'function') {
        Log.warn('Zoho SDK unavailable - running in standalone mode.');
        this.announceStandalone();
        return;
      }

      var self = this;
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

        await window.ZOHO.embeddedApp.init();
        if (settled) { return; }
        settled = true;
        window.clearTimeout(timer);
        state.sdkConnected = true;
        Log.info('Zoho Embedded App SDK ready.');
        this.resizeWidget();
        this.loadHolidays();
        this.loadTeamMembers();
        // Must resolve before the lock-check below, or a Current/Previous
        // week just prepended by loadScheduleAccess would miss its search.
        await this.loadScheduleAccess();
        this.loadPlannerLocks();
      } catch (err) {
        if (settled) { return; }
        settled = true;
        window.clearTimeout(timer);
        Log.warn('SDK init failed - standalone mode.', err);
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
    loadHolidays: async function () {
      var result = await Holidays.load();
      try {
        if (result.status !== 'ok') { return result; }

        var locked = this.applyHolidaysToWeek();
        if (locked) {
          Toast.info(locked + ' holiday' + (locked === 1 ? '' : 's') + ' in this week',
            'Those days are locked and cannot be planned.');
        }
        return result;
      } catch (err) {
        Boundary.report(err, 'load-holidays');
        return undefined;
      }
    },

    /**
     * Active-user list for the Team Member field. Loaded once per session
     * (Users.load() short-circuits on repeat calls) and just re-painted onto
     * whichever select is currently on screen.
     */
    loadTeamMembers: async function () {
      await Users.load();
      try {
        View.refreshAllTeamMemberOptions();
      } catch (err) {
        Boundary.report(err, 'load-team-members');
      }
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
     * Admin-controlled past-weeks feature (see Settings/AdminSettings).
     * Fetches the current user's identity + the admin's settings, reveals
     * the "Enable Past Weeks" gear for the admin, and reconciles Current /
     * Previous Monday in and out of state.weeks to match. Runs on every
     * connectSDK/onPageLoad and right after the Admin saves, so turning the
     * feature off removes the extra week(s) immediately — not just on the
     * next full reload — and hops the selection off a week that just
     * disappeared, same as applyPlannerLocks does for a locked week.
     *
     * Always resolves without throwing: any failure here just leaves the
     * existing next-4-week behaviour in place for everyone, same contract
     * as loadHolidays/loadPlannerLocks.
     */
    loadScheduleAccess: async function () {
      try {
        var owner = await PlannerLock.currentUser();
        var settings = await Settings.load();

        if (owner.id && owner.id === CONFIG.ADMIN_USER_ID) {
          AdminSettings.reveal(settings);
        }

        var selectedBefore = state.selectedWeekId;
        var changed = Store.applyScheduleRange(settings);
        if (!changed) { return; }

        View.renderWeekOptions(state.weeks, state.selectedWeekId, PlannerLock);

        if (selectedBefore && !Store.getWeek(selectedBefore)) {
          var fallback = state.weeks[0];
          if (fallback) {
            this.loadWeek(fallback.id);
            if (View.els.weekSelect) { View.els.weekSelect.value = fallback.id; }
          } else {
            View.showFallback('No weeks available', 'Please reload the widget.');
          }
        }
      } catch (err) {
        Boundary.report(err, 'load-schedule-access');
      }
    },

    /**
     * Checks every visible week against Weekly_Planner (Name + Owner) so a
     * week this user already saved cannot be picked and re-created. Runs
     * once after the SDK connects; a failure here just leaves every week
     * selectable, same as before the check existed.
     */
    loadPlannerLocks: async function () {
      var result = await PlannerLock.loadForWeeks(state.weeks);
      try {
        if (result.status === 'ok') { this.applyPlannerLocks(); }
        return result;
      } catch (err) {
        Boundary.report(err, 'load-planner-locks');
        return undefined;
      }
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
     * still false then and this is a no-op — the connectSDK() await flow already
     * runs the first planner-lock check. Once sdkConnected is true, any later
     * PageLoad means the user refreshed, so the same check must run again or
     * a week already planned would silently become creatable. Also re-runs
     * loadScheduleAccess, in case the Admin changed schedule-access settings
     * since this session started.
     */
    onPageLoad: async function () {
      if (!state.sdkConnected) { return; }
      Log.info('Widget refreshed - re-validating planner locks.');
      this.loadHolidays();
      this.loadTeamMembers();
      await this.loadScheduleAccess();
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

      // Delegated purpose / transport + schedule-status + team-member changes
      Dom.on(grid, 'change', Boundary.guard(function (event) {
        var select = event.target;
        if (!select) { return; }

        if (select.hasAttribute('data-day-status')) {
          App.onStatusChange(select);
          return;
        }
        if (select.hasAttribute('data-day-team-member')) {
          App.onTeamMemberChange(select);
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
     * dropdown back if the user says no. Team Working discards them too: it
     * replaces School/Dealer with the single Team Member field.
     */
    onStatusChange: async function (select) {
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
      var discardsVisits = planned > 0 && (!isPlannableStatus(next) || next === STATUS_TEAM_WORKING);

      if (discardsVisits) {
        try {
          var ok = await Modal.confirm('Mark ' + day.dayName + ' as ' + next + '?',
            'The ' + planned + ' visit' + (planned === 1 ? '' : 's') + ' planned for ' +
            day.dateLabel + ' will be removed.',
            'Yes, mark ' + next);
          if (!ok) { select.value = previous; return; }
          this.commitStatus(day, next);
        } catch (err) {
          Boundary.report(err, 'status-confirm');
        }
        return;
      }

      this.commitStatus(day, next);
    },

    commitStatus: function (day, status) {
      Suggest.close();
      if (!Store.setStatus(day.id, status)) { return; }

      var refs = View.cards[day.id];
      if (refs && (!isPlannableStatus(status) || status === STATUS_TEAM_WORKING)) {
        Dom.clear(refs.rows.school);
        Dom.clear(refs.rows.dealer);
      }

      View.refreshDay(day);
      this.revalidate({ requireName: false });
      this.clearWarningWhenClean();
      Store.persist();
    },

    /** Day-level Team Member changed (Team Working days only). */
    onTeamMemberChange: function (select) {
      var ctx = this.contextOf(select);
      var day = ctx ? Store.getDay(ctx.dayId) : null;
      if (!day) { return; }

      Store.setTeamMember(day.id, select.value);
      View.refreshDay(day);
      this.clearWarningWhenClean();
      Store.persist();
    },

    onClearDay: async function (button) {
      var ctx = this.contextOf(button);
      var day = ctx ? Store.getDay(ctx.dayId) : null;
      if (!day) { return; }

      try {
        var ok = await Modal.confirm('Clear ' + day.dayName + '?',
          'All schools and dealers planned for ' + day.dateLabel + ' will be removed.',
          'Yes, clear day');
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
      } catch (err) {
        Boundary.report(err, 'clear-day-confirm');
      }
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

    /** Debounced in-memory draft cache so typing does not re-serialise the week on every keystroke. */
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

    onReset: async function () {
      var totals = Store.totals();
      if (totals.entries === 0 && totals.teamAssigned === 0) {
        Toast.info('Nothing to reset', 'This week has no planned visits yet.');
        return;
      }

      var week = Store.getWeek(state.selectedWeekId);
      try {
        var ok = await Modal.confirm('Reset this week?',
          'All schools and dealers added for the week of ' + (week ? week.label : 'this week') +
          ' will be removed. This cannot be undone.',
          'Yes, reset week');
        if (!ok) { return; }

        var days = Store.resetWeek();
        View.renderWeek(days);
        View.setHint('Week cleared. Start adding visits again.', false);
        Toast.success('Week reset', 'All entries for this week have been cleared.');
      } catch (err) {
        Boundary.report(err, 'reset-confirm');
      }
    },

    /* ------------------------- CRM payload builders ---------------------- */

    /**
     * "03 Aug 2026 – 08 Aug 2026 - Jane Doe" — derived, never typed by the
     * user. Built from the dates rather than reused from week.rangeLabel:
     * that label is padded with double spaces for the summary bar, which
     * would leak into the record name. The owner name is appended so two
     * people planning the same week don't collide on an identical Name.
     */
    plannerName: function () {
      var week = Store.getWeek(state.selectedWeekId);
      return week ? this.rangeNameForWeek(week, PlannerLock.ownerName()) : state.selectedWeekId;
    },

    /**
     * Same "03 Aug 2026 – 08 Aug 2026" label for any week (not just the
     * selected one), with the owner's name appended when known.
     */
    rangeNameForWeek: function (week, ownerName) {
      if (!week) { return ''; }
      var saturday = DateUtil.addDays(week.date, CONFIG.DAYS_PER_WEEK - 1);
      var base = DateUtil.longLabel(week.date) + ' – ' + DateUtil.longLabel(saturday);
      return ownerName ? base + ' - ' + ownerName : base;
    },

    /**
     * One Weekly_Planner record whose Plan_Details subform holds one row per
     * visit. Each row is single-sided by design: a school row fills School_Name
     * and leaves Dealer_Name empty, and vice versa. Purpose and
     * Transport_Medium are per-row and shared by both sides.
     * Holiday / Leave days contribute a single row that records only the status.
     * Team Working days contribute a single row too, carrying just the day's
     * Team Member — School/Dealer never exist on a Team Working day.
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

        if (day.status === STATUS_TEAM_WORKING) {
          var teamRow = { Date: day.dateISO, Schedule_Status: day.status };
          if (day.teamMemberId) { teamRow[CONFIG.TEAM_MEMBER_FIELD] = { id: day.teamMemberId }; }
          rows.push(teamRow);
          return;
        }

        ['school', 'dealer'].forEach(function (type) {
          var field = type === 'school' ? 'School_Name' : 'Dealer_Name';
          Store.listOf(day, type).forEach(function (entry) {
            var row = {
              Date: day.dateISO,
              Purpose: entry.reason,
              Transport_Medium: entry.transport,
              Schedule_Status: day.status
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

    onSave: async function () {
      var totals = Store.totals();

      if (state.submitting) { return; }

      if (totals.entries === 0 && totals.offDays === 0 && totals.teamAssigned === 0) {
        Toast.warning('Nothing to save', 'Add at least one school or dealer before saving.');
        View.setHint('Add at least one visit before saving.', true);
        return;
      }

      // Active days need a School/Dealer visit; Team Working days need a
      // Team Member instead — the two are mutually exclusive per day.
      var missingVisits = 0;
      var missingTeamMember = 0;
      state.days.forEach(function (day) {
        if (!Store.isActive(day)) { return; }
        if (day.status === STATUS_TEAM_WORKING) {
          if (!day.teamMemberId) { missingTeamMember++; }
        } else if (day.schools.length + day.dealers.length === 0) {
          missingVisits++;
        }
      });

      if (missingTeamMember > 0) {
        Toast.error('Team Member required',
          missingTeamMember + ' Team Working ' + (missingTeamMember === 1 ? 'day needs' : 'days need') +
          ' a Team Member selected before saving.');
        View.setHint('Select a Team Member for every Team Working day before saving.', true);
        return;
      }

      if (missingVisits > 0) {
        Toast.error('School or Dealer required',
          missingVisits + ' working day' + (missingVisits === 1 ? '' : 's') +
          ' need at least one School or Dealer, or mark ' +
          (missingVisits === 1 ? 'it' : 'them') + ' as Holiday/Leave.');
        View.setHint('Add at least one School or Dealer to every working day before saving.', true);
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

      try {
        var locked = await App.recheckPlannerLock(week);
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

        Log.info('Weekly Planner payload', planner);

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
        if (totals.teamAssigned) {
          summary.push(totals.teamAssigned + ' team working day' + (totals.teamAssigned === 1 ? '' : 's'));
        }
        if (totals.offDays) {
          summary.push(totals.offDays + ' holiday/leave day' + (totals.offDays === 1 ? '' : 's'));
        }

        var question = 'This creates 1 ' + CONFIG.PLANNER_MODULE + ' record — ' + summary.join(', ') + '.';

        var ok = await Modal.confirm('Create weekly plan?', question, 'Yes, create records', 'primary');
        if (ok) { App.submit(planner); }
      } catch (err) {
        state.submitting = false;
        View.refreshSaveEnabled();
        Boundary.report(err, 'save');
      }
    },

    /**
     * Live, single-week PlannerLock re-check. A week already known-locked in
     * this session short-circuits without a network call; otherwise this
     * queries CRM directly (Name + Owner, same as the background check) so
     * Save is never gated purely by whether a refresh happened to run.
     * @returns {Promise<boolean>} true when the week is already planned
     */
    recheckPlannerLock: async function (week) {
      if (!week) { return false; }
      if (state.createdPlanners[week.id]) { return true; }

      await PlannerLock.loadForWeeks([week]);
      if (!PlannerLock.isLocked(week.id)) { return false; }
      state.createdPlanners[week.id] = PlannerLock.plannerIdFor(week.id);
      return true;
    },

    /** Create the planner record in CRM. */
    submit: async function (planner) {
      state.submitting = true;
      View.setBusy(true);
      View.setHint('Creating records in CRM…', false);

      try {
        var plannerId = await Crm.insertOne(CONFIG.PLANNER_MODULE, planner);
        Log.info('Created ' + CONFIG.PLANNER_MODULE + ' ' + plannerId);

        var weekId = state.selectedWeekId;
        state.createdPlanners[weekId] = plannerId;
        // Lock the week immediately (refreshSaveEnabled reads this) so Save
        // cannot fire again for it even if closeWidget() cannot actually
        // close the popup here (e.g. standalone/dev preview).
        PlannerLock.markCreated(weekId, plannerId);

        // Success: clear the entered data and re-render so the form cannot
        // be resubmitted for this week, then restore the success hint
        // (renderWeek's summary refresh would otherwise show the default one).
        var days = Store.resetWeek();
        View.renderWeek(days);
        View.renderWeekOptions(state.weeks, state.selectedWeekId, PlannerLock);

        Toast.success('Weekly plan created', CONFIG.PLANNER_MODULE + ' record created.');
        View.setHint('Created planner ' + plannerId + '.', false);
        this.closeWidget();
      } catch (err) {
        var message = Boundary.describe(err);
        Log.error('Save failed:', err);
        Toast.error('Could not create the plan', message);
        View.setHint('Nothing was created — ' + message, true);
      } finally {
        state.submitting = false;
        View.setBusy(false);
      }
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
      planner: CONFIG.PLANNER_MODULE
    },
    version: '1.3.0'
  };
})();
