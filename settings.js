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
const MEMIO_DEFAULT_CUSTOM_ACCENT = '#FFB93E';

// Every named accent above has its tokens hand-tuned directly in
// styles.css (separate hex per light/dark, per hover/subtle/focus state —
// see the design-tokens block at the top of that file). A user-picked
// custom colour has no such stylesheet counterpart, so — unlike every
// other accent — it genuinely needs hex math done in JS, computed once
// per pick and applied as inline custom properties (which win over any
// stylesheet rule, named-accent or otherwise, without needing !important).
function memioHexToRgb(hex) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const bigint = parseInt(full, 16) || 0;
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}
function memioRgbToHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}
function memioMixWithBlack(hex, amount) {
  const { r, g, b } = memioHexToRgb(hex);
  return memioRgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}
function memioRelativeLuminance(hex) {
  const { r, g, b } = memioHexToRgb(hex);
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}
function memioContrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
// WCAG-style: pick whichever of black/white text actually contrasts better
// against the picked colour, rather than a fixed lightness cutoff — holds up
// for saturated mid-tones (e.g. pure red) that a simple threshold misreads.
function memioContrastTextColor(hex) {
  const lum = memioRelativeLuminance(hex);
  return memioContrastRatio(lum, 0) >= memioContrastRatio(lum, 1) ? '#1A1A1A' : '#FFFFFF';
}

// Sets/clears the inline custom-property overrides a custom accent needs.
// Only [data-color-mode='background'] vs the default "accent" mode changes
// which properties should carry the custom hue — see the comment above
// styles.css's "Background colour mode" block: in background mode, accent/
// text/border tokens are fixed neutrals for every accent (named or custom),
// and only --bg-base carries the hue, so setting --accent inline there
// would incorrectly fight that neutral treatment.
function memioApplyCustomAccentVars(host, hex, colourMode) {
  const isBackground = colourMode === 'background';
  if (isBackground) {
    host.style.setProperty('--bg-base', hex);
    host.style.removeProperty('--accent');
    host.style.removeProperty('--accent-hover');
    host.style.removeProperty('--accent-subtle');
    host.style.removeProperty('--accent-focus');
    host.style.removeProperty('--accent-text');
  } else {
    host.style.removeProperty('--bg-base');
    const { r, g, b } = memioHexToRgb(hex);
    host.style.setProperty('--accent', hex);
    host.style.setProperty('--accent-hover', memioMixWithBlack(hex, 0.12));
    host.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.12)`);
    host.style.setProperty('--accent-focus', `rgba(${r}, ${g}, ${b}, 0.35)`);
    host.style.setProperty('--accent-text', memioContrastTextColor(hex));
  }
}

function memioClearCustomAccentVars(host) {
  ['--bg-base', '--accent', '--accent-hover', '--accent-subtle', '--accent-focus', '--accent-text'].forEach((prop) =>
    host.style.removeProperty(prop)
  );
}

function applyAccentAndTheme(accentName, theme, colourMode, customAccentHex) {
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
  if (accentName === 'custom') {
    memioApplyCustomAccentVars(host, customAccentHex || MEMIO_DEFAULT_CUSTOM_ACCENT, colourMode);
  } else {
    memioClearCustomAccentVars(host);
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
    autoSendOnSave: !!(memio_settings && memio_settings.autoSendOnSave),
    // No fallback to MEMIO_DEFAULT_CUSTOM_ACCENT here on purpose — null
    // means "never picked one," which the swatch UI uses to decide whether
    // to show the rainbow "pick one" gradient or the actual last pick.
    customAccentHex: (memio_settings && memio_settings.customAccentHex) || null
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
        applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
      }
    );
    return;
  }

  const forcedTheme = accentName === 'yellow' ? 'dark' : 'light';
  if (theme !== forcedTheme) {
    await patchThemeSettings({ theme: forcedTheme });
    const current = await getStoredThemeSettings();
    applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
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
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
    },
    [forcedTheme === 'dark' ? 'light' : 'dark']
  );
}

async function initSettingsPanel() {
  const { accentName, theme, colourMode, edges, autoSendOnSave, customAccentHex } = await getStoredThemeSettings();
  applyAccentAndTheme(accentName, theme, colourMode, customAccentHex);
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
        applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
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

    // Custom accent — a colour input laid transparently over a decorative
    // swatch button so clicking anywhere in the swatch opens the browser's
    // native colour picker (a wheel/spectrum picker on most platforms)
    // directly, no synthetic .click() forwarding needed.
    const customItem = document.createElement('div');
    customItem.className = 'swatch-item';

    const customWrap = document.createElement('div');
    customWrap.className = 'swatch-wrap';

    const customSwatch = document.createElement('div');
    customSwatch.className = 'swatch swatch-custom';
    // Once a custom colour has been picked, show it (like every named
    // swatch always shows its colour) rather than reverting to the "pick
    // one" rainbow the moment a different accent becomes active.
    if (customAccentHex) customSwatch.style.background = customAccentHex;
    if (accentName === 'custom') customSwatch.classList.add('active');

    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.className = 'custom-accent-input';
    customInput.value = customAccentHex || MEMIO_DEFAULT_CUSTOM_ACCENT;
    customInput.setAttribute('aria-label', 'Custom accent colour');
    // "input" fires continuously while the picker is open — every pixel of
    // wheel/slider drag, not just on release. Doing the full persist +
    // rebuild on every tick flooded chrome.storage.sync's write quota and
    // tore down/rebuilt the theme-toggle buttons out from under the user's
    // cursor mid-drag, which is what made the panel seem to "get stuck" and
    // stop responding to clicks. So: cheap, synchronous live preview on
    // every "input" tick, and the actual persist + rebuild only on "change"
    // (fires once, when a colour is committed).
    customInput.addEventListener('input', () => {
      const hex = customInput.value;
      customSwatch.style.background = hex;
      applyAccentAndTheme('custom', theme, colourMode, hex);
    });
    customInput.addEventListener('change', async () => {
      const hex = customInput.value;
      customSwatch.style.background = hex;
      await patchThemeSettings({ accentName: 'custom', customAccentHex: hex });
      const current = await getStoredThemeSettings();
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
      Array.from(swatchContainer.querySelectorAll('.swatch')).forEach((c) => c.classList.remove('active'));
      customSwatch.classList.add('active');
      // Background mode's forced Light/Dark pairing depends on which
      // accent is selected (see renderThemeToggle) — re-evaluate it.
      await renderThemeToggle(themeHost);
    });
    // Safety net: if the picker is dismissed without committing (e.g. Esc),
    // "change" never fires and the live preview from "input" above would
    // otherwise be left showing a colour that was never actually saved —
    // re-sync from what's actually in storage once the input loses focus.
    customInput.addEventListener('blur', async () => {
      const current = await getStoredThemeSettings();
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
      customInput.value = current.customAccentHex || MEMIO_DEFAULT_CUSTOM_ACCENT;
      if (current.customAccentHex) customSwatch.style.background = current.customAccentHex;
    });

    customWrap.appendChild(customSwatch);
    customWrap.appendChild(customInput);

    const customLabel = document.createElement('span');
    customLabel.className = 'swatch-label';
    customLabel.textContent = 'Custom';

    customItem.appendChild(customWrap);
    customItem.appendChild(customLabel);
    swatchContainer.appendChild(customItem);
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
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
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
