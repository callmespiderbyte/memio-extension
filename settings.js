// Colour is now owned entirely by styles.css's design tokens. This file's
// only job is: (1) persist the user's accentName/theme choice, and (2) set
// data-accent / data-theme on the shadow host so the right
// :host([data-accent="..."]) / :host([data-theme="..."]) CSS rules take
// over. No hex math happens here anymore.
//
// Root-query helpers: this file used to run inside the popup's own document,
// so `document.getElementById` was always correct. Now it runs inside a
// shadow root injected into an arbitrary host page — memioRootRef (set by
// content.js once the shadow root exists) is queried instead, with
// `document` only as a pre-injection fallback so nothing throws.
//
// Deliberately a plain `var`, never `window.memioRootRef` — content scripts
// in the same manifest entry share one isolated-world global object, so a
// top-level `var` here is already visible to connectors.js/content.js
// without needing to touch the actual page `window`. Attaching this to
// `window` instead (as an earlier version did) would hand the host page's
// own scripts a live reference into the extension's shadow DOM, including
// every credential input's value the moment Settings/Connectors renders —
// on every site the extension is opened on, not just malicious ones the
// user might expect to be careful around.
var memioRootRef = null;
var memioHostRef = null;

function memioRoot() {
  return memioRootRef || document;
}
function memioQ(id) {
  return memioRoot().getElementById(id);
}
function memioQAll(selector) {
  return memioRoot().querySelectorAll(selector);
}
// Shadow DOM retargets event.target to the host element for listeners
// attached outside the shadow tree — composedPath()[0] gives the real
// innermost element regardless of where the listener lives.
function memioEventTarget(e) {
  return (e.composedPath && e.composedPath()[0]) || e.target;
}

const MEMIO_ACCENTS = [
  { name: 'yellow', label: 'Sand', swatchHex: '#FFB93E' },
  { name: 'green', label: 'Forest', swatchHex: '#4CAF50' },
  { name: 'coral', label: 'Coral', swatchHex: '#E8513A' },
  { name: 'blue', label: 'Ocean', swatchHex: '#2C5F8A' },
  { name: 'violet', label: 'Violet', swatchHex: '#7C3AED' },
  { name: 'gum', label: 'Gum', swatchHex: '#E8407A' }
];

const MEMIO_DEFAULT_ACCENT_NAME = 'yellow';

function applyAccentAndTheme(accentName, theme, colourMode) {
  const host = memioHostRef;
  if (!host) return;
  host.dataset.accent = accentName;
  if (theme === 'dark' || theme === 'light') {
    host.dataset.theme = theme;
  } else {
    delete host.dataset.theme;
  }
  if (colourMode === 'background') {
    host.dataset.colorMode = 'background';
  } else {
    delete host.dataset.colorMode;
  }
}

// Edges (Soft/Sharp) is independent of accent/theme/colour-mode, so it's
// applied via its own data attribute rather than folding into
// applyAccentAndTheme and touching every one of its call sites.
function applyEdges(edges) {
  const host = memioHostRef;
  if (!host) return;
  host.dataset.edges = edges === 'sharp' ? 'sharp' : 'soft';
}

async function getStoredThemeSettings() {
  const { memio_settings } = await chrome.storage.sync.get('memio_settings');
  return {
    accentName: (memio_settings && memio_settings.accentName) || MEMIO_DEFAULT_ACCENT_NAME,
    theme: (memio_settings && memio_settings.theme) || 'light',
    colourMode: (memio_settings && memio_settings.colourMode) || 'accent',
    edges: (memio_settings && memio_settings.edges) || 'soft',
    autoSendOnSave: !!(memio_settings && memio_settings.autoSendOnSave)
  };
}

async function patchThemeSettings(patch) {
  const { memio_settings } = await chrome.storage.sync.get('memio_settings');
  await chrome.storage.sync.set({ memio_settings: Object.assign({}, memio_settings, patch) });
}

function memioOpenSettingsOverlay() {
  const overlay = memioQ('settingsOverlay');
  if (overlay) overlay.hidden = false;
}

function memioCloseSettingsOverlay() {
  const overlay = memioQ('settingsOverlay');
  if (overlay) overlay.hidden = true;
}

function memioBuildSegmentedControl(host, options, activeValue, onSelect, disabledValues) {
  if (!host) return;
  host.innerHTML = '';
  const disabled = disabledValues || [];
  options.forEach(([value, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (value === activeValue) btn.classList.add('active');
    if (disabled.includes(value)) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', async () => {
        await onSelect(value);
        Array.from(host.children).forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
      });
    }
    host.appendChild(btn);
  });
}

// Background colour mode makes the accent colour the page background, and
// the foreground (text/icons) is fixed light-on-colour or dark-on-colour
// per accent (see the [data-color-mode='background'] CSS blocks) — Sand is
// light enough that it only reads correctly with dark foreground text,
// every other accent is dark enough that it only reads correctly with
// light foreground text. So unlike normal Accent mode, Light/Dark/System
// aren't a free choice here: force the one combination that actually reads
// correctly and disable the other, rather than letting someone pick a
// combination that comes out illegible. Called on initial render and again
// whenever the accent or colour mode changes.
async function renderThemeToggle(themeHost) {
  const { accentName, theme, colourMode } = await getStoredThemeSettings();

  if (colourMode !== 'background') {
    memioBuildSegmentedControl(
      themeHost,
      [
        ['dark', 'Dark'],
        ['light', 'Light'],
        ['system', 'System']
      ],
      theme,
      async (value) => {
        await patchThemeSettings({ theme: value });
        const current = await getStoredThemeSettings();
        applyAccentAndTheme(current.accentName, current.theme, current.colourMode);
      }
    );
    return;
  }

  const forcedTheme = accentName === 'yellow' ? 'dark' : 'light';
  if (theme !== forcedTheme) {
    await patchThemeSettings({ theme: forcedTheme });
    const current = await getStoredThemeSettings();
    applyAccentAndTheme(current.accentName, current.theme, current.colourMode);
  }

  memioBuildSegmentedControl(
    themeHost,
    [
      ['dark', 'Dark'],
      ['light', 'Light']
    ],
    forcedTheme,
    async (value) => {
      await patchThemeSettings({ theme: value });
      const current = await getStoredThemeSettings();
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode);
    },
    [forcedTheme === 'dark' ? 'light' : 'dark']
  );
}

async function initSettingsPanel() {
  const { accentName, theme, colourMode, edges, autoSendOnSave } = await getStoredThemeSettings();
  applyAccentAndTheme(accentName, theme, colourMode);
  applyEdges(edges);

  const swatchContainer = memioQ('swatches');
  const colourModeHost = memioQ('colourModeToggle');
  const themeHost = memioQ('themeToggle');
  const edgesHost = memioQ('edgesToggle');
  const autoSendToggle = memioQ('autoSendToggle');
  const settingsBtn = memioQ('settingsBtn');
  const overlay = memioQ('settingsOverlay');
  const closeBtn = memioQ('closeSettingsBtn');

  if (autoSendToggle) {
    autoSendToggle.checked = autoSendOnSave;
    autoSendToggle.addEventListener('change', async () => {
      await patchThemeSettings({ autoSendOnSave: autoSendToggle.checked });
    });
  }

  if (swatchContainer) {
    swatchContainer.innerHTML = '';
    MEMIO_ACCENTS.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'swatch-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.style.backgroundColor = a.swatchHex;
      btn.title = a.label;
      btn.setAttribute('aria-label', a.label);
      if (a.name === accentName) btn.classList.add('active');
      btn.addEventListener('click', async () => {
        await patchThemeSettings({ accentName: a.name });
        const current = await getStoredThemeSettings();
        applyAccentAndTheme(current.accentName, current.theme, current.colourMode);
        Array.from(swatchContainer.querySelectorAll('.swatch')).forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        // Background mode's forced Light/Dark pairing depends on which
        // accent is selected (see renderThemeToggle) — re-evaluate it.
        await renderThemeToggle(themeHost);
      });

      const swatchLabel = document.createElement('span');
      swatchLabel.className = 'swatch-label';
      swatchLabel.textContent = a.label;

      item.appendChild(btn);
      item.appendChild(swatchLabel);
      swatchContainer.appendChild(item);
    });
  }

  await renderThemeToggle(themeHost);

  memioBuildSegmentedControl(
    colourModeHost,
    [
      ['accent', 'Accent'],
      ['background', 'Background']
    ],
    colourMode,
    async (value) => {
      await patchThemeSettings({ colourMode: value });
      const current = await getStoredThemeSettings();
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode);
      // Switching into/out of Background mode changes whether Light/Dark/
      // System is a free choice or a forced pairing — re-evaluate it.
      await renderThemeToggle(themeHost);
    }
  );

  memioBuildSegmentedControl(
    edgesHost,
    [
      ['soft', 'Soft'],
      ['sharp', 'Sharp']
    ],
    edges,
    async (value) => {
      await patchThemeSettings({ edges: value });
      applyEdges(value);
    }
  );

  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      memioOpenSettingsOverlay();
      // Re-read everything fresh from storage every time Settings opens —
      // the Connectors tab (and Configure, if it's the active tab) was
      // otherwise only ever rendered once at window creation, so edits
      // made in another tab/session wouldn't show up until something else
      // happened to trigger a re-render.
      await memioRenderConnectorSections();
      const configureSection = memioQ('configureSections');
      if (configureSection) await memioRenderConfigureSections(configureSection);
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', memioCloseSettingsOverlay);
  }
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (memioEventTarget(e) === overlay) memioCloseSettingsOverlay();
    });
  }
}
