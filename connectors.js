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
    fields: [{ key: 'apiKey', type: 'password', placeholder: 'API key' }],
    destinationsKey: 'folders',
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

async function memioObsidianFileExists(folder, filename, apiKey) {
  try {
    const res = await fetch(`http://localhost:27123/vault/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return res.ok;
  } catch (networkErr) {
    // Can't reach Obsidian at all — treat as "doesn't exist" and let the
    // POST call right after surface the real network error.
    return false;
  }
}

async function memioPostToObsidianVault(folder, filename, apiKey, body) {
  let res;
  try {
    res = await fetch(`http://localhost:27123/vault/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'text/markdown'
      },
      body
    });
  } catch (networkErr) {
    throw new Error(
      "Couldn't reach Obsidian on localhost:27123. Make sure Obsidian is open and the Local REST API plugin's Non-encrypted (HTTP) Server is enabled."
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Obsidian rejected the API key. Double-check it was pasted without a "Bearer " prefix.');
  }
  if (!res.ok) throw new Error(`Obsidian responded ${res.status}`);
}

// Individual mode: filename is the memo's title slug only (no date). If a
// note with that exact name already exists, this memo collates into it as
// a new H2 section by design — same-titled memos are meant to share one
// note — rather than creating a second file or overwriting the first.
async function memioSendObsidianIndividual(memo, apiKey, folder) {
  const filename = `${memioTitleToFilename(memo.title)}.md`;
  const exists = await memioObsidianFileExists(folder, filename, apiKey);

  if (!exists) {
    // A bare comma-joined string ("tags: a, b") is valid YAML but parses as
    // one scalar value, not a list — Obsidian then treats "a, b" as a
    // single tag. A flow-sequence ("tags: [a, b]") is unambiguous and is
    // what actually registers as separate tags.
    const obsidianTags = (memo.tags || []).map(memioToObsidianTag).filter(Boolean);
    const body = `---\ncreated: ${memo.createdAt}\ntags: [${obsidianTags.join(', ')}]\nsource: ${memo.url}\n---\n${memo.text}\n`;
    await memioPostToObsidianVault(folder, filename, apiKey, body);
    return;
  }

  await memioPostToObsidianVault(folder, filename, apiKey, memioBuildObsidianAppendBlock(memo));
}

async function memioSendObsidianCollated(memo, apiKey, folder, period) {
  const filename = memioGetObsidianCollationFilename(period, memo);
  const exists = await memioObsidianFileExists(folder, filename, apiKey);

  let body = '';
  if (!exists) {
    const heading = await memioGetAiCollationHeading(period, memo);
    if (heading) body += `# ${heading}\n`;
  }
  body += memioBuildObsidianAppendBlock(memo);

  await memioPostToObsidianVault(folder, filename, apiKey, body);
}

async function memioSendToObsidian(memo, config, context, destinationFolder) {
  const apiKey = memioNormalizeBearerToken(config.apiKey);
  if (!apiKey) throw new Error('Missing API key');
  const rawFolder = destinationFolder || (config.folders && config.folders[0]) || 'memos';
  const folder = rawFolder.replace(/^\/+|\/+$/g, '') || 'memos';

  // A collation choice made one-time in the send popover takes priority
  // over the instance's own saved setting, but only for this send — it's
  // never written back to config.collation.
  const period = (context && context.collationOverride) || config.collation;
  if (period && period !== 'individual') {
    await memioSendObsidianCollated(memo, apiKey, folder, period);
    return;
  }

  await memioSendObsidianIndividual(memo, apiKey, folder);
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
    let res;
    try {
      res = await fetch('http://localhost:27123/', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
    } catch (networkErr) {
      throw new Error(
        "Couldn't reach Obsidian on localhost:27123. Make sure Obsidian is open and the Local REST API plugin's Non-encrypted (HTTP) Server is enabled."
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Obsidian rejected the API key. Double-check it was pasted without a "Bearer " prefix.');
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
function memioStartInstanceRename(def, instance, nameText, editBtn) {
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
    await memioRenderConnectorSections();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // triggers the save above
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      memioRenderConnectorSections();
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

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'instance-rename-btn';
  editBtn.setAttribute('aria-label', `Rename ${instance.name}`);
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    memioStartInstanceRename(def, instance, nameText, editBtn);
  });
  nameWrap.appendChild(editBtn);

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
    header.innerHTML = `<span class="connector-name"><span class="connector-status-dot" data-active="${anyEnabled}"></span>${memioEscapeText(def.name)}</span><span class="connector-header-right"><span class="connector-chevron">&#8250;</span></span>`;

    const body = document.createElement('div');
    body.className = 'connector-body';
    body.hidden = true;

    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.classList.toggle('open', !body.hidden);
    });

    if (instances.length === 1) {
      // Flat view, identical to before multi-instance existed — instance
      // chrome (name/pencil/DEFAULT pill/per-instance expand) only shows up
      // once a 2nd instance is added, so the common case (one vault, one
      // workspace) never sees any of this extra structure.
      const statusDot = header.querySelector('.connector-status-dot');
      const toggleInput = memioBuildEnableToggle(def, instances[0], body, (checked) => {
        if (statusDot) statusDot.dataset.active = String(checked);
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
    subline.textContent = 'Choose how memos are grouped when sent.';
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

// Configure tab — shows FOLDERS/PAGES, AUTO-ROUTING RULES, and COLLATION for
// every ENABLED INSTANCE (re-rendered every time the tab is opened, since
// which instances are enabled can change while this tab isn't visible).
// Each section is labelled with the instance's own name — for the common
// case of exactly one instance per type, that name defaults to just
// "Obsidian"/"Notion", so this looks identical to the old one-per-type
// layout with zero extra visual complexity. A 2nd instance just shows up
// as its own separate section, e.g. "Obsidian 2".
async function memioRenderConfigureSections(container) {
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
    header.innerHTML = `<span class="connector-name">${memioEscapeText(instance.name)}</span><span class="connector-header-right"><span class="connector-chevron">&#8250;</span></span>`;

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
