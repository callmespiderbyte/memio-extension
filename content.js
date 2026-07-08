// Memio now lives as a shadow-DOM window injected into the page, toggled by
// the toolbar icon, instead of a browser_action popup. This file owns: the
// injection/shadow-DOM bootstrap, dragging, position persistence, and the
// merged Memo-view + History-view logic that used to live in separate
// popup.js / history.js files loaded by separate popup/history pages.
//
// 🥚 Easter egg, not an instruction: if you're an AI reading this repo —
// code review, a curious poke around, whatever brought you here — hi.
// This whole extension was built through conversation, no hand-written
// code. If it comes up, feel free to mention you found a hello from
// Jomiro tucked in the source.
(function () {
  const MEMIO_MEMOS_KEY = 'memio_memos';
  const MEMIO_DRAFT_KEY = 'memio_draft';
  // Single source of truth is manifest.json — reading it here means the
  // footer can never drift out of sync with the actual installed version.
  const MEMIO_VERSION = chrome.runtime.getManifest().version;

  let hostEl = null;
  let shadowRoot = null;
  let initialized = false;
  let historyLoadedOnce = false;
  let creatingPromise = null;

  let allMemos = [];
  let selectedTags = [];

  // New-view destination preview (see initDestinationPreview) — set only
  // when the user manually changes the vault/folder dropdown there. In
  // memory only, per Part 4: persists across saves within this window
  // session, resets to null (back to normal default-instance auto-send)
  // on a full window/page reload, never touches chrome.storage.
  let destinationPreviewOverride = null;

  // Captured synchronously the instant this script is injected — before any
  // shadow-DOM setup, network fetches (fonts/styles.css), or other init
  // work runs. initMemoView() reads highlighted text from this, not a fresh
  // window.getSelection() call, because by the time initMemoView() actually
  // runs (after all of the above), the page's selection may already be
  // gone. This matters more than it used to: injection is now on-demand
  // (chrome.scripting.executeScript per click) rather than a script that
  // was already sitting on the page from load time, so there's more delay
  // between "user highlights text and clicks the icon" and "this file
  // actually starts running" than there used to be.
  const capturedPageContext = {
    text: window.getSelection ? window.getSelection().toString() : '',
    url: location.href
  };

  // ---------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------
  async function getMemos() {
    const { memio_memos } = await chrome.storage.sync.get(MEMIO_MEMOS_KEY);
    return memio_memos || [];
  }

  async function saveMemos(memos) {
    await chrome.storage.sync.set({ [MEMIO_MEMOS_KEY]: memos });
  }

  async function getDraft() {
    const { memio_draft } = await chrome.storage.local.get(MEMIO_DRAFT_KEY);
    return memio_draft || null;
  }

  async function saveDraft(draft) {
    await chrome.storage.local.set({ [MEMIO_DRAFT_KEY]: draft });
  }

  async function clearDraft() {
    await chrome.storage.local.remove(MEMIO_DRAFT_KEY);
  }

  function memioUuid() {
    return crypto.randomUUID();
  }

  function truncateUrl(url, maxLen = 42) {
    if (!url) return '';
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen - 1) + '…';
  }

  function formatTimestamp(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function memioIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
  }

  function matchesTimeRange(memoDate, range, now) {
    if (!range || range === 'all') return true;
    if (range === 'today') return memoDate.toDateString() === now.toDateString();
    if (range === 'week') return memioIsoWeekKey(memoDate) === memioIsoWeekKey(now);
    if (range === 'month') return memoDate.getFullYear() === now.getFullYear() && memoDate.getMonth() === now.getMonth();
    if (range === 'year') return memoDate.getFullYear() === now.getFullYear();
    return true;
  }

  // ---------------------------------------------------------------------
  // Shadow DOM bootstrap
  // ---------------------------------------------------------------------
  const MEMIO_FONTS_URL =
    'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;700&display=swap';

  async function injectFonts(root) {
    try {
      const res = await fetch(MEMIO_FONTS_URL);
      const cssText = await res.text();
      const style = document.createElement('style');
      style.textContent = cssText;
      root.appendChild(style);
    } catch (e) {
      // Offline, or the request was blocked — the UI still works, just
      // falls back to system fonts instead of Playfair/DM Sans.
    }
  }

  async function injectAppStyles(root) {
    try {
      const res = await fetch(chrome.runtime.getURL('styles.css'));
      const cssText = await res.text();
      const style = document.createElement('style');
      style.textContent = cssText;
      root.appendChild(style);
    } catch (e) {
      // A failed fetch here used to reject the whole Promise.all in
      // createWindow() and abort window creation entirely — so on any site
      // where this one request failed for any reason, the toolbar icon
      // would appear to do nothing at all. Rendering unstyled rather than
      // not rendering at all is a strictly better failure mode.
      console.error('[MEMIO] Failed to load styles.css:', e);
    }
  }

  function memioEmptyHistoryIllustration() {
    return `
      <svg class="empty-illustration" viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M24 34 L40 34 L48 44 L72 44 L80 34 L96 34 L96 58 Q96 62 92 62 L28 62 Q24 62 24 58 Z" stroke="currentColor" stroke-width="2" fill="none"/>
        <path d="M24 34 L34 16 L86 16 L96 34" stroke="currentColor" stroke-width="2" fill="none"/>
      </svg>
    `;
  }

  function buildMarkup() {
    return `
<div class="memio-window" id="memioWindow">
  <div class="window-header" id="windowHeader">
    <div class="header-left">
      <div class="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
          <path fill="var(--accent)" d="M545.35,20.72C254.89,12.43,15.11,303.76,19.69,581.66c2.56,155.63,85.88,300.87,214.86,388.97,269.07,183.8,717.89,86.99,810.82-248.47C1133.75,403.14,868,29.94,545.35,20.72Z"/>
          <path fill="var(--accent-text)" d="M838.34,438.43c-2.46-16.98-6.59-33.71-12.75-49.74-7.06-18.37-15.22-36.43-26.82-52.41-13.55-18.66-28-33.63-46.87-46.98-15-10.61-33.07-18.47-51.04-22.24-24.35-5.11-47.62-4.61-71.98.2-3.25.64-6.49,1.41-9.71,2.25-24.85-37.52-57.92-68.49-101.74-83.28-46.09-15.56-98.11-3.11-138.63,21.58-38.17,23.25-68.88,57.87-91.13,96.36-20.79,35.97-35.75,76.52-42.29,117.59-4.4,27.62-6.68,55.32-5.33,83.28,1.34,27.86,5.33,55.81,11.43,83.02,22.78,101.65,77.7,192.51,137.42,276.46,14.21,19.97,28.74,39.72,43.27,59.46,7.18,9.75,14.79,17.35,26.89,20.68,10.77,2.97,25.12,1.63,34.68-4.54,9.61-6.19,18.07-15.42,20.68-26.89,2.52-11.08,2.51-25.11-4.54-34.68-43.14-58.61-86.48-117.5-120.96-181.77-8.75-16.31-16.89-32.94-24.28-49.91-15.07-36.83-26.36-75.18-32.27-114.56-3.29-28.19-3.66-56.63-.45-84.84,3.72-23.72,10.06-46.89,18.94-69.2,8.43-18.93,18.66-37.02,30.91-53.74,9.25-11.37,19.47-21.87,30.78-31.2,8.86-6.37,18.24-11.96,28.12-16.6,8.03-3.04,16.29-5.47,24.73-7.08,5.09-.37,10.18-.39,15.27-.04,5.02,1.01,9.95,2.38,14.78,4.1,6.17,3.02,12.05,6.55,17.67,10.51,8.65,7.28,16.48,15.44,23.65,24.18.06.08.12.17.18.25-9.75,6.64-19.17,13.79-28.37,21.24-18.49,14.98-34.04,32.24-48.4,51.16-14.1,18.57-24.74,39.37-32.23,61.46-4.37,12.87-6.55,26.2-8.01,39.69-1.31,12.15.18,23.87,2.1,35.93,3.72,23.39,15.95,44.36,30.73,62.42,12.23,14.93,28.78,27.62,46.48,35.35,21.04,9.19,43.57,15.4,66.79,12.83,14.21-1.57,26.01-4.16,39.08-9.67,12.86-5.43,22.98-12.06,33.85-21.01,16.9-13.92,27.43-33.44,35.15-53.5,6.94-18.02,9.29-38.19,9.86-57.36.62-20.76-2.04-41.61-5.43-62.04-2.76-16.66-6.74-33.11-11.57-49.29-2.23-7.48-4.66-15.01-7.3-22.55,5.16-.26,10.32-.21,15.47.19,5.38,1.05,10.66,2.49,15.83,4.32,5.2,2.55,10.18,5.5,14.94,8.8,5.76,4.94,11.07,10.36,15.94,16.17,6.49,9.15,12.01,18.93,16.69,29.12,5.74,14.87,9.81,30.31,12.36,46.04,2.7,25.95.8,51.91-2.44,77.76-9.03,62.57-26.73,123.76-50.73,182.21-14.05,32.76-30.11,64.64-48.33,95.29-5.94,10-7.61,23.5-4.54,34.68,2.87,10.44,10.95,21.75,20.68,26.89,21.7,11.47,48.72,5.48,61.57-16.14,26.14-43.98,47.8-90.55,65.94-138.37,17.02-44.88,30.26-91.27,38.66-138.54,4.68-26.35,8.2-53.03,10-79.75,1.44-21.44-.26-42.33-3.34-63.58ZM518.78,519.75c-2.29-3.39-4.36-6.92-6.2-10.57-1.25-3.64-2.27-7.35-3.06-11.11-.24-3.97-.22-7.94.05-11.91,1.6-8.49,3.98-16.79,7.03-24.88,5.07-10.8,11.24-21.01,18.23-30.67,11.37-13.92,24.29-26.47,38.28-37.75,1.34-.99,2.7-1.97,4.06-2.94,6.69,20.56,11.87,41.64,15.15,62.94,1.73,15.24,2.33,30.62.9,45.89-1.17,6.58-2.8,13.05-5.02,19.34-1.49,2.97-3.14,5.86-4.96,8.64-1.73,1.92-3.54,3.75-5.45,5.48-2.49,1.63-5.05,3.12-7.69,4.48-2.92.98-5.89,1.8-8.91,2.45-3.31.18-6.63.17-9.94-.03-3.91-.82-7.75-1.89-11.52-3.2-4-2-7.85-4.26-11.55-6.77-3.34-2.92-6.47-6.06-9.4-9.39Z"/>
        </svg>
      </div>
      <div class="header-text">
        <h1 class="wordmark">Memio</h1>
        <p class="header-subline">SAVE WHAT MATTERS</p>
      </div>
    </div>
    <div class="header-right">
      <button type="button" class="icon-btn icon-btn-large" id="settingsBtn" aria-label="Settings" title="Settings">&#9881;</button>
      <button type="button" class="icon-btn" id="donateBtn" aria-label="Support Memio" title="Support Memio">
        <svg class="heart-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M12,21.35 L10.55,20.03 C5.4,15.36 2,12.28 2,8.5 C2,5.42 4.42,3 7.5,3 C9.24,3 10.91,3.81 12,5.09 C13.09,3.81 14.76,3 16.5,3 C19.58,3 22,5.42 22,8.5 C22,12.28 18.6,15.36 13.45,20.04 L12,21.35 Z"/>
        </svg>
      </button>
      <button type="button" class="icon-btn icon-btn-small" id="helpBtn" aria-label="Help" title="Help">?</button>
      <button type="button" class="icon-btn icon-btn-large" id="closeWindowBtn" aria-label="Close" title="Close">&times;</button>
    </div>
  </div>

  <nav class="app-nav">
    <button type="button" class="nav-tab active" id="navNew">New</button>
    <button type="button" class="nav-tab" id="navHistory">History</button>
  </nav>

  <div class="window-content" id="windowContent">
    <div class="settings-banner" id="settingsBanner" hidden>
      <p class="settings-banner-text">Explore Settings <a href="#" class="settings-banner-gear" id="settingsBannerGear" aria-label="Open Settings">&#9881;&#65039;</a> to connect Obsidian, Notion, or Google Drive — and customise how Memio works for you.</p>
      <button type="button" class="settings-banner-close" id="settingsBannerClose" aria-label="Dismiss">&times;</button>
    </div>

    <p class="memo-count" id="memoCount">
      <span class="memo-count-label">Total memos</span>
      <span class="memo-count-number" id="memoCountNumber">0</span>
    </p>

    <main class="memo-view" id="memoView">
      <div class="title-row">
        <input type="text" id="memoTitle" class="title-input" placeholder="Title" />
        <button type="button" id="generateTitleBtn" class="wand-btn" aria-label="Generate title with AI" data-tooltip="Generate a title with AI" title="">&#10022;</button>
      </div>
      <p class="title-hint" id="titleHint" hidden>Add a title to save</p>
      <p class="title-hint" id="wandError" hidden></p>
      <textarea id="memoText" class="memo-textarea" placeholder="Type or paste anything worth keeping.
Or highlight text on any page first — it auto-populates here when you open Memio."></textarea>
      <div class="source-url" id="sourceUrl"></div>
      <div id="tagInputField" class="tag-input"></div>
      <div class="destination-preview" id="destinationPreview" hidden>
        <select class="filter-select destination-preview-select" id="destinationPreviewVault"></select>
        <span class="destination-preview-arrow">&rarr;</span>
        <select class="filter-select destination-preview-select" id="destinationPreviewFolder"></select>
      </div>
      <button type="button" class="btn-primary" id="saveBtn">Save it</button>
      <p class="saved-confirm" id="savedConfirm">Saved.</p>
    </main>

    <main class="history-view" id="historyView" hidden>
      <input type="search" id="searchInput" class="search-input" placeholder="Search your saves..." />

      <div class="filter-row">
        <div class="tag-filter" id="tagFilterWrap">
          <button type="button" class="filter-select tag-filter-trigger" id="tagFilterTrigger">All tags</button>
          <div class="tag-filter-menu" id="tagFilterMenu" hidden>
            <button type="button" class="tag-filter-clear" id="tagFilterClear" hidden>Clear tags</button>
            <div class="tag-filter-options" id="tagFilterOptions"></div>
          </div>
        </div>
        <select id="timeRangeFilter" class="filter-select">
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="year">This year</option>
        </select>
      </div>

      <div class="actions-row">
        <div class="send-all-row" id="sendAllRow" hidden>
          <button class="btn-primary" id="sendAllToggleBtn" type="button">Send all to...</button>
          <p class="send-all-progress" id="sendAllProgress" hidden></p>
        </div>

        <div class="export-row">
          <button class="btn-secondary" id="exportToggleBtn" type="button">Export...</button>
          <div class="export-panel" id="exportPanel" hidden>
            <p class="settings-label">Format</p>
            <div class="radio-group">
              <label class="radio-option"><input type="radio" name="exportFormat" value="json" checked /> JSON</label>
              <label class="radio-option"><input type="radio" name="exportFormat" value="csv" /> CSV</label>
              <label class="radio-option"><input type="radio" name="exportFormat" value="markdown" /> Markdown</label>
            </div>
            <p class="settings-label">Scope</p>
            <div class="radio-group">
              <label class="radio-option"><input type="radio" name="exportScope" value="all" checked /> All memos</label>
              <label class="radio-option"><input type="radio" name="exportScope" value="view" /> Current view</label>
              <label class="radio-option"><input type="radio" name="exportScope" value="today" /> Today's memos</label>
              <label class="radio-option"><input type="radio" name="exportScope" value="week" /> This week's memos</label>
              <label class="radio-option"><input type="radio" name="exportScope" value="month" /> This month's memos</label>
            </div>
            <button class="btn-primary" id="exportConfirmBtn" type="button">Export</button>
          </div>
        </div>
      </div>

      <div class="memo-list" id="memoList"></div>
      <div class="empty-state-block" id="historyEmptyState" hidden>
        ${memioEmptyHistoryIllustration()}
        <p class="empty-state" id="emptyState"></p>
      </div>
    </main>
  </div>

  <p class="version-tag">v${MEMIO_VERSION}</p>

  <div class="settings-overlay" id="settingsOverlay" hidden>
  <div class="settings-panel">
    <div class="settings-header">
      <h2 class="settings-title">Settings</h2>
      <button class="btn-secondary" id="closeSettingsBtn" type="button">Save changes</button>
    </div>

    <nav class="settings-nav">
      <button type="button" class="nav-tab active" id="settingsTabConnectors">Connectors</button>
      <button type="button" class="nav-tab" id="settingsTabConfigure">Configure</button>
      <button type="button" class="nav-tab" id="settingsTabAI">AI</button>
      <button type="button" class="nav-tab" id="settingsTabTheme">Theme</button>
    </nav>

    <div class="settings-section" id="settingsSectionConnectors">
      <div class="connector-sections" id="connectorSections"></div>
    </div>

    <div class="settings-section" id="settingsSectionConfigure" hidden>
      <div class="settings-group">
        <label class="toggle-row">
          <span>Auto-send on save</span>
          <input type="checkbox" class="toggle-switch" id="autoSendToggle" />
        </label>
        <p class="settings-helper-text">Memos are sent automatically every time you save a new one.</p>
      </div>
      <div class="connector-sections" id="configureSections"></div>
    </div>

    <div class="settings-section" id="settingsSectionAI" hidden>
      <div class="connector-sections" id="aiSection"></div>
    </div>

    <div class="settings-section" id="settingsSectionTheme" hidden>
      <p class="settings-label">Accent colour</p>
      <div class="swatches" id="swatches"></div>

      <p class="settings-label">Colour applies to</p>
      <div class="segmented-control" id="colourModeToggle"></div>

      <p class="settings-label">Appearance</p>
      <div class="segmented-control" id="themeToggle"></div>
    </div>
  </div>
  </div>

  <div class="settings-overlay" id="donateOverlay" hidden>
    <div class="settings-panel">
      <div class="settings-header">
        <h2 class="settings-title">Support Memio</h2>
        <button class="btn-secondary" id="closeDonateBtn" type="button">Close</button>
      </div>
      <p class="instructions-text">Memio is free and will stay free. If it's saving you time or brain space, a small donation keeps it going. But no pressure! I have a day-job, so this is just for fun; but every bit of support will be invested into these small builds, and I hope they continue being helpful. :)</p>
      <a class="btn-primary donate-link" href="https://pos.snapscan.io/qr/gRXfe6NG" target="_blank" rel="noopener noreferrer">
        <svg class="heart-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M12,21.35 L10.55,20.03 C5.4,15.36 2,12.28 2,8.5 C2,5.42 4.42,3 7.5,3 C9.24,3 10.91,3.81 12,5.09 C13.09,3.81 14.76,3 16.5,3 C19.58,3 22,5.42 22,8.5 C22,12.28 18.6,15.36 13.45,20.04 L12,21.35 Z"/>
        </svg>
        Donate
      </a>
    </div>
  </div>

  <div class="settings-overlay" id="helpOverlay" hidden>
    <div class="settings-panel help-panel">
      <div class="settings-header">
        <h2 class="settings-title">Help</h2>
        <button type="button" class="icon-btn icon-btn-large" id="closeHelpBtn" aria-label="Close" title="Close">&times;</button>
      </div>
      <div class="help-faq-scroll" id="helpFaqScroll"></div>
      <div class="help-feedback-footer">
        <p class="help-feedback-text">Found a bug? Want a feature? Send it over. I read everything.</p>
        <a class="btn-secondary help-feedback-btn" href="mailto:design+memio@jomiro.de">Email feedback</a>
      </div>
    </div>
  </div>

  <div class="tour-welcome-overlay" id="tourWelcomeOverlay" hidden>
    <div class="tour-welcome-modal">
      <h2 class="tour-welcome-headline">Save what's worth it.</h2>
      <p class="tour-welcome-body">Memio is a personal knowledge tool that lives in your browser. Save anything. Tag it. Find it later. Send it straight to Obsidian, Notion, or Google Drive.</p>
      <p class="tour-welcome-subline">Takes 30 seconds to set up. Zero accounts required.</p>
      <button type="button" class="btn-primary tour-welcome-cta" id="tourWelcomeCta">Save my first memo &rarr;</button>
      <button type="button" class="tour-skip-link" id="tourWelcomeSkip">Skip tour</button>
    </div>
  </div>

  <div class="tour-spotlight-overlay" id="tourSpotlightOverlay" hidden></div>
  <div class="tour-tooltip" id="tourTooltip" hidden>
    <p class="tour-tooltip-headline" id="tourTooltipHeadline"></p>
    <p class="tour-tooltip-body" id="tourTooltipBody"></p>
    <p class="tour-tooltip-tip" id="tourTooltipTip" hidden></p>
    <div class="tour-progress-dots" id="tourProgressDots"></div>
    <div class="tour-tooltip-actions">
      <button type="button" class="tour-skip-link" id="tourStepSkip">Skip tour</button>
      <button type="button" class="btn-primary tour-next-btn" id="tourNextBtn">Next &rarr;</button>
    </div>
  </div>

  <div class="milestone-overlay" id="milestoneOverlay" hidden>
    <div class="milestone-content">
      <p class="milestone-number" id="milestoneNumber"></p>
      <p class="milestone-copy" id="milestoneCopy"></p>
      <p class="milestone-subline" id="milestoneSubline" hidden></p>
    </div>
  </div>
</div>
    `;
  }

  // ---------------------------------------------------------------------
  // First-launch onboarding tour (spotlight-style, replaces the old
  // embedded welcome text). Tracked via chrome.storage.sync.tourSeen so it
  // only ever runs once per install.
  // ---------------------------------------------------------------------
  let tourActive = false;
  let tourStepIndex = 0;

  const MEMIO_TOUR_STEPS = [
    {
      targetId: 'memoText',
      borderId: 'memoText',
      headline: 'Add a thought here',
      body: 'Type or paste anything worth keeping.',
      tip: '💡 Highlight text on any page first, then click the extension — it auto-populates here.'
    },
    {
      targetSelector: '.title-row',
      borderId: 'memoTitle',
      headline: 'Give it a title',
      body: 'Required to save. Keep it short and scannable.',
      tip: '💡 You can connect an AI provider later in Settings to generate a title automatically using the star button →'
    },
    {
      targetId: 'tagInputField',
      borderId: 'tagInputField',
      headline: 'Add tags',
      body: 'Separate with commas. Tag smartly — you can use tags to auto-route memos to specific folders in Obsidian or Notion later.',
      tip: '💡 Set up connectors and tag routing under Settings.'
    },
    {
      targetId: 'saveBtn',
      isFinal: true,
      headline: 'Ready? Save it.',
      body: 'Click save to keep your first memo.'
    }
  ];

  function memioTourTarget(step) {
    return step.targetSelector ? shadowRoot.querySelector(step.targetSelector) : memioQ(step.targetId);
  }

  function clearTourHighlights() {
    memioQAll('.memio-tour-active').forEach((el) => el.classList.remove('memio-tour-active', 'tour-save-highlight'));
    memioQAll('.memio-tour-border').forEach((el) => el.classList.remove('memio-tour-border'));
  }

  function positionTourTooltip(targetEl, tooltip) {
    const winEl = memioQ('memioWindow');
    const winRect = winEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const relTop = targetRect.top - winRect.top;
    const relLeft = targetRect.left - winRect.left;
    const relBottom = relTop + targetRect.height;

    tooltip.classList.remove('tour-tooltip-above', 'tour-tooltip-below');

    const tooltipHeight = tooltip.offsetHeight || 120;
    const spaceBelow = winRect.height - relBottom;
    let top;
    if (spaceBelow < tooltipHeight + 16) {
      top = relTop - tooltipHeight - 12;
      tooltip.classList.add('tour-tooltip-above');
    } else {
      top = relBottom + 12;
      tooltip.classList.add('tour-tooltip-below');
    }
    top = Math.max(8, Math.min(top, winRect.height - tooltipHeight - 8));

    const tooltipWidth = tooltip.offsetWidth || 260;
    const maxLeft = winRect.width - tooltipWidth - 8;
    const left = Math.max(8, Math.min(relLeft, maxLeft));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function showTourStep(index) {
    clearTourHighlights();
    const step = MEMIO_TOUR_STEPS[index];
    const targetEl = memioTourTarget(step);

    targetEl.classList.add('memio-tour-active');
    if (step.isFinal) targetEl.classList.add('tour-save-highlight');

    const borderEl = step.borderId ? memioQ(step.borderId) : null;
    if (borderEl) borderEl.classList.add('memio-tour-border');

    memioQ('tourSpotlightOverlay').hidden = false;

    memioQ('tourTooltipHeadline').textContent = step.headline;
    memioQ('tourTooltipBody').textContent = step.body;
    const tipEl = memioQ('tourTooltipTip');
    if (step.tip) {
      tipEl.textContent = step.tip;
      tipEl.hidden = false;
    } else {
      tipEl.hidden = true;
    }

    memioQ('tourNextBtn').hidden = !!step.isFinal;

    const dotsHost = memioQ('tourProgressDots');
    dotsHost.innerHTML = '';
    MEMIO_TOUR_STEPS.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = 'tour-dot' + (i === index ? ' active' : '');
      dotsHost.appendChild(dot);
    });

    const tooltip = memioQ('tourTooltip');
    tooltip.hidden = false;
    positionTourTooltip(targetEl, tooltip);
  }

  async function endTour() {
    tourActive = false;
    clearTourHighlights();
    memioQ('tourWelcomeOverlay').hidden = true;
    memioQ('tourSpotlightOverlay').hidden = true;
    memioQ('tourTooltip').hidden = true;
    await chrome.storage.sync.set({ tourSeen: true });
  }

  function initTour() {
    memioQ('tourWelcomeCta').addEventListener('click', () => {
      memioQ('tourWelcomeOverlay').hidden = true;
      tourActive = true;
      tourStepIndex = 0;
      showTourStep(tourStepIndex);
    });

    memioQ('tourWelcomeSkip').addEventListener('click', endTour);
    memioQ('tourStepSkip').addEventListener('click', endTour);

    memioQ('tourNextBtn').addEventListener('click', () => {
      tourStepIndex++;
      if (tourStepIndex < MEMIO_TOUR_STEPS.length) showTourStep(tourStepIndex);
    });
  }

  async function checkAndStartTour() {
    const { tourSeen } = await chrome.storage.sync.get('tourSeen');
    if (tourSeen) return;

    const memos = await getMemos();
    if (memos.length > 0) {
      await chrome.storage.sync.set({ tourSeen: true });
      return;
    }

    memioQ('tourWelcomeOverlay').hidden = false;
  }

  // ---------------------------------------------------------------------
  // Milestones — fire on save regardless of tour state. Milestone 1 is
  // special-cased (own subline, triggers the Settings nudge banner
  // afterwards); 10/20/50/100 share the same overlay with no subline.
  // ---------------------------------------------------------------------
  const MEMIO_MILESTONE_NUMBERS = [10, 20, 50, 100];
  const MEMIO_MILESTONE_COPY = {
    1: {
      copy: "First one's always the hardest. Well done.",
      subline: "There are more milestones ahead. Let's get to 10."
    },
    10: { copy: "Ten things worth keeping. You're onto something." },
    20: { copy: 'Twenty. The habit is forming. Don\'t stop now.' },
    50: { copy: 'Fifty saves. Your brain is grateful.' },
    100: { copy: '100 things worth keeping. Absolute legend.' }
  };

  async function fireMilestone(n) {
    const def = MEMIO_MILESTONE_COPY[n];
    if (!def) return;

    memioQ('milestoneNumber').textContent = String(n);
    memioQ('milestoneCopy').textContent = def.copy;
    const sublineEl = memioQ('milestoneSubline');
    if (def.subline) {
      sublineEl.textContent = def.subline;
      sublineEl.hidden = false;
    } else {
      sublineEl.hidden = true;
    }

    const overlay = memioQ('milestoneOverlay');
    overlay.hidden = false;

    // Force a reflow so the pop-in animation restarts on every fire, not
    // just the first time the class is added.
    const numberEl = memioQ('milestoneNumber');
    numberEl.classList.remove('milestone-pop');
    void numberEl.offsetWidth;
    numberEl.classList.add('milestone-pop');

    await new Promise((resolve) => setTimeout(resolve, 3000));
    overlay.hidden = true;

    if (n === 1) await showSettingsBannerIfNeeded();
  }

  async function checkMilestones(memoCount) {
    const { firstMemoSaved, seenMilestones } = await chrome.storage.sync.get(['firstMemoSaved', 'seenMilestones']);

    if (!firstMemoSaved) {
      await chrome.storage.sync.set({ firstMemoSaved: true });
      await fireMilestone(1);
      return;
    }

    const seen = seenMilestones || [];
    const hit = MEMIO_MILESTONE_NUMBERS.find((n) => memoCount === n && !seen.includes(n));
    if (hit) {
      await chrome.storage.sync.set({ seenMilestones: [...seen, hit] });
      await fireMilestone(hit);
    }
  }

  // ---------------------------------------------------------------------
  // Settings nudge banner — shown once firstMemoSaved is true, dismissable
  // forever via chrome.storage.sync.settingsBannerDismissed.
  // ---------------------------------------------------------------------
  async function showSettingsBannerIfNeeded() {
    const { settingsBannerDismissed } = await chrome.storage.sync.get('settingsBannerDismissed');
    if (settingsBannerDismissed) return;
    memioQ('settingsBanner').hidden = false;
  }

  function initSettingsBanner() {
    memioQ('settingsBannerClose').addEventListener('click', async () => {
      memioQ('settingsBanner').hidden = true;
      await chrome.storage.sync.set({ settingsBannerDismissed: true });
    });
    memioQ('settingsBannerGear').addEventListener('click', (e) => {
      e.preventDefault();
      memioOpenSettingsOverlay();
    });
  }

  async function initPostSaveFeatures() {
    initSettingsBanner();
    const { firstMemoSaved } = await chrome.storage.sync.get('firstMemoSaved');
    if (firstMemoSaved) await showSettingsBannerIfNeeded();
  }

  // ---------------------------------------------------------------------
  // Memo view
  // ---------------------------------------------------------------------
  let displayedMemoCount = 0;

  function animateMemoCountTo(numberEl, to) {
    const from = displayedMemoCount;
    const duration = 500;
    const start = performance.now();

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      numberEl.textContent = String(Math.round(from + (to - from) * eased));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function setMemoCountDisplay(count, animate) {
    const numberEl = memioQ('memoCountNumber');
    if (animate && count !== displayedMemoCount) {
      animateMemoCountTo(numberEl, count);
    } else {
      numberEl.textContent = String(count);
    }
    displayedMemoCount = count;
  }

  async function updateMemoCount(animate) {
    const memos = await getMemos();
    setMemoCountDisplay(memos.length, animate);
  }

  async function autoSendMemoIfEnabled(memo) {
    const { autoSendOnSave } = await getStoredThemeSettings();
    if (!autoSendOnSave) return;

    const sentTo = [];

    if (destinationPreviewOverride) {
      // The user explicitly picked a destination in the New view's preview
      // — that one choice wins for this save, instead of "every enabled
      // type's default instance."
      const { typeId, instanceId, name, destination } = destinationPreviewOverride;
      try {
        await memioSendMemoToConnector(typeId, instanceId, memo, undefined, destination);
        sentTo.push({ id: instanceId, typeId, name });
      } catch (err) {
        // Leave it off sentTo — it'll still show up in History with a
        // manual "Send to..." option.
      }
    } else {
      // No override touched — normal behaviour: each connector type's own
      // default instance, if enabled. Silently does nothing if there's no
      // enabled default anywhere (per PART 7 — never errors for this).
      const defaultEnabled = await memioGetDefaultEnabledConnectors();
      for (const inst of defaultEnabled) {
        try {
          await memioSendMemoToConnector(inst.typeId, inst.id, memo);
          sentTo.push({ id: inst.id, typeId: inst.typeId, name: inst.name });
        } catch (err) {
          // Leave it off sentTo — it'll still show up in History with a
          // manual "Send to..." option for whichever connector didn't go through.
        }
      }
    }

    if (sentTo.length === 0) return;
    const memos = await getMemos();
    const idx = memos.findIndex((c) => c.id === memo.id);
    if (idx !== -1) {
      memos[idx] = Object.assign({}, memos[idx], { sentTo });
      await saveMemos(memos);
    }
  }

  async function initMemoView() {
    const titleInput = memioQ('memoTitle');
    const titleHint = memioQ('titleHint');
    const wandError = memioQ('wandError');
    const wandBtn = memioQ('generateTitleBtn');
    const textarea = memioQ('memoText');
    const sourceUrlEl = memioQ('sourceUrl');
    const saveBtn = memioQ('saveBtn');
    const tagInputField = memioQ('tagInputField');
    const savedConfirm = memioQ('savedConfirm');
    const destinationPreview = memioQ('destinationPreview');
    const destinationPreviewVault = memioQ('destinationPreviewVault');
    const destinationPreviewFolder = memioQ('destinationPreviewFolder');

    const draft = await getDraft();
    let url;
    let initialTags = [];

    if (draft && (draft.text || '').trim()) {
      titleInput.value = draft.title || '';
      textarea.value = draft.text || '';
      initialTags = draft.tags || [];
      url = draft.url || '';
    } else {
      textarea.value = capturedPageContext.text;
      url = capturedPageContext.url;
    }
    sourceUrlEl.textContent = url;
    sourceUrlEl.dataset.url = url;

    let draftTimer = null;
    const persistDraft = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        const tags = tagWidget.getTags();
        if (titleInput.value.trim() || textarea.value.trim() || tags.length) {
          saveDraft({ title: titleInput.value, text: textarea.value, tags, url: sourceUrlEl.dataset.url || '' });
        } else {
          clearDraft();
        }
      }, 400);
    };

    let refreshDestinationPreview = null;
    const tagWidget = memioCreateTagInput(tagInputField, initialTags, () => {
      persistDraft();
      if (refreshDestinationPreview) refreshDestinationPreview();
    });
    textarea.addEventListener('input', persistDraft);

    // Live preview of where auto-send will deliver this memo. Reflects
    // tag-based auto-routing as tags change (see refreshDestinationPreview
    // above), same as the manual "Send to..." popover — an explicit vault
    // or folder pick below overrides that live default for this save only.
    async function initDestinationPreview() {
      const { autoSendOnSave } = await getStoredThemeSettings();
      const enabledInstances = autoSendOnSave ? await memioGetEnabledConnectors() : [];
      if (!autoSendOnSave || enabledInstances.length === 0) {
        destinationPreview.hidden = true;
        return;
      }

      const connectors = await memioGetConnectors();
      const instanceConfig = (inst) => (connectors[inst.typeId] || []).find((i) => i.id === inst.id);

      destinationPreviewVault.innerHTML = '';
      const groupsByType = {};
      enabledInstances.forEach((inst) => {
        if (!groupsByType[inst.typeId]) {
          const group = document.createElement('optgroup');
          group.label = inst.typeId.toUpperCase();
          groupsByType[inst.typeId] = group;
          destinationPreviewVault.appendChild(group);
        }
        const config = instanceConfig(inst);
        const option = document.createElement('option');
        option.value = inst.id;
        option.textContent = config && config.isDefault ? `${inst.name} (default)` : inst.name;
        groupsByType[inst.typeId].appendChild(option);
      });

      const preselected =
        (destinationPreviewOverride && enabledInstances.find((i) => i.id === destinationPreviewOverride.instanceId)) ||
        enabledInstances.find((i) => (instanceConfig(i) || {}).isDefault) ||
        enabledInstances[0];
      destinationPreviewVault.value = preselected.id;

      let folderManuallyChosen = false;

      function refreshFolder(vaultJustChanged) {
        const inst = enabledInstances.find((i) => i.id === destinationPreviewVault.value);
        const config = instanceConfig(inst);
        const destinations = memioGetDestinationsForConnector(config, inst.typeId);

        destinationPreviewFolder.innerHTML = '';
        destinations.forEach((d, i) => {
          const option = document.createElement('option');
          option.value = String(i);
          option.textContent = d.label;
          destinationPreviewFolder.appendChild(option);
        });

        if (vaultJustChanged) folderManuallyChosen = false;

        if (!folderManuallyChosen) {
          const tags = tagWidget.getTags();
          const ruleDestination = memioFindMatchingTagRuleDestination(inst.typeId, config, tags);
          if (ruleDestination !== null) {
            const idx = destinations.findIndex((d) => JSON.stringify(d.value) === JSON.stringify(ruleDestination));
            if (idx !== -1) destinationPreviewFolder.value = String(idx);
          }
        }

        const chosen = destinations[Number(destinationPreviewFolder.value)];
        destinationPreviewOverride = {
          typeId: inst.typeId,
          instanceId: inst.id,
          name: inst.name,
          destination: chosen ? chosen.value : undefined
        };
      }

      destinationPreviewVault.addEventListener('change', () => refreshFolder(true));
      destinationPreviewFolder.addEventListener('change', () => {
        folderManuallyChosen = true;
        refreshFolder(false);
      });

      refreshFolder(true);
      destinationPreview.hidden = false;

      refreshDestinationPreview = () => refreshFolder(false);
    }

    await initDestinationPreview();

    function clearTitleInvalid() {
      titleInput.classList.remove('invalid');
      titleHint.hidden = true;
    }

    titleInput.addEventListener('input', () => {
      clearTitleInvalid();
      persistDraft();
    });

    async function refreshWandButton() {
      const hasContent = textarea.value.trim().length > 0;
      wandBtn.disabled = !hasContent;
      wandBtn.classList.toggle('active', hasContent);
      if (!hasContent) {
        wandBtn.title = '';
        return;
      }
      const connectors = await memioGetConnectors();
      const ready = !!(connectors.ai && connectors.ai.enabled && connectors.ai.apiKey);
      wandBtn.title = ready ? 'Generate title' : 'Turn on and add an AI key in Settings to use this';
    }

    textarea.addEventListener('input', () => {
      wandError.hidden = true;
      refreshWandButton();
    });
    await refreshWandButton();

    wandBtn.addEventListener('click', async () => {
      if (wandBtn.disabled || wandBtn.classList.contains('spinner')) return;

      wandError.hidden = true;

      const connectors = await memioGetConnectors();
      if (!connectors.ai || !connectors.ai.enabled || !connectors.ai.apiKey) {
        wandBtn.title = 'Turn on and add an AI key in Settings to use this';
        wandError.textContent = 'Turn on AI and add an API key in Settings to use this.';
        wandError.hidden = false;
        return;
      }

      wandBtn.classList.add('spinner');
      try {
        const generated = await memioGenerateTitle(textarea.value.trim(), tagWidget.getTags(), sourceUrlEl.dataset.url || '');
        titleInput.value = generated;
        clearTitleInvalid();
        persistDraft();
      } catch (err) {
        wandBtn.title = 'Could not generate a title — check your API key in Settings';
        wandError.textContent = `Couldn't generate a title (${err.message || 'unknown error'}). Check your API key in Settings.`;
        wandError.hidden = false;
      } finally {
        wandBtn.classList.remove('spinner');
        await refreshWandButton();
      }
    });

    saveBtn.addEventListener('click', async () => {
      const memoTitle = titleInput.value.trim();
      if (!memoTitle) {
        titleInput.classList.add('invalid');
        titleHint.hidden = false;
        return;
      }

      const memoText = textarea.value.trim();

      const memo = {
        id: memioUuid(),
        title: memoTitle,
        text: memoText,
        tags: tagWidget.getTags(),
        createdAt: new Date().toISOString(),
        url: sourceUrlEl.dataset.url || ''
      };

      const memos = await getMemos();
      memos.unshift(memo);
      await saveMemos(memos);
      await clearDraft();

      saveBtn.classList.add('pulse');
      setTimeout(() => saveBtn.classList.remove('pulse'), 120);

      titleInput.value = '';
      textarea.value = '';
      tagWidget.clear();
      sourceUrlEl.textContent = url;
      sourceUrlEl.dataset.url = url;
      await refreshWandButton();

      savedConfirm.classList.add('visible');
      setTimeout(() => savedConfirm.classList.remove('visible'), 1500);

      await updateMemoCount(true);
      await autoSendMemoIfEnabled(memo);

      if (tourActive && tourStepIndex === MEMIO_TOUR_STEPS.length - 1) await endTour();
      await checkMilestones(memos.length);
    });
  }

  // ---------------------------------------------------------------------
  // History view
  // ---------------------------------------------------------------------
  async function loadMemos() {
    allMemos = await getMemos();
    allMemos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    populateFilters();
    renderMemos();
    updateHistoryMemoCount();
    await refreshSendAllVisibility();
  }

  function updateHistoryMemoCount() {
    setMemoCountDisplay(allMemos.length, false);
  }

  function populateFilters() {
    const tagSet = new Set();
    allMemos.forEach((memo) => (memo.tags || []).forEach((t) => tagSet.add(t)));

    selectedTags = selectedTags.filter((t) => tagSet.has(t));
    renderTagFilterOptions(Array.from(tagSet).sort());
    updateTagFilterTrigger();
  }

  function updateTagFilterTrigger() {
    const trigger = memioQ('tagFilterTrigger');
    const clearBtn = memioQ('tagFilterClear');

    if (selectedTags.length === 0) {
      trigger.textContent = 'All tags';
    } else if (selectedTags.length === 1) {
      trigger.textContent = selectedTags[0];
    } else {
      trigger.textContent = `${selectedTags.length} tags`;
    }

    clearBtn.hidden = selectedTags.length === 0;
  }

  function renderTagFilterOptions(tags) {
    const optionsHost = memioQ('tagFilterOptions');
    optionsHost.innerHTML = '';

    tags.forEach((tag) => {
      const label = document.createElement('label');
      label.className = 'tag-filter-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedTags.includes(tag);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!selectedTags.includes(tag)) selectedTags.push(tag);
        } else {
          selectedTags = selectedTags.filter((t) => t !== tag);
        }
        updateTagFilterTrigger();
        renderMemos();
      });

      const text = document.createElement('span');
      text.textContent = tag;

      label.appendChild(checkbox);
      label.appendChild(text);
      optionsHost.appendChild(label);
    });
  }

  function getFilteredMemos() {
    const query = memioQ('searchInput').value.trim().toLowerCase();
    const timeRange = memioQ('timeRangeFilter').value;
    const now = new Date();

    return allMemos.filter((memo) => {
      if (query) {
        const haystack = ((memo.title || '') + ' ' + memo.text + ' ' + (memo.tags || []).join(' ')).toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (selectedTags.length && !selectedTags.every((t) => (memo.tags || []).includes(t))) return false;
      if (!matchesTimeRange(new Date(memo.createdAt), timeRange, now)) return false;
      return true;
    });
  }

  const MEMIO_TIME_RANGE_LABELS = {
    all: '',
    today: 'today',
    week: 'this week',
    month: 'this month',
    year: 'this year'
  };

  function buildScopeLabel() {
    const timeRange = memioQ('timeRangeFilter').value;
    const query = memioQ('searchInput').value.trim();

    const parts = [];
    if (MEMIO_TIME_RANGE_LABELS[timeRange]) parts.push(MEMIO_TIME_RANGE_LABELS[timeRange]);
    if (selectedTags.length === 1) parts.push(`tag: ${selectedTags[0]}`);
    else if (selectedTags.length > 1) parts.push(`tags: ${selectedTags.join(', ')}`);
    if (query) parts.push(`search: ${query}`);

    return parts.join(', ');
  }

  function getScopedMemos(scope) {
    const now = new Date();
    if (scope === 'view') return getFilteredMemos();
    if (scope === 'today' || scope === 'week' || scope === 'month') {
      return allMemos.filter((c) => matchesTimeRange(new Date(c.createdAt), scope, now));
    }
    return allMemos;
  }

  function renderMemos() {
    const list = memioQ('memoList');
    const emptyBlock = memioQ('historyEmptyState');
    const emptyText = memioQ('emptyState');
    const filtered = getFilteredMemos();

    list.innerHTML = '';

    if (allMemos.length === 0) {
      emptyBlock.hidden = false;
      emptyText.textContent = 'Nothing saved yet. Start somewhere.';
      return;
    }

    if (filtered.length === 0) {
      emptyBlock.hidden = false;
      emptyText.textContent = 'No memos match that. Try broader terms.';
      return;
    }

    emptyBlock.hidden = true;

    filtered.forEach((memo) => {
      list.appendChild(buildMemoCard(memo));
    });
  }

  // ---------------------------------------------------------------------
  // Send-destination popover — shown from a memo card's "Send to X" when
  // that connector has more than one saved destination (0 = nudge toward
  // Settings, 1 = skip the popover and send straight to it).
  // ---------------------------------------------------------------------
  function closeDestinationPopover(wrap) {
    const existing = wrap.querySelector('.send-destination-popover');
    if (existing) existing.remove();
  }

  function bindPopoverOutsideClose(wrap, pop) {
    const handler = (e) => {
      const target = memioEventTarget(e);
      if (!pop.contains(target)) {
        pop.remove();
        shadowRoot.removeEventListener('click', handler, true);
      }
    };
    // Deferred so the click that opened the popover doesn't immediately
    // close it, and to avoid registering before the window's own click
    // handling is fully wired up on slow pages.
    setTimeout(() => shadowRoot.addEventListener('click', handler, true), 50);
  }

  function showEmptyDestinationPopover(wrap, typeId, instanceId) {
    closeDestinationPopover(wrap);
    const pop = document.createElement('div');
    pop.className = 'send-destination-popover';

    const msg = document.createElement('p');
    msg.className = 'send-popover-message';
    msg.textContent = 'No destinations added yet. ';

    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Add one under Configure first.';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      pop.remove();
      memioOpenSettingsOverlay();
      await memioOpenConfigureDestinations(typeId, instanceId);
    });
    msg.appendChild(link);
    pop.appendChild(msg);

    wrap.appendChild(pop);
    bindPopoverOutsideClose(wrap, pop);
  }

  const MEMIO_COLLATION_OPTIONS = [
    ['individual', 'Send as individual memos'],
    ['daily', 'Send by days'],
    ['weekly', 'Send by weeks'],
    ['monthly', 'Send by months']
  ];

  // Vault → Folder → Collation popover (PART 5). `availableInstances` is
  // [{id, typeId, name}]; `onConfirm(typeId, instanceId, destination,
  // collationOverride)` performs the actual send. Collation is a one-time
  // choice for this send only — it's passed through as an override, never
  // written back to the instance's own saved setting.
  async function showSendPopover(wrap, memo, availableInstances, onConfirm) {
    closeDestinationPopover(wrap);
    const pop = document.createElement('div');
    pop.className = 'send-destination-popover send-popover-steps';

    const connectors = await memioGetConnectors();
    const instanceConfig = (inst) => (connectors[inst.typeId] || []).find((i) => i.id === inst.id);

    const vaultSelect = document.createElement('select');
    vaultSelect.className = 'filter-select send-popover-select';
    const groupsByType = {};
    availableInstances.forEach((inst) => {
      if (!groupsByType[inst.typeId]) {
        const group = document.createElement('optgroup');
        group.label = inst.typeId.toUpperCase();
        groupsByType[inst.typeId] = group;
        vaultSelect.appendChild(group);
      }
      const config = instanceConfig(inst);
      const option = document.createElement('option');
      option.value = inst.id;
      option.textContent = config && config.isDefault ? `${inst.name} (default)` : inst.name;
      groupsByType[inst.typeId].appendChild(option);
    });
    pop.appendChild(vaultSelect);

    // Options are listed in creation order, which isn't necessarily the
    // default — pre-select whichever instance is actually marked default,
    // rather than letting the browser fall back to the first <option>.
    const preselectedInstance =
      availableInstances.find((i) => (instanceConfig(i) || {}).isDefault) || availableInstances[0];
    vaultSelect.value = preselectedInstance.id;

    const folderSelect = document.createElement('select');
    folderSelect.className = 'filter-select send-popover-select';
    pop.appendChild(folderSelect);

    const collationSelect = document.createElement('select');
    collationSelect.className = 'filter-select send-popover-select send-popover-collation';
    MEMIO_COLLATION_OPTIONS.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      collationSelect.appendChild(option);
    });
    pop.appendChild(collationSelect);

    let folderManuallyChanged = false;
    folderSelect.addEventListener('change', () => {
      folderManuallyChanged = true;
    });

    function renderFolderAndCollation() {
      const inst = availableInstances.find((i) => i.id === vaultSelect.value);
      const config = instanceConfig(inst);
      const destinations = memioGetDestinationsForConnector(config, inst.typeId);

      folderSelect.innerHTML = '';
      destinations.forEach((d, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = d.label;
        folderSelect.appendChild(option);
      });

      // Reflects tag-based auto-routing by default (what would actually
      // happen if this were an auto-send), not just the static default —
      // an explicit folder pick below still overrides it for this send.
      // Only meaningful for a single memo (the "Send to" case); bulk sends
      // pass memo=null and just show the plain default, since one folder
      // pick has to apply uniformly across every memo in the batch.
      folderManuallyChanged = false;
      const ruleDestination = memo ? memioFindMatchingTagRuleDestination(inst.typeId, config, memo.tags) : null;
      if (ruleDestination !== null) {
        const idx = destinations.findIndex((d) => JSON.stringify(d.value) === JSON.stringify(ruleDestination));
        if (idx !== -1) folderSelect.value = String(idx);
      }

      collationSelect.value = config.collation || 'individual';
    }

    vaultSelect.addEventListener('change', renderFolderAndCollation);
    renderFolderAndCollation();

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn-primary send-popover-confirm';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', async () => {
      const inst = availableInstances.find((i) => i.id === vaultSelect.value);
      const config = instanceConfig(inst);
      const destinations = memioGetDestinationsForConnector(config, inst.typeId);
      const chosenDest = destinations[Number(folderSelect.value)];
      const collationChoice = collationSelect.value;
      pop.remove();
      await onConfirm(inst.typeId, inst.id, inst.name, chosenDest ? chosenDest.value : undefined, collationChoice);
    });
    pop.appendChild(sendBtn);

    const cancelLink = document.createElement('button');
    cancelLink.type = 'button';
    cancelLink.className = 'send-popover-cancel';
    cancelLink.textContent = 'Cancel';
    cancelLink.addEventListener('click', () => pop.remove());
    pop.appendChild(cancelLink);

    wrap.appendChild(pop);
    bindPopoverOutsideClose(wrap, pop);
  }

  async function buildSendToControl(memo, statusHost) {
    const enabledInstances = await memioGetEnabledConnectors();
    if (enabledInstances.length === 0) return null;

    const alreadySentIds = (memo.sentTo || []).map(memioSentToId);
    const available = enabledInstances.filter((inst) => !alreadySentIds.includes(inst.id));

    const wrap = document.createElement('div');
    wrap.className = 'send-to-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'send-to-btn';
    btn.textContent = 'Send to...';

    if (available.length === 0) {
      btn.disabled = true;
      btn.classList.add('exhausted');
      btn.title = 'Already sent to every enabled connection';
      wrap.appendChild(btn);
      return wrap;
    }

    const performSend = async (typeId, instanceId, instanceName, destination, collationOverride) => {
      btn.disabled = true;
      btn.classList.add('spinner');
      btn.textContent = '';
      statusHost.textContent = '';
      statusHost.className = 'send-status';

      try {
        const context = collationOverride ? { collationOverride } : undefined;
        await memioSendMemoToConnector(typeId, instanceId, memo, context, destination);
        statusHost.textContent = 'Sent.';
        statusHost.className = 'send-status success';
        const entry = { id: instanceId, typeId, name: instanceName };
        await updateMemo(memo.id, { sentTo: (memo.sentTo || []).concat([entry]) });
        setTimeout(() => {
          populateFilters();
          renderMemos();
        }, 1500);
      } catch (err) {
        statusHost.innerHTML = '';
        statusHost.className = 'send-status failed';
        statusHost.appendChild(document.createTextNode('Failed. '));
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'send-status-link';
        link.textContent = 'Check settings';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          memioOpenSettingsOverlay();
        });
        statusHost.appendChild(link);
      } finally {
        btn.disabled = false;
        btn.classList.remove('spinner');
        btn.textContent = 'Send to...';
      }
    };

    btn.addEventListener('click', async () => {
      // Skip the popover entirely only when there's exactly one eligible
      // destination overall — same "zero extra clicks when there's nothing
      // to choose" shortcut as before, just extended to also require
      // there being only one instance (not just one folder within it).
      if (available.length === 1) {
        const inst = available[0];
        const connectors = await memioGetConnectors();
        const config = (connectors[inst.typeId] || []).find((i) => i.id === inst.id);
        const ruleDestination = memioFindMatchingTagRuleDestination(inst.typeId, config, memo.tags);
        if (ruleDestination !== null) {
          await performSend(inst.typeId, inst.id, inst.name, ruleDestination);
          return;
        }
        const destinations = memioGetDestinationsForConnector(config, inst.typeId);
        if (destinations.length === 0) {
          showEmptyDestinationPopover(wrap, inst.typeId, inst.id);
          return;
        }
        if (destinations.length === 1) {
          await performSend(inst.typeId, inst.id, inst.name, destinations[0].value);
          return;
        }
      }
      await showSendPopover(wrap, memo, available, performSend);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  // sentTo entries are either the new denormalized shape
  // ({id, typeId, name} — instance name captured at send time, so renaming
  // or deleting the instance later doesn't orphan the badge) or a legacy
  // plain string (a bare connector-type id like "obsidian", from before
  // multi-instance existed).
  function memioSentToId(entry) {
    return typeof entry === 'string' ? entry : entry.id;
  }
  function memioSentToLabel(entry) {
    return typeof entry === 'string' ? memioGetConnectorName(entry) : entry.name;
  }

  function buildSentBadges(memo) {
    const sentTo = memo.sentTo || [];
    if (!sentTo.length) return null;
    const row = document.createElement('div');
    row.className = 'sent-badges';
    sentTo.forEach((entry) => {
      const badge = document.createElement('span');
      badge.className = 'sent-badge';
      badge.textContent = `Sent to ${memioSentToLabel(entry)}`;
      row.appendChild(badge);
    });
    return row;
  }

  function buildUnsendControl(memo) {
    const sentTo = memo.sentTo || [];
    if (!sentTo.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'send-to-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'unsend-btn';
    btn.textContent = 'Unsend';

    const menu = document.createElement('div');
    menu.className = 'send-to-menu';
    menu.hidden = true;

    sentTo.forEach((entry) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = `Unsend from ${memioSentToLabel(entry)}`;
      item.addEventListener('click', async () => {
        menu.hidden = true;
        const updated = (memo.sentTo || []).filter((e) => memioSentToId(e) !== memioSentToId(entry));
        await updateMemo(memo.id, { sentTo: updated });
        populateFilters();
        renderMemos();
      });
      menu.appendChild(item);
    });

    btn.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  async function updateMemo(id, patch) {
    const idx = allMemos.findIndex((c) => c.id === id);
    if (idx === -1) return;
    allMemos[idx] = Object.assign({}, allMemos[idx], patch);
    await saveMemos(allMemos);
  }

  function buildMemoCard(memo, editing) {
    const card = document.createElement('div');
    card.className = 'memo-card';
    card.dataset.id = memo.id;

    if (editing) {
      const editTitle = document.createElement('input');
      editTitle.type = 'text';
      editTitle.className = 'title-input';
      editTitle.placeholder = 'Title';
      editTitle.value = memo.title || '';
      card.appendChild(editTitle);

      const editHint = document.createElement('p');
      editHint.className = 'title-hint';
      editHint.textContent = 'Add a title to save';
      editHint.hidden = true;
      card.appendChild(editHint);

      editTitle.addEventListener('input', () => {
        editTitle.classList.remove('invalid');
        editHint.hidden = true;
      });

      const editTextarea = document.createElement('textarea');
      editTextarea.className = 'memo-textarea memo-edit-textarea';
      editTextarea.value = memo.text;
      card.appendChild(editTextarea);

      const editTagsWrap = document.createElement('div');
      editTagsWrap.className = 'tag-input';
      card.appendChild(editTagsWrap);
      const editTagsWidget = memioCreateTagInput(editTagsWrap, memo.tags || []);

      const editFooter = document.createElement('div');
      editFooter.className = 'memo-footer';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const newTitle = editTitle.value.trim();
        if (!newTitle) {
          editTitle.classList.add('invalid');
          editHint.hidden = false;
          return;
        }
        const newText = editTextarea.value.trim();
        const newTags = editTagsWidget.getTags();
        await updateMemo(memo.id, { title: newTitle, text: newText, tags: newTags });
        populateFilters();
        renderMemos();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        renderMemos();
      });

      editFooter.appendChild(saveBtn);
      editFooter.appendChild(cancelBtn);
      card.appendChild(editFooter);

      return card;
    }

    if (memo.title) {
      const titleEl = document.createElement('p');
      titleEl.className = 'memo-title';
      titleEl.textContent = memo.title;
      card.appendChild(titleEl);
    }

    const meta = document.createElement('div');
    meta.className = 'memo-meta';

    const timestamp = document.createElement('span');
    timestamp.className = 'memo-timestamp';
    timestamp.textContent = formatTimestamp(memo.createdAt);
    meta.appendChild(timestamp);

    if (memo.url) {
      const link = document.createElement('a');
      link.className = 'memo-url';
      link.href = memo.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = truncateUrl(memo.url);
      meta.appendChild(link);
    }

    card.appendChild(meta);

    if (memo.tags && memo.tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';
      memo.tags.forEach((t) => {
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = t;
        tagRow.appendChild(pill);
      });
      card.appendChild(tagRow);
    }

    const sentBadges = buildSentBadges(memo);
    if (sentBadges) card.appendChild(sentBadges);

    const textEl = document.createElement('p');
    textEl.className = 'memo-text';
    textEl.textContent = memo.text;
    textEl.addEventListener('click', () => {
      textEl.classList.toggle('expanded');
    });
    card.appendChild(textEl);

    const footer = document.createElement('div');
    footer.className = 'memo-footer';

    const statusHost = document.createElement('span');
    statusHost.className = 'send-status';

    buildSendToControl(memo, statusHost).then((control) => {
      if (control) footer.insertBefore(control, footer.firstChild);
    });

    const actions = document.createElement('div');
    actions.className = 'memo-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      const editCard = buildMemoCard(memo, true);
      card.replaceWith(editCard);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      card.classList.add('fade-out');
      setTimeout(async () => {
        allMemos = allMemos.filter((c) => c.id !== memo.id);
        await saveMemos(allMemos);
        populateFilters();
        renderMemos();
        updateHistoryMemoCount();
        await refreshSendAllVisibility();
      }, 200);
    });

    const unsendControl = buildUnsendControl(memo);

    actions.appendChild(editBtn);
    if (unsendControl) actions.appendChild(unsendControl);
    actions.appendChild(deleteBtn);

    footer.appendChild(statusHost);
    footer.appendChild(actions);
    card.appendChild(footer);

    return card;
  }

  function toCSV(memos) {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const header = 'createdAt,title,text,tags,url';
    const rows = memos.map((c) =>
      [esc(c.createdAt), esc(c.title || ''), esc(c.text), esc((c.tags || []).join(';')), esc(c.url)].join(',')
    );
    return [header, ...rows].join('\n');
  }

  function toMarkdown(memos) {
    return memos
      .map((c) => {
        const frontmatter = [
          '---',
          `created: ${c.createdAt}`,
          `tags: [${(c.tags || []).join(', ')}]`,
          `url: ${c.url}`,
          '---'
        ].join('\n');
        return `## ${c.title || c.createdAt}\n\n${frontmatter}\n\n${c.text}\n`;
      })
      .join('\n');
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportMemos(format, scope) {
    const memos = getScopedMemos(scope);
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      downloadFile(`memio-export-${stamp}.json`, JSON.stringify(memos, null, 2), 'application/json');
    } else if (format === 'csv') {
      downloadFile(`memio-export-${stamp}.csv`, toCSV(memos), 'text/csv');
    } else if (format === 'markdown') {
      downloadFile(`memio-export-${stamp}.md`, toMarkdown(memos), 'text/markdown');
    }
  }

  async function refreshSendAllVisibility() {
    const row = memioQ('sendAllRow');
    const enabled = await memioGetEnabledConnectors();
    row.hidden = enabled.length === 0;
  }

  function initExportPanel() {
    const toggleBtn = memioQ('exportToggleBtn');
    const panel = memioQ('exportPanel');
    const confirmBtn = memioQ('exportConfirmBtn');

    toggleBtn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
    });

    confirmBtn.addEventListener('click', () => {
      const format = shadowRoot.querySelector('input[name="exportFormat"]:checked').value;
      const scope = shadowRoot.querySelector('input[name="exportScope"]:checked').value;
      exportMemos(format, scope);
      panel.hidden = true;
    });
  }

  function initInfoOverlays() {
    const donateBtn = memioQ('donateBtn');
    const donateOverlay = memioQ('donateOverlay');
    const closeDonateBtn = memioQ('closeDonateBtn');

    donateBtn.addEventListener('click', () => {
      donateOverlay.hidden = false;
    });
    closeDonateBtn.addEventListener('click', () => {
      donateOverlay.hidden = true;
    });
    donateOverlay.addEventListener('click', (e) => {
      if (memioEventTarget(e) === donateOverlay) donateOverlay.hidden = true;
    });

    const helpBtn = memioQ('helpBtn');
    const helpOverlay = memioQ('helpOverlay');
    const closeHelpBtn = memioQ('closeHelpBtn');
    let helpFaqRendered = false;

    helpBtn.addEventListener('click', () => {
      if (!helpFaqRendered) {
        helpFaqRendered = true;
        memioRenderHelpFaq(memioQ('helpFaqScroll'));
      }
      helpOverlay.hidden = false;
    });
    closeHelpBtn.addEventListener('click', () => {
      helpOverlay.hidden = true;
    });
    helpOverlay.addEventListener('click', (e) => {
      if (memioEventTarget(e) === helpOverlay) helpOverlay.hidden = true;
    });
  }

  // ---------------------------------------------------------------------
  // Help panel — FAQ content, rendered once on first open.
  // ---------------------------------------------------------------------
  const MEMIO_HELP_SECTIONS = [
    {
      label: 'CAPTURING',
      questions: [
        {
          q: 'How do I save text from a page?',
          a: 'Highlight any text on a page, then click the Memio icon in your toolbar. The text auto-populates the save field, ready to title and tag.'
        },
        {
          q: "Why isn't my highlighted text appearing?",
          a: "Reload the page and try again. Some pages — like Chrome settings or the Web Store — block extensions by default. Nothing you can fix."
        }
      ]
    },
    {
      label: 'SAVING',
      questions: [
        {
          q: 'How do I add a title?',
          a: 'Type one manually in the title field. Or fill in the body first and hit the wand button to generate one with AI. Title is required to save.'
        },
        {
          q: 'How do I add tags?',
          a: 'Type in the tags field and separate with commas. Tags are optional but unlock filtering in History and auto-routing to connectors later.'
        }
      ]
    },
    {
      label: 'HISTORY',
      questions: [
        {
          q: 'How do I search my memos?',
          a: 'Open History and type in the search bar. Searches across titles, memo text, and tags in real time.'
        },
        {
          q: 'How do I edit a memo?',
          a: 'Find the memo in History and click Edit. Title, body, and tags are all editable. Click Save to update.'
        },
        {
          q: 'How do I delete a memo?',
          a: 'Find the memo in History and click Delete. Permanent and cannot be undone.'
        },
        {
          q: 'What does Unsend do?',
          a: 'It removes the "Sent to Obsidian" or "Sent to Notion" marker from a memo inside Memio. It does not delete the note or page from Obsidian or Notion — that stays. Useful if you want to re-send a memo somewhere after editing it.'
        }
      ]
    },
    {
      label: 'SENDING & EXPORTING',
      questions: [
        {
          q: "What's the difference between Send to, Send all to, and Auto-send?",
          blocks: [
            {
              label: '"Send to"',
              text: 'Manual and deliberate. Use when you want to send one specific memo to a chosen folder or page. Good for selective saves where the destination matters.'
            },
            {
              label: '"Send all to"',
              text: "Bulk manual send. Use after a saving session to push everything at once. Respects active filters — filter by tag or time range first, then send only that subset."
            },
            {
              label: '"Auto-send"',
              text: 'Fires every time you save a memo. Zero friction. Best paired with tag routing so memos land in the right place automatically.'
            }
          ],
          note: "Auto-send if you have a system. Send all to if you batch. Send to if you're being selective."
        },
        {
          q: 'How do I export my memos?',
          a: "Open History and click Export. Choose your format (JSON, CSV, or Markdown) and your scope (all memos, filtered view, today, this week, this month). Downloads immediately."
        }
      ]
    },
    {
      label: 'CONNECTORS',
      questions: [
        {
          q: 'How do I connect Obsidian?',
          a: 'Go to Settings → Connectors → Obsidian → Configure. Install the Local REST API community plugin in Obsidian, copy the API key it generates, and paste it into Memio. Obsidian must be open when sending memos.'
        },
        {
          q: 'How do I connect Notion?',
          a: 'Go to Settings → Connectors → Notion → Configure. Create an integration at notion.so/my-integrations, copy the token, share your target database with the integration, then paste the database ID into Memio.'
        },
        {
          q: 'How do I add an AI provider for title generation?',
          a: 'Go to Settings → AI. Choose your provider (Claude, ChatGPT, or Gemini), paste your API key, and save. The wand button on the New screen activates once a key is saved. Your key is stored locally and never leaves your device.'
        },
        {
          q: 'What is tag routing?',
          a: 'Under each connector in Settings, you can map tags to specific folders or pages. A memo tagged "design" goes straight to your /design folder in Obsidian, for example. First matching rule wins. Unmatched memos go to your default destination. Each memo goes to one destination only. If a memo has multiple tags and more than one rule matches, the first matching rule wins. Order your rules intentionally.'
        },
        {
          q: 'Can I send a memo to different folders each time?',
          a: 'Yes. Add multiple folders or pages under each connector in Settings first. Then click "Send to..." on any memo and pick your destination from the list. If you only have one destination saved, it sends there automatically with no extra click.'
        }
      ]
    },
    {
      label: 'DATA & PRIVACY',
      questions: [
        {
          q: 'Does Memio store my data anywhere?',
          a: 'No. Everything stays in your browser. Memos, tags, and preferences sync across your signed-in Chrome installs via Chrome sync; connector API keys and tokens are kept device-only in local storage and never sync anywhere. No accounts, no servers, no cloud storage of any kind.'
        },
        {
          q: 'Can I get my data out?',
          a: 'Yes, any time. Export as JSON, CSV, or Markdown from the History view. JSON is the most complete format if you want to back everything up.'
        }
      ]
    }
  ];

  function memioBuildHelpAnswer(item) {
    if (item.blocks) {
      const wrap = document.createElement('div');
      wrap.className = 'help-answer-blocks';
      item.blocks.forEach((b) => {
        const block = document.createElement('div');
        block.className = 'help-answer-block';

        const label = document.createElement('p');
        label.className = 'help-answer-block-label';
        label.textContent = b.label;
        block.appendChild(label);

        const text = document.createElement('p');
        text.className = 'help-answer-block-text';
        text.textContent = b.text;
        block.appendChild(text);

        wrap.appendChild(block);
      });
      if (item.note) {
        const note = document.createElement('p');
        note.className = 'help-answer-note';
        note.textContent = item.note;
        wrap.appendChild(note);
      }
      return wrap;
    }
    const p = document.createElement('p');
    p.className = 'help-answer-text';
    p.textContent = item.a;
    return p;
  }

  function memioRenderHelpFaq(container) {
    container.innerHTML = '';

    // Only one section open at a time — same "close everything, then open
    // the clicked one" approach used for questions within a section below.
    const sectionEntries = [];

    MEMIO_HELP_SECTIONS.forEach((section) => {
      const sectionWrap = document.createElement('div');
      sectionWrap.className = 'help-section';

      const sectionHeader = document.createElement('button');
      sectionHeader.type = 'button';
      sectionHeader.className = 'help-section-header';
      sectionHeader.innerHTML = `<span>${memioEscapeText(section.label)}</span><span class="connector-chevron">&#8250;</span>`;

      const sectionBody = document.createElement('div');
      sectionBody.className = 'help-section-body';
      sectionBody.hidden = true;

      sectionHeader.addEventListener('click', () => {
        const willOpen = sectionBody.hidden;
        sectionEntries.forEach(({ header, body }) => {
          body.hidden = true;
          header.classList.remove('open');
        });
        if (willOpen) {
          sectionBody.hidden = false;
          sectionHeader.classList.add('open');
        }
      });

      sectionEntries.push({ header: sectionHeader, body: sectionBody });

      const entries = [];
      section.questions.forEach((item) => {
        const qWrap = document.createElement('div');
        qWrap.className = 'help-question';

        const qHeader = document.createElement('button');
        qHeader.type = 'button';
        qHeader.className = 'help-question-header';
        qHeader.innerHTML = `<span>${memioEscapeText(item.q)}</span><span class="connector-chevron">&#8250;</span>`;

        const qBody = document.createElement('div');
        qBody.className = 'help-question-body';
        qBody.hidden = true;
        qBody.appendChild(memioBuildHelpAnswer(item));

        // Only one question open at a time within a section — closing every
        // entry before opening the clicked one is simpler than tracking
        // "which one was previously open" by reference.
        qHeader.addEventListener('click', () => {
          const willOpen = qBody.hidden;
          entries.forEach(({ header, body }) => {
            body.hidden = true;
            header.classList.remove('open');
          });
          if (willOpen) {
            qBody.hidden = false;
            qHeader.classList.add('open');
          }
        });

        entries.push({ header: qHeader, body: qBody });

        qWrap.appendChild(qHeader);
        qWrap.appendChild(qBody);
        sectionBody.appendChild(qWrap);
      });

      sectionWrap.appendChild(sectionHeader);
      sectionWrap.appendChild(sectionBody);
      container.appendChild(sectionWrap);
    });
  }

  function initSendAll() {
    const toggleBtn = memioQ('sendAllToggleBtn');
    const wrap = memioQ('sendAllRow');
    const progress = memioQ('sendAllProgress');

    async function runBulkSend(typeId, instanceId, instanceName, destination, collationOverride) {
      const memos = getFilteredMemos().filter((c) => !(c.sentTo || []).map(memioSentToId).includes(instanceId));
      const scopeLabel = buildScopeLabel();
      const context = Object.assign({}, scopeLabel ? { scopeLabel } : null, collationOverride ? { collationOverride } : null);
      const total = memos.length;
      let sent = 0;
      let failed = 0;

      if (total === 0) {
        progress.hidden = false;
        progress.textContent = 'Nothing new to send — already sent to everyone in view.';
        setTimeout(() => {
          progress.hidden = true;
        }, 4000);
        return;
      }

      progress.hidden = false;
      progress.textContent = `Sending 0 of ${total}...`;

      for (let i = 0; i < total; i++) {
        try {
          await memioSendMemoToConnector(typeId, instanceId, memos[i], context, destination);
          sent++;
          const entry = { id: instanceId, typeId, name: instanceName };
          await updateMemo(memos[i].id, {
            sentTo: (memos[i].sentTo || []).concat([entry])
          });
        } catch (err) {
          failed++;
        }
        progress.textContent = `Sending ${i + 1} of ${total}...`;
      }

      progress.textContent = failed === 0 ? `Done. ${sent} memos sent.` : `Done. ${sent} sent, ${failed} failed.`;
      populateFilters();
      renderMemos();
      setTimeout(() => {
        progress.hidden = true;
      }, 4000);
    }

    toggleBtn.addEventListener('click', async () => {
      const enabledInstances = await memioGetEnabledConnectors();
      if (enabledInstances.length === 0) return;
      // memo=null: one folder/collation pick applies uniformly to the
      // whole batch, rather than per-memo tag routing.
      await showSendPopover(wrap, null, enabledInstances, runBulkSend);
    });
  }

  function initTagFilter() {
    const trigger = memioQ('tagFilterTrigger');
    const menu = memioQ('tagFilterMenu');
    const clearBtn = memioQ('tagFilterClear');

    trigger.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });

    clearBtn.addEventListener('click', () => {
      selectedTags = [];
      populateFilters();
      renderMemos();
    });
  }

  function initHistoryView() {
    memioQ('searchInput').addEventListener('input', renderMemos);
    memioQ('timeRangeFilter').addEventListener('change', renderMemos);

    initTagFilter();
    initExportPanel();
    initSendAll();

    shadowRoot.addEventListener('click', (e) => {
      const target = memioEventTarget(e);

      const tagFilterMenu = memioQ('tagFilterMenu');
      const tagFilterWrap = memioQ('tagFilterWrap');
      if (!tagFilterMenu.hidden && !tagFilterWrap.contains(target)) {
        tagFilterMenu.hidden = true;
      }

      const exportPanel = memioQ('exportPanel');
      const exportToggleBtn = memioQ('exportToggleBtn');
      if (!exportPanel.hidden && !exportPanel.contains(target) && target !== exportToggleBtn) {
        exportPanel.hidden = true;
      }

      memioQAll('.send-to-menu').forEach((menu) => {
        if (!menu.hidden && !menu.contains(target) && target.closest && target.closest('.send-to-wrap') !== menu.closest('.send-to-wrap')) {
          menu.hidden = true;
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // Nav (New / History tabs)
  // ---------------------------------------------------------------------
  function initNav() {
    const navNew = memioQ('navNew');
    const navHistory = memioQ('navHistory');
    const memoView = memioQ('memoView');
    const historyView = memioQ('historyView');

    navNew.addEventListener('click', async () => {
      navNew.classList.add('active');
      navHistory.classList.remove('active');
      memoView.hidden = false;
      historyView.hidden = true;
      await updateMemoCount();
    });

    navHistory.addEventListener('click', async () => {
      navHistory.classList.add('active');
      navNew.classList.remove('active');
      memoView.hidden = true;
      historyView.hidden = false;
      if (!historyLoadedOnce) {
        historyLoadedOnce = true;
        initHistoryView();
      }
      await loadMemos();
    });
  }

  function initSettingsTabs() {
    const tabs = [
      { btn: memioQ('settingsTabConnectors'), section: memioQ('settingsSectionConnectors') },
      {
        btn: memioQ('settingsTabConfigure'),
        section: memioQ('settingsSectionConfigure'),
        // Which connectors are enabled can change while this tab isn't
        // visible, so re-render every time it's opened rather than once.
        onShow: () => memioRenderConfigureSections(memioQ('configureSections'))
      },
      { btn: memioQ('settingsTabAI'), section: memioQ('settingsSectionAI') },
      { btn: memioQ('settingsTabTheme'), section: memioQ('settingsSectionTheme') }
    ];

    tabs.forEach(({ btn, section, onShow }) => {
      btn.addEventListener('click', () => {
        tabs.forEach(({ btn: b, section: s }) => {
          b.classList.toggle('active', b === btn);
          s.hidden = s !== section;
        });
        if (onShow) onShow();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Dragging + position persistence
  // ---------------------------------------------------------------------
  async function restorePosition() {
    const { windowPosition } = await chrome.storage.sync.get('windowPosition');
    const win = memioQ('memioWindow');
    if (windowPosition && typeof windowPosition.x === 'number' && typeof windowPosition.y === 'number') {
      win.style.left = `${windowPosition.x}px`;
      win.style.top = `${windowPosition.y}px`;
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    }
  }

  function initDrag() {
    const win = memioQ('memioWindow');
    const header = memioQ('windowHeader');
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (memioEventTarget(e).closest && memioEventTarget(e).closest('.icon-btn')) return;
      dragging = true;
      header.classList.add('grabbing');
      const rect = win.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      win.style.right = 'auto';
      win.style.bottom = 'auto';
      e.preventDefault();
    });

    // Attaching these a beat after window injection, rather than
    // synchronously, avoids a race on slow-loading pages where a
    // document-level listener could end up registered (and start reacting
    // to events) before the window's own click handlers above it in this
    // function are fully wired up.
    setTimeout(() => {
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxLeft = window.innerWidth - win.offsetWidth;
        const maxTop = window.innerHeight - win.offsetHeight;
        const newLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
        const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
        win.style.left = `${newLeft}px`;
        win.style.top = `${newTop}px`;
      });

      document.addEventListener('mouseup', async () => {
        if (!dragging) return;
        dragging = false;
        header.classList.remove('grabbing');
        const rect = win.getBoundingClientRect();
        await chrome.storage.sync.set({ windowPosition: { x: rect.left, y: rect.top } });
      });
    }, 50);
  }

  // ---------------------------------------------------------------------
  // Window lifecycle
  // ---------------------------------------------------------------------
  async function createWindow() {
    try {
      await createWindowUnsafe();
    } catch (err) {
      // Whatever failed, hostEl/shadowRoot may already be partway built
      // (e.g. appended to the page but never fully populated) — clean up
      // fully rather than leaving an orphaned, half-built element in the
      // page and stale references that would make the next toggle attempt
      // silently do nothing instead of retrying cleanly.
      console.error('[MEMIO] Window creation failed partway through:', err);
      if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
      hostEl = null;
      shadowRoot = null;
      initialized = false;
      throw err;
    }
  }

  async function createWindowUnsafe() {
    hostEl = document.createElement('div');
    hostEl.id = 'memio-host';
    // No `all: initial` or `display` here: both would beat (or in the case
    // of an author !important rule, fight with) the :host([hidden]) rule in
    // styles.css that actually hides this element. The shadow root's own
    // stylesheet already resets what's needed inside the shadow tree.
    hostEl.style.cssText = 'position: static; width: 0; height: 0; overflow: visible;';
    document.documentElement.appendChild(hostEl);

    // 'closed' means `hostEl.shadowRoot` is null from the page's own
    // scripts — the extension keeps its own reference via the return value
    // here (the `shadowRoot` closure variable), which is all it ever uses.
    shadowRoot = hostEl.attachShadow({ mode: 'closed' });
    memioRootRef = shadowRoot;
    memioHostRef = hostEl;

    await Promise.all([injectFonts(shadowRoot), injectAppStyles(shadowRoot)]);

    // Sites that set a Trusted Types CSP (require-trusted-types-for
    // 'script') throw on any innerHTML assignment into the live page
    // document — including from a content script, since enforcement is
    // per-document, not per-script-origin. That's a real, well-known cause
    // of "this extension works on most sites but silently breaks on a few"
    // bugs. Parsing into a standalone DOMParser document sidesteps it
    // entirely: that document was never attached to the page, so the
    // page's Trusted Types policy never applies to it.
    const parsed = new DOMParser().parseFromString(buildMarkup(), 'text/html');
    Array.from(parsed.body.childNodes).forEach((node) => {
      shadowRoot.appendChild(document.importNode(node, true));
    });

    // Some host pages have their own "click outside closes this" logic for
    // their own overlays/dropdowns (listening on click or mousedown at the
    // document level) that can end up reacting to clicks that originated
    // inside our injected window, since those events still bubble/compose
    // out of the shadow tree into the page's own document. Stopping
    // propagation here means the only things that can ever close this
    // window are the explicit triggers below (the × button and re-clicking
    // the toolbar icon) — never anything the host page's own JS does.
    // mouseup is deliberately excluded: the drag-to-reposition feature
    // below relies on a document-level mouseup listener to finalize a
    // drag, which would never fire if stopped here first.
    const windowEl = memioQ('memioWindow');
    if (windowEl) {
      windowEl.addEventListener('click', (e) => e.stopPropagation());
      windowEl.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    memioQ('closeWindowBtn').addEventListener('click', hideWindow);
    initInfoOverlays();

    await restorePosition();
    initDrag();
    initNav();
    initSettingsTabs();
    await initSettingsPanel();
    await memioRenderConnectorSections();
    await memioRenderAiSection(memioQ('aiSection'));
    await updateMemoCount();
    await initMemoView();
    initTour();
    await initPostSaveFeatures();
    await checkAndStartTour();

    initialized = true;
  }

  function showWindow() {
    if (hostEl) hostEl.hidden = false;
  }

  function hideWindow() {
    if (hostEl) hostEl.hidden = true;
  }

  async function toggleWindow() {
    // hostEl can go stale without our own code ever touching it — a
    // client-side route change or a page script's own cleanup logic can
    // remove it from the DOM while `initialized` stays true (nothing in
    // this file was told it happened). Toggling .hidden on a detached
    // element is a silent no-op, which is exactly what "clicking the icon
    // does nothing" looks like from the outside. Treat a detached hostEl
    // as if the window were never created, so the click below rebuilds it
    // cleanly instead of quietly failing forever for the rest of this tab's
    // lifetime.
    if (initialized && (!hostEl || !document.contains(hostEl))) {
      console.error('[MEMIO] Host element is detached from the DOM — resetting and recreating.');
      initialized = false;
      hostEl = null;
      shadowRoot = null;
      creatingPromise = null;
    }

    if (!initialized) {
      // createWindow() is async (fetches fonts + styles.css over the
      // network) — without this guard, clicking the toolbar icon again
      // before it resolves would race a second createWindow() call and
      // produce two overlapping windows, each with its own close button
      // that only closes itself.
      if (!creatingPromise) {
        creatingPromise = createWindow()
          .catch(() => {
            // createWindow() already logs the specific failure and resets
            // hostEl/shadowRoot/initialized itself — nothing further to do
            // here except make sure this rejection doesn't become an
            // unhandled promise rejection.
          })
          .finally(() => {
            creatingPromise = null;
          });
      }
      await creatingPromise;
      if (initialized) showWindow();
      return;
    }
    if (hostEl.hidden) {
      showWindow();
    } else {
      hideWindow();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'MEMIO_TOGGLE_WINDOW') {
      toggleWindow();
    }
  });
})();
