const FWIW_CLIPS_KEY = 'fwiw_clips';

function fwiwUuid() {
  return crypto.randomUUID();
}

async function getClips() {
  const { fwiw_clips } = await chrome.storage.sync.get(FWIW_CLIPS_KEY);
  return fwiw_clips || [];
}

async function saveClips(clips) {
  await chrome.storage.sync.set({ [FWIW_CLIPS_KEY]: clips });
}

async function updateClipCount() {
  const clips = await getClips();
  document.getElementById('clipCount').textContent = `${clips.length} save${clips.length === 1 ? '' : 's'}`;
}

async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  if (!tab || !tab.id) return { text: '', url: '' };

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'FWIW_GET_SELECTION' });
    if (response) {
      return { text: response.text || '', url: response.url || tab.url || '' };
    }
  } catch (e) {
    // Content script isn't loaded in this tab (e.g. it was open before the
    // extension was installed/reloaded) — fall back to direct injection.
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        text: window.getSelection ? window.getSelection().toString() : '',
        url: location.href
      })
    });
    const result = injection && injection.result;
    return { text: (result && result.text) || '', url: (result && result.url) || tab.url || '' };
  } catch (e) {
    return { text: '', url: tab.url || '' };
  }
}

const FWIW_DRAFT_KEY = 'fwiw_draft';

async function getDraft() {
  const { fwiw_draft } = await chrome.storage.local.get(FWIW_DRAFT_KEY);
  return fwiw_draft || null;
}

async function saveDraft(draft) {
  await chrome.storage.local.set({ [FWIW_DRAFT_KEY]: draft });
}

async function clearDraft() {
  await chrome.storage.local.remove(FWIW_DRAFT_KEY);
}

async function checkOnboarding() {
  const { fwiw_onboarded } = await chrome.storage.sync.get('fwiw_onboarded');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const welcomeSubline = document.getElementById('welcomeSubline');
  const clipCount = document.getElementById('clipCount');

  if (fwiw_onboarded) {
    welcomeScreen.hidden = true;
    welcomeSubline.hidden = true;
    clipCount.hidden = false;
    return;
  }

  welcomeScreen.hidden = false;
  welcomeSubline.hidden = false;
  clipCount.hidden = true;

  await chrome.storage.sync.set({ fwiw_onboarded: true });
}

async function autoSendClipIfEnabled(clip) {
  const { autoSendOnSave } = await getStoredThemeSettings();
  if (!autoSendOnSave) return;

  const enabled = await fwiwGetEnabledConnectors();
  if (enabled.length === 0) return;

  const sentTo = [];
  for (const connector of enabled) {
    try {
      await fwiwSendClipToConnector(connector.id, clip);
      sentTo.push(connector.id);
    } catch (err) {
      // Leave it off sentTo — it'll still show up in History with a manual
      // "Send to..." option for whichever connector didn't go through.
    }
  }

  if (sentTo.length === 0) return;
  const clips = await getClips();
  const idx = clips.findIndex((c) => c.id === clip.id);
  if (idx !== -1) {
    clips[idx] = Object.assign({}, clips[idx], { sentTo });
    await saveClips(clips);
  }
}

async function init() {
  await checkOnboarding();
  await updateClipCount();

  const titleInput = document.getElementById('clipTitle');
  const titleHint = document.getElementById('titleHint');
  const wandError = document.getElementById('wandError');
  const wandBtn = document.getElementById('generateTitleBtn');
  const textarea = document.getElementById('clipText');
  const sourceUrlEl = document.getElementById('sourceUrl');
  const saveBtn = document.getElementById('saveBtn');
  const tagInputField = document.getElementById('tagInputField');
  const savedConfirm = document.getElementById('savedConfirm');

  const draft = await getDraft();
  let url;
  let initialTags = [];

  if (draft && (draft.text || '').trim()) {
    // Restore in-progress typing left over from the last time the popup was
    // closed, instead of overwriting it with whatever's selected right now.
    titleInput.value = draft.title || '';
    textarea.value = draft.text || '';
    initialTags = draft.tags || [];
    url = draft.url || '';
  } else {
    const context = await getPageContext();
    textarea.value = context.text;
    url = context.url;
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

  const tagWidget = fwiwCreateTagInput(tagInputField, initialTags, persistDraft);
  textarea.addEventListener('input', persistDraft);

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
    const connectors = await fwiwGetConnectors();
    const hasKey = !!(connectors.ai && connectors.ai.apiKey);
    wandBtn.title = hasKey ? 'Generate title' : 'Add an AI key in Settings to use this';
  }

  textarea.addEventListener('input', () => {
    wandError.hidden = true;
    refreshWandButton();
  });
  await refreshWandButton();

  wandBtn.addEventListener('click', async () => {
    if (wandBtn.disabled || wandBtn.classList.contains('spinner')) return;

    wandError.hidden = true;

    const connectors = await fwiwGetConnectors();
    if (!connectors.ai || !connectors.ai.apiKey) {
      wandBtn.title = 'Add an AI key in Settings to use this';
      wandError.textContent = 'Add an AI key in Settings to use this.';
      wandError.hidden = false;
      return;
    }

    wandBtn.classList.add('spinner');
    try {
      const generated = await fwiwGenerateTitle(textarea.value.trim(), tagWidget.getTags(), sourceUrlEl.dataset.url || '');
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
    const clipTitle = titleInput.value.trim();
    if (!clipTitle) {
      titleInput.classList.add('invalid');
      titleHint.hidden = false;
      return;
    }

    const clipText = textarea.value.trim();

    const clip = {
      id: fwiwUuid(),
      title: clipTitle,
      text: clipText,
      tags: tagWidget.getTags(),
      createdAt: new Date().toISOString(),
      url: sourceUrlEl.dataset.url || ''
    };

    const clips = await getClips();
    clips.unshift(clip);
    await saveClips(clips);
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

    await updateClipCount();
    await autoSendClipIfEnabled(clip);
  });
}

document.addEventListener('DOMContentLoaded', init);
