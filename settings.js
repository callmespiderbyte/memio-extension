// Colour is now owned entirely by styles.css's design tokens. This file's
// only job is: (1) persist the user's accentName/theme choice, and (2) set
// data-accent / data-theme on the shadow host so the right
// :host([data-accent="..."]) / :host([data-theme="..."]) CSS rules take
// over. No hex math happens here anymore.
//
// Root-query helpers: this file used to run inside the popup's own document,
// so `document.getElementById` was always correct. Now it runs inside a
// shadow root injected into an arbitrary host page — window.__memioRoot
// (set by content.js once the shadow root exists) is queried instead, with
// `document` only as a pre-injection fallback so nothing throws.
function memioRoot() {
  return window.__memioRoot || document;
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
  { name: 'yellow', label: 'Sand', swatchHex: '#F5C518' },
  { name: 'green', label: 'Forest', swatchHex: '#4CAF50' },
  { name: 'coral', label: 'Coral', swatchHex: '#E8513A' },
  { name: 'blue', label: 'Ocean', swatchHex: '#2C5F8A' },
  { name: 'violet', label: 'Violet', swatchHex: '#7C3AED' },
  { name: 'gum', label: 'Gum', swatchHex: '#E8407A' }
];

const MEMIO_DEFAULT_ACCENT_NAME = 'yellow';

function applyAccentAndTheme(accentName, theme, colourMode) {
  const host = window.__memioHost;
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

async function getStoredThemeSettings() {
  const { memio_settings } = await chrome.storage.sync.get('memio_settings');
  return {
    accentName: (memio_settings && memio_settings.accentName) || MEMIO_DEFAULT_ACCENT_NAME,
    theme: (memio_settings && memio_settings.theme) || 'system',
    colourMode: (memio_settings && memio_settings.colourMode) || 'accent',
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

function memioBuildSegmentedControl(host, options, activeValue, onSelect) {
  if (!host) return;
  host.innerHTML = '';
  options.forEach(([value, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (value === activeValue) btn.classList.add('active');
    btn.addEventListener('click', async () => {
      await onSelect(value);
      Array.from(host.children).forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
    });
    host.appendChild(btn);
  });
}

async function initSettingsPanel() {
  const { accentName, theme, colourMode, autoSendOnSave } = await getStoredThemeSettings();
  applyAccentAndTheme(accentName, theme, colourMode);

  const swatchContainer = memioQ('swatches');
  const colourModeHost = memioQ('colourModeToggle');
  const themeHost = memioQ('themeToggle');
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
      });

      const swatchLabel = document.createElement('span');
      swatchLabel.className = 'swatch-label';
      swatchLabel.textContent = a.label;

      item.appendChild(btn);
      item.appendChild(swatchLabel);
      swatchContainer.appendChild(item);
    });
  }

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
