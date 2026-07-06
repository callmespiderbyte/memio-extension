const MEMIO_CONNECTORS_KEY = 'connectors';

const MEMIO_CONNECTOR_DEFAULTS = {
  obsidian: { enabled: false, apiKey: '', folders: [], tagRules: [], collation: 'individual' },
  notion: { enabled: false, token: '', pages: [], tagRules: [], collation: 'individual' },
  drive: { enabled: false, apiKey: '', folderId: '' },
  ai: { enabled: false, provider: 'claude', apiKey: '' }
};

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
    title: 'Connect Obsidian',
    intro: "You'll need the Local REST API community plugin installed in Obsidian.",
    steps: [
      'Open Obsidian',
      'Go to Settings → Community Plugins → Browse',
      'Search "Local REST API" → Install → Enable',
      'In the plugin settings, turn on "Enable Non-encrypted (HTTP) Server" — it\'s off by default',
      'In the plugin settings, copy your API Key (paste just the key — no "Bearer " prefix)',
      'Paste it below',
      'Make sure Obsidian is open when sending clips'
    ],
    fields: [{ key: 'apiKey', type: 'password', placeholder: 'API key' }],
    destinationsKey: 'folders',
    destinationsLabel: 'FOLDERS',
    destinationsSubline: 'The first folder is your default. Add more to choose a destination when sending.',
    addLabel: '+ Add folder',
    addPlaceholder: '/clips/design',
    routingSubline:
      "Route clips to a folder based on a single tag. If a clip has multiple tags, the first matching rule wins — so if 'design' routes to /design and 'book' routes to /book, a clip tagged both goes to /design. Unmatched clips go to your default folder.",
    routingDefaultLabel: 'your default folder'
  },
  {
    id: 'notion',
    name: 'Notion',
    title: 'Connect Notion',
    intro: "You'll need to create a Notion integration and share a database with it.",
    steps: [
      'Go to notion.so/my-integrations',
      'Click "New integration" → give it a name → Submit',
      'Copy the "Internal Integration Token"',
      'Paste it below',
      'Open or create a Notion page or database where clips will be saved.',
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
      "Route clips to a folder based on a single tag. If a clip has multiple tags, the first matching rule wins — so if 'design' routes to /design and 'book' routes to /book, a clip tagged both goes to /design. Unmatched clips go to your default folder.",
    routingDefaultLabel: 'your default page'
  },
  {
    id: 'drive',
    name: 'Google Drive',
    comingSoon: true,
    comingSoonMessage: 'Google Drive requires account connection — coming in a future update.'
  }
];

// Guards the one-time folderPath/pageId → folders/pages migration below so
// it only ever writes once per page load, not on every memioGetConnectors()
// call (this function runs constantly — on every render, every send).
let memioLegacyDestinationsMigrated = false;

async function memioGetConnectors() {
  const { connectors } = await chrome.storage.sync.get(MEMIO_CONNECTORS_KEY);
  const merged = {};
  Object.keys(MEMIO_CONNECTOR_DEFAULTS).forEach((id) => {
    merged[id] = Object.assign({}, MEMIO_CONNECTOR_DEFAULTS[id], connectors && connectors[id]);
  });

  if (!memioLegacyDestinationsMigrated) {
    memioLegacyDestinationsMigrated = true;
    let changed = false;

    if (merged.obsidian.folderPath && (!merged.obsidian.folders || merged.obsidian.folders.length === 0)) {
      merged.obsidian.folders = [merged.obsidian.folderPath];
      changed = true;
    }
    if (merged.notion.pageId && (!merged.notion.pages || merged.notion.pages.length === 0)) {
      merged.notion.pages = [{ id: merged.notion.pageId, title: 'Default', type: 'database' }];
      changed = true;
    }

    if (changed) {
      await chrome.storage.sync.set({ connectors: merged });
    }
  }

  return merged;
}

async function memioPatchConnector(id, patch) {
  const connectors = await memioGetConnectors();
  connectors[id] = Object.assign({}, connectors[id], patch);
  await chrome.storage.sync.set({ connectors });
  return connectors;
}

async function memioGetEnabledConnectors() {
  const connectors = await memioGetConnectors();
  return MEMIO_CONNECTOR_DEFS.filter(
    (def) => !def.comingSoon && connectors[def.id] && connectors[def.id].enabled
  ).map((def) => ({
    id: def.id,
    name: def.name
  }));
}

function memioGetConnectorName(id) {
  const def = MEMIO_CONNECTOR_DEFS.find((d) => d.id === id);
  return def ? def.name : id;
}

function memioPadNum(n) {
  return String(n).padStart(2, '0');
}

// Prefers the clip's own (human- or AI-authored) title — never a raw
// content excerpt. Falls back to a date/time stamp only for older clips
// saved before the title field existed. `context.scopeLabel`, when present
// (bulk sends only), notes which filters were active so a batch of clips
// stays distinguishable from each other.
function memioBuildSendTitle(clip, context) {
  const d = new Date(clip.createdAt);
  const datePart = `${d.getFullYear()}-${memioPadNum(d.getMonth() + 1)}-${memioPadNum(d.getDate())}`;
  const timePart = `${memioPadNum(d.getHours())}-${memioPadNum(d.getMinutes())}`;
  const base = clip.title || `${datePart} ${timePart}`;
  const scopeLabel = context && context.scopeLabel;
  return scopeLabel ? `${base} — ${scopeLabel}` : base;
}

function memioStripInvalidFilenameChars(text) {
  return text
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function memioSlugifyForFilename(text) {
  const cleaned = memioStripInvalidFilenameChars(text || '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (!cleaned) return 'untitled';
  if (cleaned.length <= 60) return cleaned;
  // Truncate at a word boundary rather than mid-word — back up to the last
  // hyphen inside the 60-char window, if there is one.
  const truncated = cleaned.slice(0, 60);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
}

// ---------------------------------------------------------------------
// Collation — grouping clips into a shared daily/weekly/monthly note
// instead of one file/page per clip.
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
// by, so it can never vary between clips in the same period.
function memioGetFallbackPeriodTitle(period, clip) {
  const d = new Date(clip.createdAt);
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
function memioGetObsidianCollationFilename(period, clip) {
  const d = new Date(clip.createdAt);
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
async function memioGetAiCollationHeading(period, clip) {
  const connectors = await memioGetConnectors();
  const ai = connectors.ai;
  if (!ai || !ai.enabled || !ai.apiKey) return null;
  try {
    const generate = MEMIO_AI_GENERATORS[ai.provider] || MEMIO_AI_GENERATORS.claude;
    const fallback = memioGetFallbackPeriodTitle(period, clip);
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
// (see memioSendToObsidian) — one clip's worth of content as a markdown H2
// section, matching the exact field order/labels FIX 2 specifies.
function memioBuildObsidianAppendBlock(clip) {
  const tags = (clip.tags || []).join(', ');
  return `\n## ${memioFormatReadableTimestamp(clip.createdAt)}\n${clip.text}\nTags: ${tags}\nSource: ${clip.url || ''}\n`;
}

function memioBuildCollationEntryBlocks(clip) {
  const tags = (clip.tags || []).join(', ');
  const metaLine = `Tags: ${tags} | Source: ${clip.url || ''}`;
  return [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: memioFormatReadableTimestamp(clip.createdAt) } }] }
    },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clip.text } }] } },
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

// Individual mode: filename is the clip's title slug only (no date). If a
// note with that exact name already exists, this clip collates into it as
// a new H2 section by design — same-titled clips are meant to share one
// note — rather than creating a second file or overwriting the first.
async function memioSendObsidianIndividual(clip, apiKey, folder) {
  const filename = `${memioSlugifyForFilename(clip.title)}.md`;
  const exists = await memioObsidianFileExists(folder, filename, apiKey);

  if (!exists) {
    // A bare comma-joined string ("tags: a, b") is valid YAML but parses as
    // one scalar value, not a list — Obsidian then treats "a, b" as a
    // single tag. A flow-sequence ("tags: [a, b]") is unambiguous and is
    // what actually registers as separate tags.
    const obsidianTags = (clip.tags || []).map(memioToObsidianTag).filter(Boolean);
    const body = `---\ncreated: ${clip.createdAt}\ntags: [${obsidianTags.join(', ')}]\nsource: ${clip.url}\n---\n${clip.text}\n`;
    await memioPostToObsidianVault(folder, filename, apiKey, body);
    return;
  }

  await memioPostToObsidianVault(folder, filename, apiKey, memioBuildObsidianAppendBlock(clip));
}

async function memioSendObsidianCollated(clip, apiKey, folder, period) {
  const filename = memioGetObsidianCollationFilename(period, clip);
  const exists = await memioObsidianFileExists(folder, filename, apiKey);

  let body = '';
  if (!exists) {
    const heading = await memioGetAiCollationHeading(period, clip);
    if (heading) body += `# ${heading}\n`;
  }
  body += memioBuildObsidianAppendBlock(clip);

  await memioPostToObsidianVault(folder, filename, apiKey, body);
}

async function memioSendToObsidian(clip, config, context, destinationFolder) {
  const apiKey = memioNormalizeBearerToken(config.apiKey);
  if (!apiKey) throw new Error('Missing API key');
  const rawFolder = destinationFolder || (config.folders && config.folders[0]) || 'clips';
  const folder = rawFolder.replace(/^\/+|\/+$/g, '') || 'clips';

  const period = config.collation;
  if (period && period !== 'individual') {
    await memioSendObsidianCollated(clip, apiKey, folder, period);
    return;
  }

  await memioSendObsidianIndividual(clip, apiKey, folder);
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
// "parent" to use later when actually sending a clip there.
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

async function memioSendToNotionCollated(clip, config, dest, period) {
  const title = memioGetFallbackPeriodTitle(period, clip);
  const blocks = memioBuildCollationEntryBlocks(clip);

  const existingId = await memioSearchNotionPageByTitle(title, config.token, dest);
  if (existingId) {
    await memioAppendNotionBlocks(existingId, blocks, config.token);
    return;
  }

  await memioCreateNotionCollationPage(dest, title, blocks, config.token);
}

async function memioSendToNotion(clip, config, context, destination) {
  const dest = destination || (config.pages && config.pages[0]);
  if (!config.token || !dest || !dest.id) throw new Error('Missing credentials');

  const period = config.collation;
  if (period && period !== 'individual') {
    await memioSendToNotionCollated(clip, config, dest, period);
    return;
  }

  const title = memioBuildSendTitle(clip, context);
  const tags = clip.tags || [];

  if (dest.type === 'page') {
    const metaLine = [tags.length ? `Tags: ${tags.join(', ')}` : null, clip.url ? `Source: ${clip.url}` : null, `Saved: ${clip.createdAt}`]
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
      paragraph: { rich_text: [{ type: 'text', text: { content: clip.text } }] }
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
    clip.url ? `Source: ${clip.url}` : null,
    `Saved: ${clip.createdAt}`
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
    paragraph: { rich_text: [{ type: 'text', text: { content: clip.text } }] }
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

// Tag-based auto-routing: first tagRule whose tag appears on the clip wins;
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
// destination lists below — {value} is exactly what memioSendClipToConnector's
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

async function memioSendClipToConnector(id, clip, context, destinationOverride) {
  const connectors = await memioGetConnectors();
  const config = connectors[id];
  const send = MEMIO_CONNECTOR_SEND[id];
  if (!send || !config) throw new Error('Unknown connector');
  const destination = destinationOverride !== undefined ? destinationOverride : memioResolveDestination(id, config, clip.tags);
  await send(clip, config, context, destination);
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

function memioBuildTitlePrompt(clipText, tags, url) {
  return (
    'Generate a short title of maximum 6 words for this saved clip. ' +
    'Return only the title, no punctuation, no quotes, nothing else.\n\n' +
    `Clip: ${clipText}\nTags: ${(tags || []).join(', ')}\nSource: ${url || ''}`
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

async function memioGenerateTitle(clipText, tags, url) {
  const connectors = await memioGetConnectors();
  const ai = connectors.ai || {};
  if (!ai.enabled || !ai.apiKey) throw new Error('NO_KEY');

  const generate = MEMIO_AI_GENERATORS[ai.provider] || MEMIO_AI_GENERATORS.claude;
  const prompt = memioBuildTitlePrompt(clipText, tags, url);
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
function memioRenderDestinationList(body, def) {
  body.innerHTML = '';

  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent = def.destinationsSubline;
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const config = connectors[def.id];
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
        await memioPatchConnector(def.id, { [def.destinationsKey]: updated });
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
        await memioPatchConnector(def.id, { [def.destinationsKey]: reordered });
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
        await memioPatchConnector(def.id, { folders: updated });
        await render();
        return;
      }

      // Notion: fetch the real title before saving, so the destination list
      // shows a human-readable name instead of a raw page/database ID.
      try {
        const current = await memioGetConnectors();
        const { title, type } = await memioFetchNotionTitle(value, current.notion.token);
        const updated = items.concat([{ id: value, title, type }]);
        await memioPatchConnector('notion', { pages: updated });
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
function memioRenderTagRuleBuilder(body, def) {
  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent = def.routingSubline;
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const config = connectors[def.id];
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
        // Re-read fresh from storage rather than reusing the `rules` array
        // closured at render time — if another rule's field was edited (or
        // added/removed) since this render, that stale snapshot would
        // silently overwrite those changes when written back.
        const freshConnectors = await memioGetConnectors();
        const freshRules = (freshConnectors[def.id].tagRules || []).slice();
        if (!freshRules[index]) return;
        freshRules[index] = Object.assign({}, freshRules[index], { tag: tagInput.value.trim() });
        await memioPatchConnector(def.id, { tagRules: freshRules });
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
        const freshConnectors = await memioGetConnectors();
        const freshRules = (freshConnectors[def.id].tagRules || []).slice();
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
        await memioPatchConnector(def.id, { tagRules: freshRules });
        await render();
      });
      row.appendChild(select);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'destination-remove';
      removeBtn.setAttribute('aria-label', 'Remove rule');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async () => {
        const freshConnectors = await memioGetConnectors();
        const freshRules = (freshConnectors[def.id].tagRules || []).filter((_, i) => i !== index);
        await memioPatchConnector(def.id, { tagRules: freshRules });
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
      const freshConnectors = await memioGetConnectors();
      const freshRules = (freshConnectors[def.id].tagRules || []).concat([newRule]);
      await memioPatchConnector(def.id, { tagRules: freshRules });
      await render();
    });
    body.appendChild(addLink);
  }

  render();
}

async function memioRenderConnectorSections() {
  const container = memioQ('connectorSections');
  if (!container) return;

  const connectors = await memioGetConnectors();
  container.innerHTML = '';

  MEMIO_CONNECTOR_DEFS.forEach((def) => {
    const state = connectors[def.id];

    const section = document.createElement('div');
    section.className = 'connector-section';
    section.dataset.connectorId = def.id;
    if (def.comingSoon) section.classList.add('coming-soon');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'connector-header';
    const badge = def.comingSoon ? '<span class="connector-badge">Coming soon</span>' : '';
    const statusDot = def.comingSoon
      ? ''
      : `<span class="connector-status-dot" id="statusDot-${def.id}" data-active="${!!state.enabled}"></span>`;
    header.innerHTML = `<span class="connector-name">${statusDot}${memioEscapeText(def.name)}</span><span class="connector-header-right">${badge}<span class="connector-chevron">&#8250;</span></span>`;

    const body = document.createElement('div');
    body.className = 'connector-body';
    body.hidden = true;

    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.classList.toggle('open', !body.hidden);
    });

    if (def.comingSoon) {
      const msg = document.createElement('p');
      msg.className = 'instructions-text coming-soon-text';
      msg.textContent = def.comingSoonMessage;
      body.appendChild(msg);

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
      return;
    }

    const statusDotEl = header.querySelector(`#statusDot-${def.id}`);

    // ---- Level 2, subsection 1: CONFIGURE (open by default) ----
    const configureSub = memioBuildSubsection('CONFIGURE', true);
    configureSub.wrap.dataset.subsection = 'configure';
    const configureBody = configureSub.body;

    const toggleRow = document.createElement('label');
    toggleRow.className = 'toggle-row';
    const toggleText = document.createElement('span');
    toggleText.textContent = 'Enable';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'toggle-switch';
    toggleInput.checked = !!state.enabled;
    toggleRow.appendChild(toggleText);
    toggleRow.appendChild(toggleInput);
    configureBody.appendChild(toggleRow);

    toggleInput.addEventListener('change', async () => {
      await memioPatchConnector(def.id, { enabled: toggleInput.checked });
      if (statusDotEl) statusDotEl.dataset.active = String(toggleInput.checked);
    });

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
    configureBody.appendChild(instructions);

    const fieldEls = {};
    def.fields.forEach((field) => {
      const input = document.createElement('input');
      input.type = field.type;
      input.className = 'cred-input';
      input.placeholder = field.placeholder;
      input.value = state[field.key] || '';
      input.addEventListener('change', async () => {
        await memioPatchConnector(def.id, { [field.key]: input.value });
      });
      fieldEls[field.key] = input;
      configureBody.appendChild(input);
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

      const config = { enabled: toggleInput.checked };
      def.fields.forEach((field) => {
        config[field.key] = fieldEls[field.key].value;
      });
      await memioPatchConnector(def.id, config);

      try {
        await MEMIO_CONNECTOR_TESTS[def.id](config);
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
    configureBody.appendChild(actions);
    configureBody.appendChild(reasonEl);

    body.appendChild(configureSub.wrap);

    // ---- Level 2, subsection 2: FOLDERS / PAGES & DATABASES (collapsed) ----
    const destinationsSub = memioBuildSubsection(def.destinationsLabel, false);
    destinationsSub.wrap.dataset.subsection = 'destinations';
    memioRenderDestinationList(destinationsSub.body, def);
    body.appendChild(destinationsSub.wrap);

    // ---- Level 2, subsection 3: AUTO-ROUTING RULES (collapsed) ----
    const routingSub = memioBuildSubsection('AUTO-ROUTING RULES', false);
    routingSub.wrap.dataset.subsection = 'routing';
    memioRenderTagRuleBuilder(routingSub.body, def);
    body.appendChild(routingSub.wrap);

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });
}

// Renders the COLLATION subsection — radio group choosing how clips for a
// given connector are grouped when sent (individual/daily/weekly/monthly).
// Per-connector, independent of the other connector's setting.
function memioRenderCollationSection(body, def) {
  async function render() {
    body.innerHTML = '';

    const subline = document.createElement('p');
    subline.className = 'settings-helper-text';
    subline.textContent = 'Choose how clips are grouped when sent.';
    body.appendChild(subline);

    const connectors = await memioGetConnectors();
    const current = connectors[def.id].collation || 'individual';

    const options = [
      ['individual', 'Individual notes (one per clip)'],
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
      input.name = `collation-${def.id}`;
      input.value = value;
      input.checked = current === value;
      input.addEventListener('change', async () => {
        if (input.checked) await memioPatchConnector(def.id, { collation: value });
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
// enabled connectors only (re-rendered every time the tab is opened, since
// which connectors are enabled can change while this tab isn't visible).
async function memioRenderConfigureSections(container) {
  if (!container) return;
  container.innerHTML = '';

  const connectors = await memioGetConnectors();
  const enabledDefs = MEMIO_CONNECTOR_DEFS.filter((def) => !def.comingSoon && connectors[def.id] && connectors[def.id].enabled);

  if (enabledDefs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'configure-empty-state';
    empty.innerHTML = 'No apps connected yet.<br>Connect and enable one under Connectors first.';
    container.appendChild(empty);
    return;
  }

  enabledDefs.forEach((def) => {
    const section = document.createElement('div');
    section.className = 'connector-section configure-connector-section';
    section.dataset.connectorId = def.id;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'connector-header';
    header.innerHTML = `<span class="connector-name">${memioEscapeText(def.name)}</span><span class="connector-header-right"><span class="connector-chevron">&#8250;</span></span>`;

    const body = document.createElement('div');
    body.className = 'connector-body';
    body.hidden = true;

    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.classList.toggle('open', !body.hidden);
    });

    const destinationsSub = memioBuildSubsection(def.destinationsLabel, true);
    destinationsSub.wrap.dataset.subsection = 'destinations';
    memioRenderDestinationList(destinationsSub.body, def);
    body.appendChild(destinationsSub.wrap);

    const routingSub = memioBuildSubsection('AUTO-ROUTING RULES', false);
    routingSub.wrap.dataset.subsection = 'routing';
    memioRenderTagRuleBuilder(routingSub.body, def);
    body.appendChild(routingSub.wrap);

    const collationSub = memioBuildSubsection('COLLATION', false);
    collationSub.wrap.dataset.subsection = 'collation';
    memioRenderCollationSection(collationSub.body, def);
    body.appendChild(collationSub.wrap);

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });
}

// Best-effort deep link used by the send-destination popover's "Add one
// under Configure" link: opens the Configure tab, expands the given
// connector's row and its FOLDERS/PAGES & DATABASES subsection.
async function memioOpenConfigureDestinations(connectorId) {
  const tabBtn = memioQ('settingsTabConfigure');
  if (tabBtn) tabBtn.click();

  const container = memioQ('configureSections');
  await memioRenderConfigureSections(container);
  if (!container) return;

  const section = Array.from(container.querySelectorAll('.configure-connector-section')).find((s) => s.dataset.connectorId === connectorId);
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
