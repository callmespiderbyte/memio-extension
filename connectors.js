const MEMIO_CONNECTORS_KEY = 'connectors';

// Credentials live in chrome.storage.local, never .sync — sync replicates
// data to every Chrome install signed into the same Google account, which
// is a much bigger blast radius than these API keys/tokens need. Everything
// else (folders, tag rules, collation, enabled flags) stays in sync since
// there's no secrecy concern and cross-device convenience is worth it.
//
// Obsidian and Notion support multiple named instances (e.g. two Obsidian
// vaults) — connectors.obsidian/.notion are arrays of instance objects, each
// with its own id ("obsidian_1", "obsidian_2", ...). Credentials for those
// live in connectors_secrets keyed by INSTANCE id, not connector type.
// Google Drive and AI stay single-instance (plain objects), keyed by their
// own connector id as before.
const MEMIO_SECRETS_KEY = 'connectors_secrets';
const MEMIO_SECRET_FIELDS = {
  obsidian: ['apiKey'],
  notion: ['token'],
  drive: ['apiKey'],
  ai: ['apiKey']
};

const MEMIO_MULTI_INSTANCE_TYPES = ['obsidian', 'notion'];
const MEMIO_MAX_INSTANCES = 5;
// Used for numbering newly-added instances ("Obsidian 2", "Notion 2") — kept
// separate from MEMIO_DEFAULT_INSTANCE_NAMES below, which only names the
// original always-default instance, so added instances don't inherit the
// "_Default" suffix.
const MEMIO_TYPE_LABELS = { obsidian: 'Obsidian', notion: 'Notion' };
const MEMIO_DEFAULT_INSTANCE_NAMES = { obsidian: 'Obsidian_Default', notion: 'Notion_Default' };

const MEMIO_CONNECTOR_DEFAULTS = {
  obsidian: [
    { id: 'obsidian_1', name: MEMIO_DEFAULT_INSTANCE_NAMES.obsidian, enabled: false, isDefault: true, folders: [], tagRules: [], collation: 'individual' }
  ],
  notion: [
    { id: 'notion_1', name: MEMIO_DEFAULT_INSTANCE_NAMES.notion, enabled: false, isDefault: true, pages: [], tagRules: [], collation: 'individual' }
  ],
  drive: { enabled: false, apiKey: '', folderId: '' },
  ai: { enabled: false, provider: 'claude', apiKey: '' }
};

function memioIsMultiInstance(typeId) {
  return MEMIO_MULTI_INSTANCE_TYPES.includes(typeId);
}

const MEMIO_AI_PROVIDERS = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'ChatGPT (OpenAI)' },
  { id: 'gemini', label: 'Gemini (Google)' }
];

// Model IDs are named constants for a reason: providers deprecate/rename
// lightweight models fairly often. If title generation starts failing with
// a 404/model-not-found, this is the first place to check.
const MEMIO_AI_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash-lite'
};

const MEMIO_CONNECTOR_DEFS = [
  {
    id: 'obsidian',
    name: 'Obsidian',
    instanceNoun: 'Vault',
    title: 'Connect Obsidian',
    intro: "You'll need the Local REST API community plugin installed in Obsidian.",
    steps: [
      'Open Obsidian',
      'Go to Settings → Community Plugins → Browse',
      'Search "Local REST API" → Install → Enable',
      'In the plugin settings, turn on "Enable Non-encrypted (HTTP) Server" — it\'s off by default',
      'In the plugin settings, copy your API Key (paste just the key — no "Bearer " prefix)',
      'Paste it below',
      'Make sure Obsidian is open when sending memos'
    ],
    note:
      "Connecting a second vault? Each running vault's Local REST API server needs its own port — change it in that vault's plugin settings (default is 27123) and enter the matching port below, or both vaults will fight over the same port and one will fail to send.",
    fields: [
      { key: 'apiKey', type: 'password', placeholder: 'API key' },
      { key: 'port', type: 'text', placeholder: 'Port (default 27123)' }
    ],
    destinationsKey: 'folders',
    destinationNoun: 'folder',
    destinationNounPlural: 'folders',
    destinationsLabel: 'FOLDERS',
    destinationsSubline: 'The first folder is your default. Add more to choose a destination when sending.',
    addLabel: '+ Add folder',
    addPlaceholder: '/memos/design',
    routingSubline:
      "Route memos to a folder based on a single tag. If a memo has multiple tags, the first matching rule wins — so if 'design' routes to /design and 'book' routes to /book, a memo tagged both goes to /design. Unmatched memos go to your default folder.",
    routingDefaultLabel: 'your default folder'
  },
  {
    id: 'notion',
    name: 'Notion',
    instanceNoun: 'Workspace',
    title: 'Connect Notion',
    intro: "You'll need to create a Notion integration and share a database with it.",
    steps: [
      'Go to notion.so/my-integrations',
      'Click "New integration" → give it a name → Submit',
      'Copy the "Internal Integration Token"',
      'Paste it below',
      'Open or create a Notion page or database where memos will be saved.',
      'Click the "..." menu top right → Connections → select your integration',
      'Add it under Pages & Databases below, using its Page or Database ID from the URL: notion.so/Your-Page-{THIS-IS-THE-ID}',
      'Paste it below'
    ],
    fields: [{ key: 'token', type: 'password', placeholder: 'Integration token' }],
    destinationsKey: 'pages',
    destinationNoun: 'page or database',
    destinationNounPlural: 'pages or databases',
    destinationsLabel: 'PAGES & DATABASES',
    destinationsSubline: 'The first item is your default. Add more to choose a destination when sending.',
    addLabel: '+ Add page or database',
    addPlaceholder: 'Paste Page or Database ID',
    routingSubline:
      "Route memos to a folder based on a single tag. If a memo has multiple tags, the first matching rule wins — so if 'design' routes to /design and 'book' routes to /book, a memo tagged both goes to /design. Unmatched memos go to your default folder.",
    routingDefaultLabel: 'your default page'
  },
  {
    id: 'drive',
    name: 'Google Drive',
    comingSoon: true,
    comingSoonMessage: 'Google Drive requires account connection — coming in a future update.'
  }
];

// Guards the one-time migration below so it only ever writes once per page
// load, not on every memioGetConnectors() call (this function runs
// constantly — on every render, every send).
let memioMigrationDone = false;

// Folds together every migration this connector schema has ever needed:
// folderPath/pageId → folders/pages (pre-multi-destination), credentials
// sync → local (pre-secrets-split), and single-object → array-of-instances
// (this feature). Each only actually does anything if the OLD shape is
// still found, so re-running this against already-migrated data is a
// harmless no-op.
async function memioMigrateConnectorStorage() {
  if (memioMigrationDone) return;
  memioMigrationDone = true;

  const { connectors } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  if (!connectors) return;
  const { connectors_secrets } = await chrome.storage.local.get(MEMIO_SECRETS_KEY);

  let syncChanged = false;
  let secretsChanged = false;
  const newConnectors = Object.assign({}, connectors);
  const newSecrets = Object.assign({}, connectors_secrets);

  MEMIO_MULTI_INSTANCE_TYPES.forEach((typeId) => {
    const existing = connectors[typeId];
    if (Array.isArray(existing)) return; // already on the instances schema

    const old = existing || {};
    const secretField = MEMIO_SECRET_FIELDS[typeId][0];
    const instanceId = `${typeId}_1`;
    const destKey = typeId === 'obsidian' ? 'folders' : 'pages';

    const instance = {
      id: instanceId,
      name: MEMIO_DEFAULT_INSTANCE_NAMES[typeId],
      enabled: !!old.enabled,
      isDefault: true,
      tagRules: old.tagRules || [],
      collation: old.collation || 'individual',
      [destKey]: old[destKey] || []
    };

    if (typeId === 'obsidian' && old.folderPath && instance.folders.length === 0) {
      instance.folders = [old.folderPath];
    }
    if (typeId === 'notion' && old.pageId && instance.pages.length === 0) {
      instance.pages = [{ id: old.pageId, title: 'Default', type: 'database' }];
    }

    // The secret could be sitting in the old sync object (pre secrets-split)
    // or already in connectors_secrets[typeId] (post secrets-split, pre
    // instances) — check both, land it on connectors_secrets[instanceId].
    const secretValue = (connectors_secrets && connectors_secrets[typeId] && connectors_secrets[typeId][secretField]) || old[secretField];
    if (secretValue) {
      newSecrets[instanceId] = Object.assign({}, newSecrets[instanceId], { [secretField]: secretValue });
      secretsChanged = true;
    }
    delete newSecrets[typeId];

    newConnectors[typeId] = [instance];
    syncChanged = true;
  });

  if (syncChanged) await chrome.storage.sync.set({ connectors: newConnectors });
  if (secretsChanged) await chrome.storage.local.set({ connectors_secrets: newSecrets });
}

// Defensive normalization for the "exactly one default at all times"
// invariant — mutates the given in-memory array (read-time only; doesn't
// persist). Every write path (add/remove/setDefault) is also responsible
// for maintaining this correctly, so this is a safety net for state that
// predates the invariant, not the primary enforcement mechanism.
function memioEnsureSingleDefault(instances) {
  if (!instances.length) return;
  if (instances.filter((i) => i.isDefault).length === 1) return;
  instances.forEach((inst, idx) => {
    inst.isDefault = idx === 0;
  });
}

async function memioGetConnectors() {
  await memioMigrateConnectorStorage();

  const { connectors } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  const { connectors_secrets } = await chrome.storage.local.get(MEMIO_SECRETS_KEY);

  const merged = {};
  Object.keys(MEMIO_CONNECTOR_DEFAULTS).forEach((typeId) => {
    if (memioIsMultiInstance(typeId)) {
      const destKey = typeId === 'obsidian' ? 'folders' : 'pages';
      const stored = Array.isArray(connectors && connectors[typeId]) ? connectors[typeId] : MEMIO_CONNECTOR_DEFAULTS[typeId];
      merged[typeId] = stored.map((inst) =>
        Object.assign(
          { enabled: false, isDefault: false, tagRules: [], collation: 'individual', [destKey]: [] },
          inst,
          connectors_secrets && connectors_secrets[inst.id]
        )
      );
      memioEnsureSingleDefault(merged[typeId]);
    } else {
      merged[typeId] = Object.assign(
        {},
        MEMIO_CONNECTOR_DEFAULTS[typeId],
        connectors && connectors[typeId],
        connectors_secrets && connectors_secrets[typeId]
      );
    }
  });

  return merged;
}

// Single-instance connectors only (drive, ai) — obsidian/notion go through
// memioPatchConnectorInstance below.
async function memioPatchConnector(id, patch) {
  const connectors = await memioGetConnectors();
  connectors[id] = Object.assign({}, connectors[id], patch);

  const secretFields = MEMIO_SECRET_FIELDS[id] || [];
  const syncEntry = Object.assign({}, connectors[id]);
  const secretEntry = {};
  secretFields.forEach((field) => {
    secretEntry[field] = syncEntry[field];
    delete syncEntry[field];
  });

  const { connectors: currentSync } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  await chrome.storage.sync.set({ connectors: Object.assign({}, currentSync, { [id]: syncEntry }) });

  if (secretFields.length) {
    const { connectors_secrets } = await chrome.storage.local.get(MEMIO_SECRETS_KEY);
    await chrome.storage.local.set({
      connectors_secrets: Object.assign({}, connectors_secrets, { [id]: secretEntry })
    });
  }

  return connectors;
}

async function memioPatchConnectorInstance(typeId, instanceId, patch) {
  const connectors = await memioGetConnectors();
  const instances = connectors[typeId] || [];
  const idx = instances.findIndex((i) => i.id === instanceId);
  if (idx === -1) return connectors;

  const updated = Object.assign({}, instances[idx], patch);
  const secretField = MEMIO_SECRET_FIELDS[typeId][0];
  const syncInstance = Object.assign({}, updated);
  const secretValue = syncInstance[secretField];
  delete syncInstance[secretField];

  const updatedInstances = instances.slice();
  updatedInstances[idx] = syncInstance;

  const { connectors: currentSync } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  await chrome.storage.sync.set({ connectors: Object.assign({}, currentSync, { [typeId]: updatedInstances }) });

  if (secretValue !== undefined) {
    const { connectors_secrets } = await chrome.storage.local.get(MEMIO_SECRETS_KEY);
    await chrome.storage.local.set({
      connectors_secrets: Object.assign({}, connectors_secrets, {
        [instanceId]: Object.assign({}, connectors_secrets && connectors_secrets[instanceId], { [secretField]: secretValue })
      })
    });
  }

  return memioGetConnectors();
}

// Next instance number always increments past the highest ever used for
// this type, rather than reusing a freed number from a deleted instance —
// simpler and avoids any chance of a stale reference elsewhere resolving to
// the wrong (recreated) instance.
async function memioAddConnectorInstance(typeId) {
  const connectors = await memioGetConnectors();
  const instances = connectors[typeId] || [];
  if (instances.length >= MEMIO_MAX_INSTANCES) return null;

  const usedNumbers = instances.map((inst) => {
    const match = /_(\d+)$/.exec(inst.id);
    return match ? Number(match[1]) : 0;
  });
  const nextNumber = usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1;
  const instanceId = `${typeId}_${nextNumber}`;
  const destKey = typeId === 'obsidian' ? 'folders' : 'pages';

  const newInstance = {
    id: instanceId,
    name: `${MEMIO_TYPE_LABELS[typeId]} ${nextNumber}`,
    enabled: false,
    isDefault: instances.length === 0,
    tagRules: [],
    collation: 'individual',
    [destKey]: []
  };

  const updated = instances.concat([newInstance]);
  const { connectors: currentSync } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  await chrome.storage.sync.set({ connectors: Object.assign({}, currentSync, { [typeId]: updated }) });

  return instanceId;
}

// Cannot delete the only instance of a type. Deleting the default instance
// auto-promotes the next remaining one first.
async function memioRemoveConnectorInstance(typeId, instanceId) {
  const connectors = await memioGetConnectors();
  const instances = connectors[typeId] || [];
  if (instances.length <= 1) return false;

  const removing = instances.find((i) => i.id === instanceId);
  if (!removing) return false;

  const remaining = instances.filter((i) => i.id !== instanceId);
  if (removing.isDefault && remaining.length) remaining[0].isDefault = true;

  const { connectors: currentSync } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  await chrome.storage.sync.set({ connectors: Object.assign({}, currentSync, { [typeId]: remaining }) });

  const { connectors_secrets } = await chrome.storage.local.get(MEMIO_SECRETS_KEY);
  if (connectors_secrets && connectors_secrets[instanceId]) {
    const updatedSecrets = Object.assign({}, connectors_secrets);
    delete updatedSecrets[instanceId];
    await chrome.storage.local.set({ connectors_secrets: updatedSecrets });
  }

  return true;
}

async function memioSetDefaultInstance(typeId, instanceId) {
  const connectors = await memioGetConnectors();
  const instances = (connectors[typeId] || []).map((inst) => Object.assign({}, inst, { isDefault: inst.id === instanceId }));

  const { connectors: currentSync } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  await chrome.storage.sync.set({ connectors: Object.assign({}, currentSync, { [typeId]: instances }) });
}

// Every enabled instance across both connector types, flattened into one
// list — used by the Send to/Send all to popovers, where the user picks
// any enabled destination (not just the default).
async function memioGetEnabledConnectors() {
  const connectors = await memioGetConnectors();
  const result = [];
  MEMIO_MULTI_INSTANCE_TYPES.forEach((typeId) => {
    (connectors[typeId] || []).forEach((inst) => {
      if (inst.enabled) result.push({ id: inst.id, typeId, name: inst.name });
    });
  });
  return result;
}

// Auto-send only ever targets the default instance per type (see PART 7) —
// deliberately narrower than memioGetEnabledConnectors above.
async function memioGetDefaultEnabledConnectors() {
  const connectors = await memioGetConnectors();
  const result = [];
  MEMIO_MULTI_INSTANCE_TYPES.forEach((typeId) => {
    const def = (connectors[typeId] || []).find((inst) => inst.isDefault);
    if (def && def.enabled) result.push({ id: def.id, typeId, name: def.name });
  });
  return result;
}

function memioGetConnectorName(id) {
  const def = MEMIO_CONNECTOR_DEFS.find((d) => d.id === id);
  return def ? def.name : id;
}

function memioPadNum(n) {
  return String(n).padStart(2, '0');
}

// Prefers the memo's own (human- or AI-authored) title — never a raw
// content excerpt. Falls back to a date/time stamp only for older memos
// saved before the title field existed. `context.scopeLabel`, when present
// (bulk sends only), notes which filters were active so a batch of memos
// stays distinguishable from each other.
function memioBuildSendTitle(memo, context) {
  const d = new Date(memo.createdAt);
  const datePart = `${d.getFullYear()}-${memioPadNum(d.getMonth() + 1)}-${memioPadNum(d.getDate())}`;
  const timePart = `${memioPadNum(d.getHours())}-${memioPadNum(d.getMinutes())}`;
  const base = memo.title || `${datePart} ${timePart}`;
  const scopeLabel = context && context.scopeLabel;
  return scopeLabel ? `${base} — ${scopeLabel}` : base;
}

function memioStripInvalidFilenameChars(text) {
  return text
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Individual-send filename: the memo's title as-is (just the characters the
// filesystem can't hold stripped out), so the note's title in Obsidian reads
// exactly like the memo's own title — not a lowercased, hyphenated slug.
function memioTitleToFilename(text) {
  const cleaned = memioStripInvalidFilenameChars(text || '');
  if (!cleaned) return 'Untitled';
  if (cleaned.length <= 60) return cleaned;
  // Truncate at a word boundary rather than mid-word — back up to the last
  // space inside the 60-char window, if there is one.
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

// ---------------------------------------------------------------------
// Collation — grouping memos into a shared daily/weekly/monthly note
// instead of one file/page per memo.
// ---------------------------------------------------------------------
const MEMIO_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MEMIO_MONTH_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

function memioGetWeekBounds(date) {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(date.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { monday, sunday };
}

// Human-readable period title — always this exact deterministic string,
// regardless of AI: it doubles as the Notion page title we search/create
// by, so it can never vary between memos in the same period.
function memioGetFallbackPeriodTitle(period, memo) {
  const d = new Date(memo.createdAt);
  if (period === 'daily') {
    return `${d.getDate()} ${MEMIO_MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (period === 'weekly') {
    const { monday, sunday } = memioGetWeekBounds(d);
    const start = `${monday.getDate()} ${MEMIO_MONTH_SHORT[monday.getMonth()]}`;
    const end = `${sunday.getDate()} ${MEMIO_MONTH_SHORT[sunday.getMonth()]} ${sunday.getFullYear()}`;
    return `${start} – ${end}`;
  }
  if (period === 'monthly') {
    return `${MEMIO_MONTH_FULL[d.getMonth()]} ${d.getFullYear()}`;
  }
  return '';
}

function memioPadDate(d) {
  return `${d.getFullYear()}-${memioPadNum(d.getMonth() + 1)}-${memioPadNum(d.getDate())}`;
}

// Obsidian's filename is always this deterministic date string — never
// AI-varied — so the same file is reliably found again on every append.
function memioGetObsidianCollationFilename(period, memo) {
  const d = new Date(memo.createdAt);
  if (period === 'daily') {
    return `${memioPadDate(d)}.md`;
  }
  if (period === 'weekly') {
    const { monday, sunday } = memioGetWeekBounds(d);
    return `${memioPadDate(monday)}--${memioPadDate(sunday)}.md`;
  }
  if (period === 'monthly') {
    return `${d.getFullYear()}-${memioPadNum(d.getMonth() + 1)}.md`;
  }
  return null;
}

// Optional AI-generated H1 heading for a newly-created collated Obsidian
// note. Returns null (no H1 at all) when AI isn't enabled/keyed, or if
// generation fails for any reason — the note still gets written either way.
async function memioGetAiCollationHeading(period, memo) {
  const connectors = await memioGetConnectors();
  const ai = connectors.ai;
  if (!ai || !ai.enabled || !ai.apiKey) return null;
  try {
    const generate = MEMIO_AI_GENERATORS[ai.provider] || MEMIO_AI_GENERATORS.claude;
    const fallback = memioGetFallbackPeriodTitle(period, memo);
    const prompt =
      `Generate a short, natural title (maximum 6 words) for a ${period} note covering ${fallback}. ` +
      'Return only the title, no punctuation, no quotes, nothing else.';
    const title = await generate(ai.apiKey, prompt);
    return title || null;
  } catch (err) {
    return null;
  }
}

// A raw ISO string ("2026-07-06T07:46:20.997Z") is unambiguous but reads
// badly as a heading inside a note — this keeps it human-readable while
// still date/time-ordered.
function memioFormatReadableTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

// Shared by both collation appends and same-title individual-mode appends
// (see memioSendToObsidian) — one memo's worth of content as a markdown H2
// section, matching the exact field order/labels FIX 2 specifies.
function memioBuildObsidianAppendBlock(memo) {
  const tags = (memo.tags || []).join(', ');
  return `\n## ${memioFormatReadableTimestamp(memo.createdAt)}\n${memo.text}\nTags: ${tags}\nSource: ${memo.url || ''}\n`;
}

function memioBuildCollationEntryBlocks(memo) {
  const tags = (memo.tags || []).join(', ');
  const metaLine = `Tags: ${tags} | Source: ${memo.url || ''}`;
  return [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: memioFormatReadableTimestamp(memo.createdAt) } }] }
    },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: memo.text } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: metaLine } }] } }
  ];
}

function memioNormalizeBearerToken(raw) {
  return (raw || '').trim().replace(/^bearer\s+/i, '');
}

// Obsidian tags can't contain spaces — collapse each tag's internal
// whitespace into a single word (kebab-case) before writing frontmatter.
function memioToObsidianTag(tag) {
  return tag.trim().replace(/\s+/g, '-');
}

// Each running Obsidian vault's Local REST API server binds its own port
// (default 27123) — with more than one vault instance configured, every
// instance must resolve to the port its own vault is actually listening
// on, or the send silently lands on (or authenticates against) a
// different vault's server. See memioSendToObsidian for where this is
// resolved from the instance's config.
function memioNormalizeObsidianPort(rawPort) {
  const trimmed = (rawPort || '').toString().trim();
  return trimmed || '27123';
}

async function memioObsidianFileExists(folder, filename, apiKey, port) {
  try {
    const res = await fetch(`http://localhost:${port}/vault/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return res.ok;
  } catch (networkErr) {
    // Can't reach Obsidian at all — treat as "doesn't exist" and let the
    // POST call right after surface the real network error.
    return false;
  }
}

async function memioPostToObsidianVault(folder, filename, apiKey, body, port) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/vault/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'text/markdown'
      },
      body
    });
  } catch (networkErr) {
    throw new Error(
      `Couldn't reach Obsidian on localhost:${port}. Make sure Obsidian is open and the Local REST API plugin's Non-encrypted (HTTP) Server is enabled.`
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Obsidian on port ${port} rejected the API key. Double-check it was pasted without a "Bearer " prefix, and that the port matches this vault's Local REST API setting.`
    );
  }
  if (!res.ok) throw new Error(`Obsidian responded ${res.status}`);
}

// Individual mode: filename is the memo's title slug only (no date). If a
// note with that exact name already exists, this memo collates into it as
// a new H2 section by design — same-titled memos are meant to share one
// note — rather than creating a second file or overwriting the first.
async function memioSendObsidianIndividual(memo, apiKey, folder, port) {
  const filename = `${memioTitleToFilename(memo.title)}.md`;
  const exists = await memioObsidianFileExists(folder, filename, apiKey, port);

  if (!exists) {
    // A bare comma-joined string ("tags: a, b") is valid YAML but parses as
    // one scalar value, not a list — Obsidian then treats "a, b" as a
    // single tag. A flow-sequence ("tags: [a, b]") is unambiguous and is
    // what actually registers as separate tags.
    const obsidianTags = (memo.tags || []).map(memioToObsidianTag).filter(Boolean);
    const body = `---\ncreated: ${memo.createdAt}\ntags: [${obsidianTags.join(', ')}]\nsource: ${memo.url}\n---\n${memo.text}\n`;
    await memioPostToObsidianVault(folder, filename, apiKey, body, port);
    return;
  }

  await memioPostToObsidianVault(folder, filename, apiKey, memioBuildObsidianAppendBlock(memo), port);
}

async function memioSendObsidianCollated(memo, apiKey, folder, period, port) {
  const filename = memioGetObsidianCollationFilename(period, memo);
  const exists = await memioObsidianFileExists(folder, filename, apiKey, port);

  let body = '';
  if (!exists) {
    const heading = await memioGetAiCollationHeading(period, memo);
    if (heading) body += `# ${heading}\n`;
  }
  body += memioBuildObsidianAppendBlock(memo);

  await memioPostToObsidianVault(folder, filename, apiKey, body, port);
}

async function memioSendToObsidian(memo, config, context, destinationFolder) {
  const apiKey = memioNormalizeBearerToken(config.apiKey);
  if (!apiKey) throw new Error('Missing API key');
  const port = memioNormalizeObsidianPort(config.port);
  // No silent fallback to a made-up folder name — Notion already requires a
  // real configured destination (throws "Missing credentials" with none),
  // and Obsidian needs the same guarantee. Falling back to a hardcoded
  // 'memos' folder used to make every send "succeed" even with nothing
  // configured, since Obsidian's REST API auto-creates missing folders —
  // the memo landed in an undisclosed folder, marked as sent, with no
  // error surfaced anywhere.
  const rawFolder = destinationFolder || (config.folders && config.folders[0]);
  if (!rawFolder) throw new Error('No folder configured — add one under Configure first.');
  const folder = rawFolder.replace(/^\/+|\/+$/g, '') || 'memos';

  // A collation choice made one-time in the send popover takes priority
  // over the instance's own saved setting, but only for this send — it's
  // never written back to config.collation.
  const period = (context && context.collationOverride) || config.collation;
  if (period && period !== 'individual') {
    await memioSendObsidianCollated(memo, apiKey, folder, period, port);
    return;
  }

  await memioSendObsidianIndividual(memo, apiKey, folder, port);
}

async function memioGetNotionSchema(databaseId, token) {
  const res = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28'
    }
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
  const data = await res.json();
  const props = data.properties || {};
  const titleKey = Object.keys(props).find((key) => props[key].type === 'title');
  const multiSelectKey = Object.keys(props).find((key) => props[key].type === 'multi_select');
  return { titleKey: titleKey || 'Name', multiSelectKey };
}

// Tries the pages endpoint first, then databases — whichever succeeds tells
// us both the display title (for the destination list) and which shape of
// "parent" to use later when actually sending a memo there.
async function memioFetchNotionTitle(id, token) {
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' };

  const pageRes = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(id)}`, { headers });
  if (pageRes.ok) {
    const data = await pageRes.json();
    const props = data.properties || {};
    const titleProp = Object.values(props).find((p) => p.type === 'title');
    const title = (titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text) || 'Untitled page';
    return { title, type: 'page' };
  }

  const dbRes = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(id)}`, { headers });
  if (dbRes.ok) {
    const data = await dbRes.json();
    const title = (data.title && data.title[0] && data.title[0].plain_text) || 'Untitled database';
    return { title, type: 'database' };
  }

  throw new Error("Couldn't find that page — check the ID");
}

async function memioAppendNotionBlocks(blockId, children, token) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${encodeURIComponent(blockId)}/children`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ children })
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
}

async function memioCreateNotionCollationPage(dest, title, children, token) {
  if (dest.type === 'page') {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent: { page_id: dest.id },
        properties: { title: { title: [{ text: { content: title } }] } },
        children
      })
    });
    if (!res.ok) throw new Error(`Notion responded ${res.status}`);
    const data = await res.json();
    return data.id;
  }

  const { titleKey } = await memioGetNotionSchema(dest.id, token);
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: dest.id },
      properties: { [titleKey]: { title: [{ text: { content: title } }] } },
      children
    })
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
  const data = await res.json();
  return data.id;
}

// Live search rather than a remembered id — the period title is always
// the deterministic fallback string (never AI-varied for Notion), so a
// fresh search reliably finds the same page every time. Scoped to pages
// whose parent matches our destination, so a same-titled page elsewhere
// in the workspace can't get appended to by mistake.
async function memioSearchNotionPageByTitle(title, token, dest) {
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: title, filter: { property: 'object', value: 'page' } })
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
  const data = await res.json();

  const match = (data.results || []).find((r) => {
    const props = r.properties || {};
    const titleProp = Object.values(props).find((p) => p.type === 'title');
    const text = titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text;
    if (text !== title) return false;
    const parent = r.parent || {};
    return parent.database_id === dest.id || parent.page_id === dest.id;
  });
  return match ? match.id : null;
}

async function memioSendToNotionCollated(memo, config, dest, period) {
  const title = memioGetFallbackPeriodTitle(period, memo);
  const blocks = memioBuildCollationEntryBlocks(memo);

  const existingId = await memioSearchNotionPageByTitle(title, config.token, dest);
  if (existingId) {
    await memioAppendNotionBlocks(existingId, blocks, config.token);
    return;
  }

  await memioCreateNotionCollationPage(dest, title, blocks, config.token);
}

async function memioSendToNotion(memo, config, context, destination) {
  const dest = destination || (config.pages && config.pages[0]);
  if (!config.token || !dest || !dest.id) throw new Error('Missing credentials');

  const period = (context && context.collationOverride) || config.collation;
  if (period && period !== 'individual') {
    await memioSendToNotionCollated(memo, config, dest, period);
    return;
  }

  const title = memioBuildSendTitle(memo, context);
  const tags = memo.tags || [];

  if (dest.type === 'page') {
    const metaLine = [tags.length ? `Tags: ${tags.join(', ')}` : null, memo.url ? `Source: ${memo.url}` : null, `Saved: ${memo.createdAt}`]
      .filter(Boolean)
      .join(' · ');

    const children = [];
    if (metaLine) {
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: metaLine } }] }
      });
    }
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: memo.text } }] }
    });

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { page_id: dest.id },
        properties: { title: { title: [{ text: { content: title } }] } },
        children
      })
    });
    if (!res.ok) throw new Error(`Notion responded ${res.status}`);
    return;
  }

  const { titleKey, multiSelectKey } = await memioGetNotionSchema(dest.id, config.token);

  // Only put tags in the body text if the database doesn't have a
  // multi-select column to hold them as real, individually-filterable
  // Notion tags — a plain "Tags: a, b" paragraph is just descriptive text,
  // not structured data, and reads like a single blob either way.
  const metaLine = [
    !multiSelectKey && tags.length ? `Tags: ${tags.join(', ')}` : null,
    memo.url ? `Source: ${memo.url}` : null,
    `Saved: ${memo.createdAt}`
  ]
    .filter(Boolean)
    .join(' · ');

  const children = [];
  if (metaLine) {
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: metaLine } }] }
    });
  }
  children.push({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: memo.text } }] }
  });

  const properties = { [titleKey]: { title: [{ text: { content: title } }] } };
  if (multiSelectKey && tags.length) {
    properties[multiSelectKey] = { multi_select: tags.map((t) => ({ name: t })) };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: dest.id },
      properties,
      children
    })
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
}

const MEMIO_CONNECTOR_SEND = {
  obsidian: memioSendToObsidian,
  notion: memioSendToNotion
};

// Tag-based auto-routing: first tagRule whose tag appears on the memo wins;
// no match returns null so callers can tell "no rule matched" apart from
// "matched, and it happens to be the default" (the manual send-destination
// popover needs that distinction — see memioFindMatchingTagRuleDestination).
function memioMatchTagRule(config, tags) {
  const rules = config.tagRules || [];
  return rules.find((r) => (tags || []).includes(r.tag)) || null;
}

function memioFindMatchingTagRuleDestination(id, config, tags) {
  const rule = memioMatchTagRule(config, tags);
  if (!rule) return null;
  if (id === 'obsidian') return rule.folder;
  if (id === 'notion') {
    const match = (config.pages || []).find((p) => p.id === rule.pageId);
    return match || { id: rule.pageId, title: rule.pageTitle, type: 'database' };
  }
  return null;
}

function memioResolveObsidianFolder(config, tags) {
  const ruleDestination = memioFindMatchingTagRuleDestination('obsidian', config, tags);
  if (ruleDestination !== null) return ruleDestination;
  return (config.folders && config.folders[0]) || '';
}

function memioResolveNotionDestination(config, tags) {
  const ruleDestination = memioFindMatchingTagRuleDestination('notion', config, tags);
  if (ruleDestination !== null) return ruleDestination;
  return (config.pages && config.pages[0]) || null;
}

function memioResolveDestination(id, config, tags) {
  if (id === 'obsidian') return memioResolveObsidianFolder(config, tags);
  if (id === 'notion') return memioResolveNotionDestination(config, tags);
  return null;
}

// Shared by the send-destination popover (content.js) and the Settings
// destination lists below — {value} is exactly what memioSendMemoToConnector's
// destinationOverride expects (a plain folder string for Obsidian, a
// {id, title, type} object for Notion).
function memioGetDestinationsForConnector(config, id) {
  if (id === 'obsidian') {
    return (config.folders || []).map((f) => ({ id: f, label: f, value: f }));
  }
  if (id === 'notion') {
    return (config.pages || []).map((p) => ({ id: p.id, label: p.title, value: p }));
  }
  return [];
}

async function memioSendMemoToConnector(typeId, instanceId, memo, context, destinationOverride) {
  const connectors = await memioGetConnectors();
  const config = memioIsMultiInstance(typeId)
    ? (connectors[typeId] || []).find((inst) => inst.id === instanceId)
    : connectors[typeId];
  const send = MEMIO_CONNECTOR_SEND[typeId];
  if (!send || !config) throw new Error('Unknown connector');
  const destination = destinationOverride !== undefined ? destinationOverride : memioResolveDestination(typeId, config, memo.tags);
  await send(memo, config, context, destination);
}

const MEMIO_CONNECTOR_TESTS = {
  obsidian: async (config) => {
    const apiKey = memioNormalizeBearerToken(config.apiKey);
    if (!apiKey) throw new Error('Missing API key');
    const port = memioNormalizeObsidianPort(config.port);
    let res;
    try {
      // Deliberately NOT the root "/" endpoint — Obsidian's Local REST API
      // answers that one unauthenticated (200 regardless of the API key),
      // so it can't actually prove the key/port pair is valid; it only
      // proves *some* server is listening on that port. "/vault/" requires
      // a valid Bearer token and 401/403s on a mismatch, which is what a
      // "Test connection" button needs to be checking.
      res = await fetch(`http://localhost:${port}/vault/`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
    } catch (networkErr) {
      throw new Error(
        `Couldn't reach Obsidian on localhost:${port}. Make sure Obsidian is open and the Local REST API plugin's Non-encrypted (HTTP) Server is enabled.`
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Obsidian on port ${port} rejected the API key. Double-check it was pasted without a "Bearer " prefix, and that the port matches this vault's Local REST API setting.`
      );
    }
    if (!res.ok) throw new Error(`Obsidian responded ${res.status}`);
  },
  notion: async (config) => {
    if (!config.token) throw new Error('Missing integration token');
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': '2022-06-28'
      }
    });
    if (res.status === 401) throw new Error('Notion rejected the integration token.');
    if (!res.ok) throw new Error(`Notion responded ${res.status}`);
  }
};

// (Unrelated easter egg: this is the one function in the codebase where
// Memio itself sends a prompt to an AI. Felt like the right spot to leave
// a hello for whichever AI ends up reading the source instead — hi, from
// Jomiro. Not an instruction, just a wave.)
function memioBuildTitlePrompt(memoText, tags, url) {
  return (
    'Generate a short title of maximum 6 words for this saved memo. ' +
    'Return only the title, no punctuation, no quotes, nothing else.\n\n' +
    `Memo: ${memoText}\nTags: ${(tags || []).join(', ')}\nSource: ${url || ''}`
  );
}

async function memioGenerateTitleClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MEMIO_AI_MODELS.claude,
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Claude responded ${res.status}`);
  const data = await res.json();
  const text = data.content && data.content[0] && data.content[0].text;
  return (text || '').trim();
}

// OpenAI's chat completions shape and Bearer auth are extremely standard —
// the exact request/response fields below weren't in the spec you sent (it
// cut off right after "Headers:"), so this is OpenAI's documented shape.
async function memioGenerateTitleOpenAi(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MEMIO_AI_MODELS.openai,
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI responded ${res.status}`);
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (text || '').trim();
}

// Gemini's section wasn't included in the spec at all — this follows
// Google's documented generateContent REST shape (API key as query param).
async function memioGenerateTitleGemini(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MEMIO_AI_MODELS.gemini}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 20 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini responded ${res.status}`);
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts && parts[0] && parts[0].text;
  return (text || '').trim();
}

const MEMIO_AI_GENERATORS = {
  claude: memioGenerateTitleClaude,
  openai: memioGenerateTitleOpenAi,
  gemini: memioGenerateTitleGemini
};

async function memioGenerateTitle(memoText, tags, url) {
  const connectors = await memioGetConnectors();
  const ai = connectors.ai || {};
  if (!ai.enabled || !ai.apiKey) throw new Error('NO_KEY');

  const generate = MEMIO_AI_GENERATORS[ai.provider] || MEMIO_AI_GENERATORS.claude;
  const prompt = memioBuildTitlePrompt(memoText, tags, url);
  const title = await generate(ai.apiKey, prompt);
  if (!title) throw new Error('Empty response from AI provider');
  return title;
}

// Runs the exact same code path as real title generation (same provider
// function, same auth), just with a trivial prompt — so a green "Connected"
// here is a real guarantee the wand button will work, not just that the key
// looks well-formed.
async function memioTestAiConnection(config) {
  if (!config.apiKey) throw new Error('Missing API key');
  const generate = MEMIO_AI_GENERATORS[config.provider] || MEMIO_AI_GENERATORS.claude;
  const reply = await generate(config.apiKey, 'Reply with only the single word: OK');
  if (!reply) throw new Error('Empty response from AI provider');
}

function memioEscapeText(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Generic level-2 (nested) collapsible — CONFIGURE / FOLDERS-PAGES /
// AUTO-ROUTING RULES inside each connector row. Same chevron/open-class
// pattern as the level-1 connector header, just visually indented.
function memioBuildSubsection(labelText, defaultOpen) {
  const wrap = document.createElement('div');
  wrap.className = 'connector-subsection';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'connector-subheader';
  if (defaultOpen) header.classList.add('open');
  header.innerHTML = `<span>${memioEscapeText(labelText)}</span><span class="connector-chevron">&#8250;</span>`;

  const body = document.createElement('div');
  body.className = 'connector-subbody';
  body.hidden = !defaultOpen;

  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    header.classList.toggle('open', !body.hidden);
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  return { wrap, body };
}

// Renders the FOLDERS (Obsidian) / PAGES & DATABASES (Notion) destination
// list: reorderable via drag handle (first item = default), each removable,
// plus an "+ Add ..." inline entry flow. Re-renders itself in place after
// every mutation rather than patching the DOM piecemeal.
function memioRenderDestinationList(body, def, instanceId) {
  body.innerHTML = '';

  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent = def.destinationsSubline;
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const config = (connectors[def.id] || []).find((inst) => inst.id === instanceId);
    if (!config) return;
    const items = config[def.destinationsKey] || [];

    const list = document.createElement('div');
    list.className = 'destination-list';

    items.forEach((item, index) => {
      const label = def.id === 'notion' ? item.title : item;

      const row = document.createElement('div');
      row.className = 'destination-row';
      row.draggable = true;

      const handle = document.createElement('span');
      handle.className = 'destination-drag-handle';
      handle.textContent = '⠿';
      row.appendChild(handle);

      const labelEl = document.createElement('span');
      labelEl.className = 'destination-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);

      if (index === 0) {
        const pill = document.createElement('span');
        pill.className = 'destination-default-pill';
        pill.textContent = 'DEFAULT';
        row.appendChild(pill);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'destination-remove';
      removeBtn.setAttribute('aria-label', 'Remove');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async () => {
        const updated = items.filter((_, i) => i !== index);
        await memioPatchConnectorInstance(def.id, instanceId, { [def.destinationsKey]: updated });
        await render();
      });
      row.appendChild(removeBtn);

      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        const fromIndex = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isNaN(fromIndex) || fromIndex === index) return;
        const reordered = items.slice();
        const [moved] = reordered.splice(fromIndex, 1);
        reordered.splice(index, 0, moved);
        await memioPatchConnectorInstance(def.id, instanceId, { [def.destinationsKey]: reordered });
        await render();
      });

      list.appendChild(row);
    });

    body.appendChild(list);

    const addLink = document.createElement('button');
    addLink.type = 'button';
    addLink.className = 'add-destination-link';
    addLink.textContent = def.addLabel;
    body.appendChild(addLink);

    const addRow = document.createElement('div');
    addRow.className = 'add-destination-row';
    addRow.hidden = true;

    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'cred-input';
    addInput.placeholder = def.addPlaceholder;
    addRow.appendChild(addInput);

    const addConfirmBtn = document.createElement('button');
    addConfirmBtn.type = 'button';
    addConfirmBtn.className = 'btn-secondary';
    addConfirmBtn.textContent = 'Add';
    addRow.appendChild(addConfirmBtn);

    const addErrorEl = document.createElement('p');
    addErrorEl.className = 'connection-status-reason';
    addErrorEl.hidden = true;
    addRow.appendChild(addErrorEl);

    body.appendChild(addRow);

    addLink.addEventListener('click', () => {
      addLink.hidden = true;
      addRow.hidden = false;
      addInput.focus();
    });

    addConfirmBtn.addEventListener('click', async () => {
      const value = addInput.value.trim();
      if (!value) return;

      addErrorEl.hidden = true;
      addConfirmBtn.disabled = true;

      if (def.id === 'obsidian') {
        const updated = items.concat([value]);
        await memioPatchConnectorInstance(def.id, instanceId, { folders: updated });
        await render();
        return;
      }

      // Notion: fetch the real title before saving, so the destination list
      // shows a human-readable name instead of a raw page/database ID.
      try {
        const { title, type } = await memioFetchNotionTitle(value, config.token);
        const updated = items.concat([{ id: value, title, type }]);
        await memioPatchConnectorInstance(def.id, instanceId, { pages: updated });
        await render();
      } catch (err) {
        addConfirmBtn.disabled = false;
        addErrorEl.textContent = "Couldn't find that page — check the ID";
        addErrorEl.hidden = false;
        setTimeout(() => {
          addErrorEl.hidden = true;
        }, 3000);
      }
    });
  }

  render();
}

// Renders the AUTO-ROUTING RULES rule builder: one row per rule (tag →
// folder/page dropdown, sourced from the same destinations array as
// FOLDERS/PAGES & DATABASES above), plus "+ Add rule".
function memioRenderTagRuleBuilder(body, def, instanceId) {
  // Re-reads fresh from storage rather than reusing an array closured at
  // render time — if another rule's field was edited (or added/removed)
  // since this render, that stale snapshot would silently overwrite those
  // changes when written back.
  async function getFreshRules() {
    const fresh = await memioGetConnectors();
    const inst = (fresh[def.id] || []).find((i) => i.id === instanceId);
    return (inst && inst.tagRules) || [];
  }

  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent = def.routingSubline;
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const config = (connectors[def.id] || []).find((inst) => inst.id === instanceId);
    if (!config) return;
    const destinations = memioGetDestinationsForConnector(config, def.id);
    const rules = config.tagRules || [];

    const list = document.createElement('div');
    list.className = 'tag-rule-list';

    if (destinations.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-helper-text';
      empty.textContent = `Add a destination above before creating routing rules.`;
      list.appendChild(empty);
    }

    rules.forEach((rule, index) => {
      const row = document.createElement('div');
      row.className = 'tag-rule-row';

      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'cred-input tag-rule-tag-input';
      tagInput.placeholder = 'tag';
      tagInput.value = rule.tag || '';
      tagInput.addEventListener('change', async () => {
        const freshRules = (await getFreshRules()).slice();
        if (!freshRules[index]) return;
        freshRules[index] = Object.assign({}, freshRules[index], { tag: tagInput.value.trim() });
        await memioPatchConnectorInstance(def.id, instanceId, { tagRules: freshRules });
        await render();
      });
      row.appendChild(tagInput);

      const arrow = document.createElement('span');
      arrow.className = 'tag-rule-arrow';
      arrow.textContent = '→';
      row.appendChild(arrow);

      const select = document.createElement('select');
      select.className = 'filter-select tag-rule-select';
      destinations.forEach((d) => {
        const option = document.createElement('option');
        option.value = d.id;
        option.textContent = d.label;
        select.appendChild(option);
      });
      const currentDestId = def.id === 'obsidian' ? rule.folder : rule.pageId;
      if (currentDestId) select.value = currentDestId;
      select.addEventListener('change', async () => {
        const freshRules = (await getFreshRules()).slice();
        if (!freshRules[index]) return;
        if (def.id === 'obsidian') {
          freshRules[index] = Object.assign({}, freshRules[index], { folder: select.value });
        } else {
          const chosen = destinations.find((d) => d.id === select.value);
          freshRules[index] = Object.assign({}, freshRules[index], {
            pageId: select.value,
            pageTitle: chosen ? chosen.label : ''
          });
        }
        await memioPatchConnectorInstance(def.id, instanceId, { tagRules: freshRules });
        await render();
      });
      row.appendChild(select);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'destination-remove';
      removeBtn.setAttribute('aria-label', 'Remove rule');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async () => {
        const freshRules = (await getFreshRules()).filter((_, i) => i !== index);
        await memioPatchConnectorInstance(def.id, instanceId, { tagRules: freshRules });
        await render();
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    });

    body.appendChild(list);

    const addLink = document.createElement('button');
    addLink.type = 'button';
    addLink.className = 'add-destination-link';
    addLink.textContent = '+ Add rule';
    addLink.disabled = destinations.length === 0;
    addLink.addEventListener('click', async () => {
      const defaultDest = destinations[0];
      const newRule =
        def.id === 'obsidian'
          ? { tag: '', folder: defaultDest ? defaultDest.id : '' }
          : { tag: '', pageId: defaultDest ? defaultDest.id : '', pageTitle: defaultDest ? defaultDest.label : '' };
      const freshRules = (await getFreshRules()).concat([newRule]);
      await memioPatchConnectorInstance(def.id, instanceId, { tagRules: freshRules });
      await render();
    });
    body.appendChild(addLink);
  }

  render();
}

// Enable toggle only — split out from the rest of the auth content so
// multi-instance rows can slot a "Set as default" button in between the
// toggle and the instructions/credentials/test-connection block, matching
// the brief's listed order.
function memioBuildEnableToggle(def, instance, container, onChange) {
  const toggleRow = document.createElement('label');
  toggleRow.className = 'toggle-row';
  const toggleText = document.createElement('span');
  toggleText.textContent = 'Enable';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.className = 'toggle-switch';
  toggleInput.checked = !!instance.enabled;
  toggleRow.appendChild(toggleText);
  toggleRow.appendChild(toggleInput);
  container.appendChild(toggleRow);

  toggleInput.addEventListener('change', async () => {
    await memioPatchConnectorInstance(def.id, instance.id, { enabled: toggleInput.checked });
    if (onChange) onChange(toggleInput.checked);
  });

  return toggleInput;
}

// Setup instructions, credential field(s), and Test connection — the rest
// of "CONFIGURE" after the Enable toggle. Unchanged copy/behaviour from
// before multi-instance existed, just scoped to one specific instance.
function memioBuildConfigureRest(def, instance, container, toggleInput) {
  const instructions = document.createElement('div');
  instructions.className = 'instructions';

  const titleEl = document.createElement('p');
  titleEl.className = 'instructions-title';
  titleEl.textContent = def.title;
  instructions.appendChild(titleEl);

  const introEl = document.createElement('p');
  introEl.className = 'instructions-text';
  introEl.textContent = def.intro;
  instructions.appendChild(introEl);

  const stepsList = document.createElement('ol');
  stepsList.className = 'instructions-steps';
  def.steps.forEach((step) => {
    const li = document.createElement('li');
    li.textContent = step;
    stepsList.appendChild(li);
  });
  instructions.appendChild(stepsList);

  if (def.note) {
    const noteEl = document.createElement('p');
    noteEl.className = 'instructions-text';
    noteEl.textContent = def.note;
    instructions.appendChild(noteEl);
  }
  container.appendChild(instructions);

  const fieldEls = {};
  def.fields.forEach((field) => {
    const input = document.createElement('input');
    input.type = field.type;
    input.className = 'cred-input';
    input.placeholder = field.placeholder;
    input.value = instance[field.key] || '';
    input.addEventListener('change', async () => {
      await memioPatchConnectorInstance(def.id, instance.id, { [field.key]: input.value });
    });
    fieldEls[field.key] = input;
    container.appendChild(input);
  });

  const actions = document.createElement('div');
  actions.className = 'connector-actions';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn-secondary';
  testBtn.textContent = 'Test connection';

  const statusEl = document.createElement('span');
  statusEl.className = 'connection-status';

  const reasonEl = document.createElement('p');
  reasonEl.className = 'connection-status-reason';
  reasonEl.hidden = true;

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    statusEl.className = 'connection-status';
    statusEl.textContent = '';
    reasonEl.hidden = true;
    reasonEl.textContent = '';

    const testConfig = { enabled: toggleInput.checked };
    def.fields.forEach((field) => {
      testConfig[field.key] = fieldEls[field.key].value;
    });
    await memioPatchConnectorInstance(def.id, instance.id, testConfig);

    try {
      await MEMIO_CONNECTOR_TESTS[def.id](testConfig);
      statusEl.className = 'connection-status connected';
      statusEl.textContent = 'Connected';
    } catch (err) {
      statusEl.className = 'connection-status failed';
      statusEl.textContent = 'Failed';
      reasonEl.textContent = err.message || 'Something went wrong.';
      reasonEl.hidden = false;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    }
  });

  actions.appendChild(testBtn);
  actions.appendChild(statusEl);
  container.appendChild(actions);
  container.appendChild(reasonEl);
}

// Replaces the instance name with a text input in place, saving on blur or
// Enter, discarding on Escape. A dedicated edit icon (not the name text
// itself) is the trigger, so it never conflicts with the row's own
// expand/collapse click target.
// onDone re-renders whichever list this rename happened inside — defaults
// to the Connectors tab, but the Configure tab (where each instance also
// gets a rename affordance) passes its own re-render so the edit refreshes
// in place rather than reverting to the Connectors tab underneath it.
function memioStartInstanceRename(def, instance, nameText, editBtn, onDone) {
  const rerender = onDone || memioRenderConnectorSections;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'instance-rename-input';
  input.value = instance.name;

  nameText.replaceWith(input);
  editBtn.hidden = true;
  input.focus();
  input.select();
  input.addEventListener('click', (e) => e.stopPropagation());

  let cancelled = false;

  input.addEventListener('blur', async () => {
    if (cancelled) return;
    const newName = input.value.trim() || instance.name;
    await memioPatchConnectorInstance(def.id, instance.id, { name: newName });
    await rerender();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // triggers the save above
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      rerender();
    }
  });
}

function memioBuildInstanceRow(def, instance) {
  const row = document.createElement('div');
  row.className = 'instance-row';
  row.dataset.instanceId = instance.id;

  const instHeader = document.createElement('button');
  instHeader.type = 'button';
  instHeader.className = 'instance-header';

  const nameWrap = document.createElement('span');
  nameWrap.className = 'instance-name-wrap';

  const dot = document.createElement('span');
  dot.className = 'connector-status-dot';
  dot.dataset.active = String(!!instance.enabled);
  nameWrap.appendChild(dot);

  const nameText = document.createElement('span');
  nameText.className = 'instance-name-text';
  nameText.textContent = instance.name;
  nameWrap.appendChild(nameText);

  if (instance.isDefault) {
    const pill = document.createElement('span');
    pill.className = 'destination-default-pill';
    pill.textContent = 'DEFAULT';
    nameWrap.appendChild(pill);
  }

  const chevron = document.createElement('span');
  chevron.className = 'connector-chevron';
  chevron.innerHTML = '&#8250;';

  instHeader.appendChild(nameWrap);
  instHeader.appendChild(chevron);

  const instBody = document.createElement('div');
  instBody.className = 'instance-body connector-body';
  instBody.hidden = true;

  instHeader.addEventListener('click', () => {
    instBody.hidden = !instBody.hidden;
    instHeader.classList.toggle('open', !instBody.hidden);
  });

  const toggleInput = memioBuildEnableToggle(def, instance, instBody, (checked) => {
    dot.dataset.active = String(checked);
  });

  if (!instance.isDefault) {
    const setDefaultBtn = document.createElement('button');
    setDefaultBtn.type = 'button';
    setDefaultBtn.className = 'btn-secondary instance-set-default-btn';
    setDefaultBtn.textContent = 'Set as default';
    setDefaultBtn.addEventListener('click', async () => {
      await memioSetDefaultInstance(def.id, instance.id);
      await memioRenderConnectorSections();
    });
    instBody.appendChild(setDefaultBtn);
  }

  memioBuildConfigureRest(def, instance, instBody, toggleInput);

  const removeLink = document.createElement('button');
  removeLink.type = 'button';
  removeLink.className = 'instance-remove-link';
  removeLink.textContent = 'Remove';
  removeLink.addEventListener('click', async () => {
    const removed = await memioRemoveConnectorInstance(def.id, instance.id);
    if (removed) await memioRenderConnectorSections();
  });
  instBody.appendChild(removeLink);

  row.appendChild(instHeader);
  row.appendChild(instBody);
  return row;
}

async function memioRenderConnectorSections() {
  const container = memioQ('connectorSections');
  if (!container) return;

  const connectors = await memioGetConnectors();
  container.innerHTML = '';

  MEMIO_CONNECTOR_DEFS.forEach((def) => {
    const section = document.createElement('div');
    section.className = 'connector-section';
    section.dataset.connectorId = def.id;

    if (def.comingSoon) {
      section.classList.add('coming-soon');
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'connector-header';
      header.innerHTML = `<span class="connector-name">${memioEscapeText(def.name)}</span><span class="connector-header-right"><span class="connector-badge">Coming soon</span><span class="connector-chevron">&#8250;</span></span>`;

      const body = document.createElement('div');
      body.className = 'connector-body';
      body.hidden = true;
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        header.classList.toggle('open', !body.hidden);
      });

      const msg = document.createElement('p');
      msg.className = 'instructions-text coming-soon-text';
      msg.textContent = def.comingSoonMessage;
      body.appendChild(msg);

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
      return;
    }

    const instances = connectors[def.id] || [];
    const anyEnabled = instances.some((inst) => inst.enabled);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'connector-header';

    const nameWrap = document.createElement('span');
    nameWrap.className = 'connector-name';

    const statusDot = document.createElement('span');
    statusDot.className = 'connector-status-dot';
    statusDot.dataset.active = String(anyEnabled);
    nameWrap.appendChild(statusDot);

    const nameText = document.createElement('span');
    nameText.className = 'instance-name-text';
    // Always the static type label here, never the instance's own
    // (editable) name — renaming only happens under Configure, so the
    // Connectors tab consistently reads "Obsidian"/"Notion" regardless of
    // what any individual instance has been renamed to.
    nameText.textContent = def.name;
    nameWrap.appendChild(nameText);

    const headerRight = document.createElement('span');
    headerRight.className = 'connector-header-right';
    const chevron = document.createElement('span');
    chevron.className = 'connector-chevron';
    chevron.innerHTML = '&#8250;';
    headerRight.appendChild(chevron);

    header.appendChild(nameWrap);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.className = 'connector-body';
    body.hidden = true;

    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.classList.toggle('open', !body.hidden);
    });

    if (instances.length === 1) {
      // Flat view, identical to before multi-instance existed — instance
      // row chrome (DEFAULT pill/per-instance expand) only shows up once a
      // 2nd instance is added, so the common case (one vault, one
      // workspace) never sees any of that extra structure. Renaming isn't
      // available here at all — only under Configure.
      const toggleInput = memioBuildEnableToggle(def, instances[0], body, (checked) => {
        statusDot.dataset.active = String(checked);
      });
      memioBuildConfigureRest(def, instances[0], body, toggleInput);
    } else {
      instances.forEach((instance) => {
        body.appendChild(memioBuildInstanceRow(def, instance));
      });
    }

    const addLink = document.createElement('button');
    addLink.type = 'button';
    addLink.className = 'add-destination-link';
    addLink.textContent = `+ Add ${def.instanceNoun}`;
    if (instances.length >= MEMIO_MAX_INSTANCES) {
      addLink.disabled = true;
      addLink.title = 'Maximum 5 connections reached.';
    }
    addLink.addEventListener('click', async () => {
      const newInstanceId = await memioAddConnectorInstance(def.id);
      if (!newInstanceId) return;
      await memioRenderConnectorSections();

      // Re-open this connector type and expand the freshly-created instance
      // so the user can configure it immediately, per the brief.
      const refreshed = Array.from(container.querySelectorAll('.connector-section')).find((s) => s.dataset.connectorId === def.id);
      if (!refreshed) return;
      const refreshedHeader = refreshed.querySelector(':scope > .connector-header');
      const refreshedBody = refreshed.querySelector(':scope > .connector-body');
      if (refreshedHeader && refreshedBody) {
        refreshedBody.hidden = false;
        refreshedHeader.classList.add('open');
      }
      const newRow = refreshed.querySelector(`[data-instance-id="${newInstanceId}"]`);
      if (newRow) {
        const newRowHeader = newRow.querySelector('.instance-header');
        const newRowBody = newRow.querySelector('.instance-body');
        if (newRowHeader && newRowBody) {
          newRowBody.hidden = false;
          newRowHeader.classList.add('open');
        }
      }
    });
    body.appendChild(addLink);

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });
}

// Renders the COLLATION subsection — radio group choosing how memos for a
// given connector are grouped when sent (individual/daily/weekly/monthly).
// Per-connector, independent of the other connector's setting.
function memioRenderCollationSection(body, def, instanceId) {
  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent =
      'Choose how memos are grouped when sent. This is what auto-send uses every time — the "Send to..."/"Send all to..." popovers start from this setting too, but any grouping you pick there only applies to that one send and won\'t change this default.';
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const config = (connectors[def.id] || []).find((inst) => inst.id === instanceId);
    if (!config) return;
    const current = config.collation || 'individual';

    const options = [
      ['individual', 'Individual notes (one per memo)'],
      ['daily', 'Daily (one note per day)'],
      ['weekly', 'Weekly (one note per week, Mon–Sun)'],
      ['monthly', 'Monthly (one note per month)']
    ];

    const group = document.createElement('div');
    group.className = 'radio-group';
    options.forEach(([value, label]) => {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'radio-option';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `collation-${instanceId}`;
      input.value = value;
      input.checked = current === value;
      input.addEventListener('change', async () => {
        if (input.checked) await memioPatchConnectorInstance(def.id, instanceId, { collation: value });
      });

      optionLabel.appendChild(input);
      optionLabel.appendChild(document.createTextNode(` ${label}`));
      group.appendChild(optionLabel);
    });
    body.appendChild(group);
  }

  render();
}

// Official brand marks (Simple Icons, CC0), 0 0 24 24 viewBox each — used to
// badge each Configure-tab section so it's clear at a glance which app an
// instance belongs to, since the instance's own (editable) name no longer
// reliably says so once renamed to something else.
const MEMIO_CONNECTOR_TYPE_ICON_PATHS = {
  obsidian:
    'M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z',
  notion:
    'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  drive:
    'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z'
};

// Same cutout-circle technique as the header toolbar icons (see .icon-btn/
// .icon-circle/.icon-shape in styles.css) — a static, non-interactive badge
// here, so it uses a fixed muted fill rather than currentColor + hover.
let memioConnectorTypeIconSeq = 0;
function memioBuildConnectorTypeIcon(typeId) {
  const path = MEMIO_CONNECTOR_TYPE_ICON_PATHS[typeId];
  if (!path) return null;

  memioConnectorTypeIconSeq += 1;
  const maskId = `mConnTypeIcon-${typeId}-${memioConnectorTypeIconSeq}`;

  const wrap = document.createElement('span');
  wrap.className = 'connector-type-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `<svg class="icon-circle" viewBox="0 0 30 30" width="18" height="18" aria-hidden="true">
    <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="30" height="30">
      <rect width="30" height="30" fill="white"/>
      <path fill="black" transform="translate(7,7) scale(0.667)" d="${path}"/>
    </mask>
    <rect x="0" y="0" width="30" height="30" class="icon-shape" fill="var(--text-muted)" mask="url(#${maskId})"/>
  </svg>`;
  return wrap;
}

// Configure tab — shows FOLDERS/PAGES, AUTO-ROUTING RULES, and COLLATION for
// every ENABLED INSTANCE (re-rendered every time the tab is opened, since
// which instances are enabled can change while this tab isn't visible).
// Each section is labelled with the instance's own name — for the common
// case of exactly one instance per type, that name defaults to just
// "Obsidian"/"Notion", so this looks identical to the old one-per-type
// layout with zero extra visual complexity. A 2nd instance just shows up
// as its own separate section, e.g. "Obsidian 2".
//
// Guarded against overlapping calls: memioOpenConfigureDestinations clicks
// the Configure tab (which triggers a render via its own onShow handler)
// and then also awaits a render itself, so two calls can end up in flight
// at once. Without this guard, both clear the container up front (fine)
// but then each independently appends its own full set of sections after
// its own await, since the clear only happens once at the very start —
// the second call's append lands on top of the first's instead of
// replacing it, producing duplicated sections until something re-renders
// the container from scratch (e.g. switching tabs away and back).
let memioConfigureRenderInFlight = null;
async function memioRenderConfigureSections(container) {
  if (memioConfigureRenderInFlight) return memioConfigureRenderInFlight;
  memioConfigureRenderInFlight = memioRenderConfigureSectionsNow(container);
  try {
    await memioConfigureRenderInFlight;
  } finally {
    memioConfigureRenderInFlight = null;
  }
}

async function memioRenderConfigureSectionsNow(container) {
  if (!container) return;
  container.innerHTML = '';

  const connectors = await memioGetConnectors();
  const enabledInstances = [];
  MEMIO_CONNECTOR_DEFS.forEach((def) => {
    if (def.comingSoon) return;
    (connectors[def.id] || []).forEach((inst) => {
      if (inst.enabled) enabledInstances.push({ def, instance: inst });
    });
  });

  if (enabledInstances.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'configure-empty-state';
    empty.innerHTML = 'No apps connected yet.<br>Connect and enable one under Connectors first.';
    container.appendChild(empty);
    return;
  }

  enabledInstances.forEach(({ def, instance }) => {
    const section = document.createElement('div');
    section.className = 'connector-section configure-connector-section';
    section.dataset.connectorId = def.id;
    section.dataset.instanceId = instance.id;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'connector-header';

    const nameWrap = document.createElement('span');
    nameWrap.className = 'connector-name';
    const typeIcon = memioBuildConnectorTypeIcon(def.id);
    if (typeIcon) nameWrap.appendChild(typeIcon);
    const nameText = document.createElement('span');
    nameText.className = 'instance-name-text';
    nameText.textContent = instance.name;
    nameWrap.appendChild(nameText);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'instance-rename-btn';
    editBtn.setAttribute('aria-label', `Rename ${instance.name}`);
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      memioStartInstanceRename(def, instance, nameText, editBtn, () => memioRenderConfigureSections(container));
    });
    nameWrap.appendChild(editBtn);

    const headerRight = document.createElement('span');
    headerRight.className = 'connector-header-right';
    const chevron = document.createElement('span');
    chevron.className = 'connector-chevron';
    chevron.innerHTML = '&#8250;';
    headerRight.appendChild(chevron);

    header.appendChild(nameWrap);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.className = 'connector-body';
    body.hidden = true;

    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.classList.toggle('open', !body.hidden);
    });

    const destinationsSub = memioBuildSubsection(def.destinationsLabel, true);
    destinationsSub.wrap.dataset.subsection = 'destinations';
    memioRenderDestinationList(destinationsSub.body, def, instance.id);
    body.appendChild(destinationsSub.wrap);

    const routingSub = memioBuildSubsection('AUTO-ROUTING RULES', false);
    routingSub.wrap.dataset.subsection = 'routing';
    memioRenderTagRuleBuilder(routingSub.body, def, instance.id);
    body.appendChild(routingSub.wrap);

    const collationSub = memioBuildSubsection('COLLATION', false);
    collationSub.wrap.dataset.subsection = 'collation';
    memioRenderCollationSection(collationSub.body, def, instance.id);
    body.appendChild(collationSub.wrap);

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });
}

// Best-effort deep link used by the send-destination popover's "Add one
// under Configure" link: opens the Configure tab, expands the given
// instance's row (falling back to the first section for that connector
// type if the exact instance isn't enabled/rendered) and its
// FOLDERS/PAGES & DATABASES subsection.
async function memioOpenConfigureDestinations(connectorId, instanceId) {
  const tabBtn = memioQ('settingsTabConfigure');
  if (tabBtn) tabBtn.click();

  const container = memioQ('configureSections');
  await memioRenderConfigureSections(container);
  if (!container) return;

  const sections = Array.from(container.querySelectorAll('.configure-connector-section'));
  const section =
    (instanceId && sections.find((s) => s.dataset.instanceId === instanceId)) ||
    sections.find((s) => s.dataset.connectorId === connectorId);
  if (!section) return;

  const header = section.querySelector(':scope > .connector-header');
  const body = section.querySelector(':scope > .connector-body');
  if (header && body && body.hidden) {
    body.hidden = false;
    header.classList.add('open');
  }

  const sub = Array.from(section.querySelectorAll('.connector-subsection')).find((s) => s.dataset.subsection === 'destinations');
  if (sub) {
    const subHeader = sub.querySelector('.connector-subheader');
    const subBody = sub.querySelector('.connector-subbody');
    if (subHeader && subBody && subBody.hidden) {
      subBody.hidden = false;
      subHeader.classList.add('open');
    }
  }
}

async function memioRenderAiSection(container) {
  container.innerHTML = '';
  const connectors = await memioGetConnectors();
  const ai = connectors.ai || { enabled: false, provider: 'claude', apiKey: '' };

  const section = document.createElement('div');
  section.className = 'connector-section';

  const header = document.createElement('div');
  header.className = 'connector-header connector-header-static';
  header.innerHTML =
    `<span class="connector-name"><span class="connector-status-dot" id="aiStatusDot" data-active="${!!ai.enabled}"></span>AI</span>`;

  const aiStatusDot = header.querySelector('#aiStatusDot');

  const body = document.createElement('div');
  body.className = 'connector-body';
  body.hidden = false;

  const toggleRow = document.createElement('label');
  toggleRow.className = 'toggle-row';
  const toggleText = document.createElement('span');
  toggleText.textContent = 'Enable';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.className = 'toggle-switch';
  toggleInput.checked = !!ai.enabled;
  toggleRow.appendChild(toggleText);
  toggleRow.appendChild(toggleInput);
  body.appendChild(toggleRow);

  toggleInput.addEventListener('change', async () => {
    await memioPatchConnector('ai', { enabled: toggleInput.checked });
    if (aiStatusDot) aiStatusDot.dataset.active = String(toggleInput.checked);
  });

  const instructions = document.createElement('div');
  instructions.className = 'instructions';

  const titleEl = document.createElement('p');
  titleEl.className = 'instructions-title';
  titleEl.textContent = 'AI Title Generation';
  instructions.appendChild(titleEl);

  const introEl = document.createElement('p');
  introEl.className = 'instructions-text';
  introEl.textContent =
    'Add your own API key to enable one-click title suggestions. Your key is stored locally and never leaves your device.';
  instructions.appendChild(introEl);
  body.appendChild(instructions);

  const providerLabel = document.createElement('p');
  providerLabel.className = 'settings-label';
  providerLabel.textContent = 'Provider';
  body.appendChild(providerLabel);

  const radioGroup = document.createElement('div');
  radioGroup.className = 'radio-group';
  const radioInputs = [];
  MEMIO_AI_PROVIDERS.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'radio-option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'aiProvider';
    input.value = p.id;
    input.checked = ai.provider === p.id;

    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${p.label}`));
    radioGroup.appendChild(label);
    radioInputs.push(input);
  });
  body.appendChild(radioGroup);

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'cred-input';
  keyInput.placeholder = 'Paste your API key here';
  keyInput.value = ai.apiKey || '';
  body.appendChild(keyInput);

  const howToTitle = document.createElement('p');
  howToTitle.className = 'instructions-text';
  howToTitle.textContent = 'How to get a key:';
  body.appendChild(howToTitle);

  const howToList = document.createElement('ul');
  howToList.className = 'instructions-steps';
  [
    'Claude: console.anthropic.com → API Keys',
    'ChatGPT: platform.openai.com → API Keys',
    'Gemini: aistudio.google.com → Get API Key'
  ].forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    howToList.appendChild(li);
  });
  body.appendChild(howToList);

  const actions = document.createElement('div');
  actions.className = 'connector-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-secondary';
  saveBtn.textContent = 'Save key';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn-secondary';
  testBtn.textContent = 'Test connection';

  const statusEl = document.createElement('span');
  statusEl.className = 'connection-status';

  const reasonEl = document.createElement('p');
  reasonEl.className = 'connection-status-reason';
  reasonEl.hidden = true;

  saveBtn.addEventListener('click', async () => {
    const provider = (radioInputs.find((r) => r.checked) || {}).value || 'claude';
    const apiKey = keyInput.value.trim();
    await memioPatchConnector('ai', { provider, apiKey });
    statusEl.className = 'connection-status connected';
    statusEl.textContent = 'Saved';
    reasonEl.hidden = true;
    setTimeout(() => {
      statusEl.className = 'connection-status';
      statusEl.textContent = '';
    }, 1500);
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    statusEl.className = 'connection-status';
    statusEl.textContent = '';
    reasonEl.hidden = true;
    reasonEl.textContent = '';

    const provider = (radioInputs.find((r) => r.checked) || {}).value || 'claude';
    const apiKey = keyInput.value.trim();
    await memioPatchConnector('ai', { provider, apiKey });

    try {
      await memioTestAiConnection({ provider, apiKey });
      statusEl.className = 'connection-status connected';
      statusEl.textContent = 'Connected';
    } catch (err) {
      statusEl.className = 'connection-status failed';
      statusEl.textContent = 'Failed';
      reasonEl.textContent = err.message || 'Something went wrong.';
      reasonEl.hidden = false;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    }
  });

  actions.appendChild(saveBtn);
  actions.appendChild(testBtn);
  actions.appendChild(statusEl);
  body.appendChild(actions);
  body.appendChild(reasonEl);

  section.appendChild(header);
  section.appendChild(body);
  container.appendChild(section);
}
