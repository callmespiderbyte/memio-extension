const FWIW_CONNECTORS_KEY = 'connectors';

const FWIW_CONNECTOR_DEFAULTS = {
  obsidian: { enabled: false, apiKey: '', folderPath: '' },
  notion: { enabled: false, token: '', pageId: '' },
  drive: { enabled: false, apiKey: '', folderId: '' },
  ai: { provider: 'claude', apiKey: '' }
};

const FWIW_AI_PROVIDERS = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'ChatGPT (OpenAI)' },
  { id: 'gemini', label: 'Gemini (Google)' }
];

// Model IDs are named constants for a reason: providers deprecate/rename
// lightweight models fairly often. If title generation starts failing with
// a 404/model-not-found, this is the first place to check.
const FWIW_AI_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash-lite'
};

const FWIW_CONNECTOR_DEFS = [
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
    fields: [
      { key: 'apiKey', type: 'password', placeholder: 'API key' },
      { key: 'folderPath', type: 'text', placeholder: '/clips' }
    ]
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
      'Open or create a Notion database where clips will be saved. Each clip will appear as a new row.',
      'Click the "..." menu top right → Connections → select your integration',
      'Copy the Database ID from the database URL: notion.so/Your-Database-{THIS-IS-THE-ID}',
      'Paste it below'
    ],
    fields: [
      { key: 'token', type: 'password', placeholder: 'Integration token' },
      { key: 'pageId', type: 'text', placeholder: 'Database ID' }
    ]
  },
  {
    id: 'drive',
    name: 'Google Drive',
    comingSoon: true,
    comingSoonMessage: 'Google Drive requires account connection — coming in a future update.'
  }
];

async function fwiwGetConnectors() {
  const { connectors } = await chrome.storage.sync.get(FWIW_CONNECTORS_KEY);
  const merged = {};
  Object.keys(FWIW_CONNECTOR_DEFAULTS).forEach((id) => {
    merged[id] = Object.assign({}, FWIW_CONNECTOR_DEFAULTS[id], connectors && connectors[id]);
  });
  return merged;
}

async function fwiwPatchConnector(id, patch) {
  const connectors = await fwiwGetConnectors();
  connectors[id] = Object.assign({}, connectors[id], patch);
  await chrome.storage.sync.set({ connectors });
  return connectors;
}

async function fwiwGetEnabledConnectors() {
  const connectors = await fwiwGetConnectors();
  return FWIW_CONNECTOR_DEFS.filter(
    (def) => !def.comingSoon && connectors[def.id] && connectors[def.id].enabled
  ).map((def) => ({
    id: def.id,
    name: def.name
  }));
}

function fwiwGetConnectorName(id) {
  const def = FWIW_CONNECTOR_DEFS.find((d) => d.id === id);
  return def ? def.name : id;
}

function fwiwPadNum(n) {
  return String(n).padStart(2, '0');
}

// Prefers the clip's own (human- or AI-authored) title — never a raw
// content excerpt. Falls back to a date/time stamp only for older clips
// saved before the title field existed. `context.scopeLabel`, when present
// (bulk sends only), notes which filters were active so a batch of clips
// stays distinguishable from each other.
function fwiwBuildSendTitle(clip, context) {
  const d = new Date(clip.createdAt);
  const datePart = `${d.getFullYear()}-${fwiwPadNum(d.getMonth() + 1)}-${fwiwPadNum(d.getDate())}`;
  const timePart = `${fwiwPadNum(d.getHours())}-${fwiwPadNum(d.getMinutes())}`;
  const base = clip.title || `${datePart} ${timePart}`;
  const scopeLabel = context && context.scopeLabel;
  return scopeLabel ? `${base} — ${scopeLabel}` : base;
}

function fwiwStripInvalidFilenameChars(text) {
  return text
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fwiwNormalizeBearerToken(raw) {
  return (raw || '').trim().replace(/^bearer\s+/i, '');
}

// Obsidian tags can't contain spaces — collapse each tag's internal
// whitespace into a single word (kebab-case) before writing frontmatter.
function fwiwToObsidianTag(tag) {
  return tag.trim().replace(/\s+/g, '-');
}

async function fwiwSendToObsidian(clip, config, context) {
  const apiKey = fwiwNormalizeBearerToken(config.apiKey);
  if (!apiKey) throw new Error('Missing API key');
  const title = fwiwStripInvalidFilenameChars(fwiwBuildSendTitle(clip, context)) || 'clip';
  const filename = `${title}.md`;
  const folder = (config.folderPath || 'clips').replace(/^\/+|\/+$/g, '') || 'clips';

  // A bare comma-joined string ("tags: a, b") is valid YAML but parses as
  // one scalar value, not a list — Obsidian then treats "a, b" as a single
  // tag. A flow-sequence ("tags: [a, b]") is unambiguous and is what
  // actually registers as separate tags.
  const obsidianTags = (clip.tags || []).map(fwiwToObsidianTag).filter(Boolean);
  const body = `---\ncreated: ${clip.createdAt}\ntags: [${obsidianTags.join(', ')}]\nsource: ${clip.url}\n---\n${clip.text}\n`;

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

async function fwiwGetNotionSchema(databaseId, token) {
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

async function fwiwSendToNotion(clip, config, context) {
  if (!config.token || !config.pageId) throw new Error('Missing credentials');

  const { titleKey, multiSelectKey } = await fwiwGetNotionSchema(config.pageId, config.token);
  const title = fwiwBuildSendTitle(clip, context);
  const tags = clip.tags || [];

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
      parent: { database_id: config.pageId },
      properties,
      children
    })
  });
  if (!res.ok) throw new Error(`Notion responded ${res.status}`);
}

const FWIW_CONNECTOR_SEND = {
  obsidian: fwiwSendToObsidian,
  notion: fwiwSendToNotion
};

async function fwiwSendClipToConnector(id, clip, context) {
  const connectors = await fwiwGetConnectors();
  const config = connectors[id];
  const send = FWIW_CONNECTOR_SEND[id];
  if (!send || !config) throw new Error('Unknown connector');
  await send(clip, config, context);
}

const FWIW_CONNECTOR_TESTS = {
  obsidian: async (config) => {
    const apiKey = fwiwNormalizeBearerToken(config.apiKey);
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
    if (!config.token || !config.pageId) throw new Error('Missing credentials');
    const res = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(config.pageId)}`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': '2022-06-28'
      }
    });
    if (!res.ok) throw new Error(`Notion responded ${res.status}`);
  }
};

function fwiwBuildTitlePrompt(clipText, tags, url) {
  return (
    'Generate a short title of maximum 6 words for this saved clip. ' +
    'Return only the title, no punctuation, no quotes, nothing else.\n\n' +
    `Clip: ${clipText}\nTags: ${(tags || []).join(', ')}\nSource: ${url || ''}`
  );
}

async function fwiwGenerateTitleClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: FWIW_AI_MODELS.claude,
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
async function fwiwGenerateTitleOpenAi(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: FWIW_AI_MODELS.openai,
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
async function fwiwGenerateTitleGemini(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${FWIW_AI_MODELS.gemini}:generateContent?key=${encodeURIComponent(apiKey)}`,
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

const FWIW_AI_GENERATORS = {
  claude: fwiwGenerateTitleClaude,
  openai: fwiwGenerateTitleOpenAi,
  gemini: fwiwGenerateTitleGemini
};

async function fwiwGenerateTitle(clipText, tags, url) {
  const connectors = await fwiwGetConnectors();
  const ai = connectors.ai || {};
  if (!ai.apiKey) throw new Error('NO_KEY');

  const generate = FWIW_AI_GENERATORS[ai.provider] || FWIW_AI_GENERATORS.claude;
  const prompt = fwiwBuildTitlePrompt(clipText, tags, url);
  const title = await generate(ai.apiKey, prompt);
  if (!title) throw new Error('Empty response from AI provider');
  return title;
}

// Runs the exact same code path as real title generation (same provider
// function, same auth), just with a trivial prompt — so a green "Connected"
// here is a real guarantee the wand button will work, not just that the key
// looks well-formed.
async function fwiwTestAiConnection(config) {
  if (!config.apiKey) throw new Error('Missing API key');
  const generate = FWIW_AI_GENERATORS[config.provider] || FWIW_AI_GENERATORS.claude;
  const reply = await generate(config.apiKey, 'Reply with only the single word: OK');
  if (!reply) throw new Error('Empty response from AI provider');
}

function fwiwEscapeText(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function fwiwRenderConnectorSections() {
  const container = document.getElementById('connectorSections');
  if (!container) return;

  const connectors = await fwiwGetConnectors();
  container.innerHTML = '';

  FWIW_CONNECTOR_DEFS.forEach((def) => {
    const state = connectors[def.id];

    const section = document.createElement('div');
    section.className = 'connector-section';
    if (def.comingSoon) section.classList.add('coming-soon');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'connector-header';
    const badge = def.comingSoon ? '<span class="connector-badge">Coming soon</span>' : '';
    header.innerHTML = `<span class="connector-name">${fwiwEscapeText(def.name)}</span><span class="connector-header-right">${badge}<span class="connector-chevron">&#8250;</span></span>`;

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
    body.appendChild(toggleRow);

    toggleInput.addEventListener('change', async () => {
      await fwiwPatchConnector(def.id, { enabled: toggleInput.checked });
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
    body.appendChild(instructions);

    const fieldEls = {};
    def.fields.forEach((field) => {
      const input = document.createElement('input');
      input.type = field.type;
      input.className = 'cred-input';
      input.placeholder = field.placeholder;
      input.value = state[field.key] || '';
      input.addEventListener('change', async () => {
        await fwiwPatchConnector(def.id, { [field.key]: input.value });
      });
      fieldEls[field.key] = input;
      body.appendChild(input);
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
      await fwiwPatchConnector(def.id, config);

      try {
        await FWIW_CONNECTOR_TESTS[def.id](config);
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
    body.appendChild(actions);
    body.appendChild(reasonEl);

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });

  await fwiwRenderAiSection(container);
}

async function fwiwRenderAiSection(container) {
  const connectors = await fwiwGetConnectors();
  const ai = connectors.ai || { provider: 'claude', apiKey: '' };

  const section = document.createElement('div');
  section.className = 'connector-section';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'connector-header';
  header.innerHTML =
    '<span class="connector-name">AI (optional)</span>' +
    '<span class="connector-header-right"><span class="connector-chevron">&#8250;</span></span>';

  const body = document.createElement('div');
  body.className = 'connector-body';
  body.hidden = true;

  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    header.classList.toggle('open', !body.hidden);
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
  FWIW_AI_PROVIDERS.forEach((p) => {
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
    await fwiwPatchConnector('ai', { provider, apiKey: keyInput.value.trim() });
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
    await fwiwPatchConnector('ai', { provider, apiKey });

    try {
      await fwiwTestAiConnection({ provider, apiKey });
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

document.addEventListener('DOMContentLoaded', fwiwRenderConnectorSections);
