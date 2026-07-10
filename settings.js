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
// Used by the custom-colour editor's Hue/Saturation sliders — lightness is
// fixed at 50% there (only two sliders, per the design), so this only ever
// needs to go from (h, s, 50) to rgb, not the general case.
function memioHslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = s / 100;
  const ll = l / 100;
  if (ss === 0) {
    const v = ll * 255;
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue2rgb = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: hue2rgb(hh + 1 / 3) * 255,
    g: hue2rgb(hh) * 255,
    b: hue2rgb(hh - 1 / 3) * 255
  };
}
// Inverse of the above, used when the RGB fields are edited directly so the
// Hue/Saturation sliders can be kept roughly in sync. Lightness is computed
// but deliberately not fed back into a third slider (there isn't one) — the
// sliders always operate at 50% lightness regardless of what an RGB edit's
// actual lightness was, which is the accepted trade-off of only having two
// sliders rather than a full 3-axis picker.
function memioRgbToHueSat(r, g, b) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case rr:
      h = (gg - bb) / d + (gg < bb ? 6 : 0);
      break;
    case gg:
      h = (bb - rr) / d + 2;
      break;
    default:
      h = (rr - gg) / d + 4;
  }
  return { h: (h / 6) * 360, s: s * 100 };
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

  const customColorEditor = memioQ('customColorEditor');

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
        if (customColorEditor) customColorEditor.hidden = true;
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

    // Custom accent — a small in-panel picker (Hue + Saturation sliders,
    // RGB fields) rather than the native <input type="color"> popup this
    // used to be. That native picker turned out to have real bugs here on
    // top of the input-flood issue already fixed once: dragging its wheel
    // could flip the page's own light/dark theme mid-drag, and the swatch
    // could end up permanently stuck after a few picks — behaviour that
    // traces back into the OS-level picker/focus handling, outside
    // anything this code actually controls. A picker built entirely from
    // our own inputs sidesteps that whole class of bug, at the cost of the
    // OS picker's eyedropper/palettes/wheel UI.
    const customItem = document.createElement('div');
    customItem.className = 'swatch-item';

    const customSwatch = document.createElement('button');
    customSwatch.type = 'button';
    customSwatch.className = 'swatch swatch-custom';
    customSwatch.title = 'Custom';
    customSwatch.setAttribute('aria-label', 'Custom colour');
    // Once a custom colour has been picked, show it (like every named
    // swatch always shows its colour) rather than reverting to the "pick
    // one" rainbow the moment a different accent becomes active.
    if (customAccentHex) customSwatch.style.background = customAccentHex;
    if (accentName === 'custom') customSwatch.classList.add('active');

    const customLabel = document.createElement('span');
    customLabel.className = 'swatch-label';
    customLabel.textContent = 'Custom';

    customItem.appendChild(customSwatch);
    customItem.appendChild(customLabel);
    swatchContainer.appendChild(customItem);

    if (customColorEditor) {
      customColorEditor.innerHTML = '';
      customColorEditor.hidden = accentName !== 'custom';

      const makeField = (groupClass, inputClass, labelText, type, min, max, value) => {
        const group = document.createElement('div');
        group.className = groupClass;
        const label = document.createElement('label');
        label.className = 'color-field-label';
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = type;
        input.min = String(min);
        input.max = String(max);
        input.value = String(Math.round(value));
        input.className = inputClass;
        group.appendChild(label);
        group.appendChild(input);
        return { group, input };
      };

      const startHex = customAccentHex || MEMIO_DEFAULT_CUSTOM_ACCENT;
      const startRgb = memioHexToRgb(startHex);
      const startHueSat = memioRgbToHueSat(startRgb.r, startRgb.g, startRgb.b);

      const slidersRow = document.createElement('div');
      slidersRow.className = 'color-sliders-row';
      const hue = makeField('color-slider-group', 'color-slider hue-slider', 'Hue', 'range', 0, 360, startHueSat.h);
      const sat = makeField('color-slider-group', 'color-slider sat-slider', 'Saturation', 'range', 0, 100, startHueSat.s);
      slidersRow.appendChild(hue.group);
      slidersRow.appendChild(sat.group);

      const rgbRow = document.createElement('div');
      rgbRow.className = 'color-rgb-row';
      const rField = makeField('rgb-field-group', 'rgb-field', 'R', 'number', 0, 255, startRgb.r);
      const gField = makeField('rgb-field-group', 'rgb-field', 'G', 'number', 0, 255, startRgb.g);
      const bField = makeField('rgb-field-group', 'rgb-field', 'B', 'number', 0, 255, startRgb.b);
      rgbRow.appendChild(rField.group);
      rgbRow.appendChild(gField.group);
      rgbRow.appendChild(bField.group);

      customColorEditor.appendChild(slidersRow);
      customColorEditor.appendChild(rgbRow);

      // The saturation slider's track shows grey-to-full-colour at the
      // *current* hue, so it visually previews what dragging it will do.
      const updateSatTrack = () => {
        sat.input.style.setProperty('--sat-track-end', `hsl(${hue.input.value}, 100%, 50%)`);
      };
      updateSatTrack();

      // Cheap, synchronous preview on every drag/keystroke tick — no
      // storage write, no DOM rebuild. See the block comment above for why
      // that split matters (it's what the native picker got wrong).
      const previewFromHueSat = () => {
        const rgb = memioHslToRgb(Number(hue.input.value), Number(sat.input.value), 50);
        rField.input.value = String(Math.round(rgb.r));
        gField.input.value = String(Math.round(rgb.g));
        bField.input.value = String(Math.round(rgb.b));
        const hex = memioRgbToHex(rgb.r, rgb.g, rgb.b);
        customSwatch.style.background = hex;
        applyAccentAndTheme('custom', theme, colourMode, hex);
        updateSatTrack();
        return hex;
      };
      const previewFromRgbFields = () => {
        const r = Math.max(0, Math.min(255, Number(rField.input.value) || 0));
        const g = Math.max(0, Math.min(255, Number(gField.input.value) || 0));
        const b = Math.max(0, Math.min(255, Number(bField.input.value) || 0));
        const { h, s } = memioRgbToHueSat(r, g, b);
        hue.input.value = String(Math.round(h));
        sat.input.value = String(Math.round(s));
        updateSatTrack();
        const hex = memioRgbToHex(r, g, b);
        customSwatch.style.background = hex;
        applyAccentAndTheme('custom', theme, colourMode, hex);
        return hex;
      };
      const commit = async (hex) => {
        await patchThemeSettings({ accentName: 'custom', customAccentHex: hex });
        const current = await getStoredThemeSettings();
        applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
        Array.from(swatchContainer.querySelectorAll('.swatch')).forEach((c) => c.classList.remove('active'));
        customSwatch.classList.add('active');
        // Background mode's forced Light/Dark pairing depends on which
        // accent is selected (see renderThemeToggle) — re-evaluate it.
        await renderThemeToggle(themeHost);
      };

      [hue.input, sat.input].forEach((input) => {
        input.addEventListener('input', previewFromHueSat);
        input.addEventListener('change', () => commit(previewFromHueSat()));
      });
      [rField.input, gField.input, bField.input].forEach((input) => {
        input.addEventListener('input', previewFromRgbFields);
        input.addEventListener('change', () => commit(previewFromRgbFields()));
      });
    }

    customSwatch.addEventListener('click', async () => {
      if (customColorEditor) customColorEditor.hidden = false;
      if (customSwatch.classList.contains('active')) return;
      await patchThemeSettings({ accentName: 'custom' });
      const current = await getStoredThemeSettings();
      applyAccentAndTheme(current.accentName, current.theme, current.colourMode, current.customAccentHex);
      Array.from(swatchContainer.querySelectorAll('.swatch')).forEach((c) => c.classList.remove('active'));
      customSwatch.classList.add('active');
      // Background mode's forced Light/Dark pairing depends on which
      // accent is selected (see renderThemeToggle) — re-evaluate it.
      await renderThemeToggle(themeHost);
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
