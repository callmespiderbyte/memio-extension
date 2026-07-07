const MEMIO_CONTENT_FILES = ['settings.js', 'connectors.js', 'tag-input.js', 'content.js'];

// One-time migration from the extension's old "fwiw" naming — copies any
// existing data under the old storage keys to the new "memio" keys, so
// renaming the product doesn't orphan memos/settings someone already saved.
// The "fwiw_clips"/"fwiw_draft" literals here name a fixed historical key
// that will never change, regardless of later "clip" → "memo" terminology
// renames — do not rename these strings alongside such renames.
async function migrateLegacyFwiwStorage() {
  const legacy = await chrome.storage.sync.get(['fwiw_clips', 'fwiw_settings']);
  const current = await chrome.storage.sync.get(['memio_memos', 'memio_settings']);
  const patch = {};

  if (legacy.fwiw_clips && !current.memio_memos) {
    patch.memio_memos = legacy.fwiw_clips;
  }
  if (legacy.fwiw_settings && !current.memio_settings) {
    patch.memio_settings = legacy.fwiw_settings;
  }
  if (Object.keys(patch).length) {
    await chrome.storage.sync.set(patch);
    await chrome.storage.sync.remove(['fwiw_clips', 'fwiw_settings']);
  }

  const legacyDraft = await chrome.storage.local.get('fwiw_draft');
  if (legacyDraft.fwiw_draft) {
    await chrome.storage.local.set({ memio_draft: legacyDraft.fwiw_draft });
    await chrome.storage.local.remove('fwiw_draft');
  }
}

// One-time migration from "clips" to "memos" terminology — copies any
// existing data under the old memio_clips key (used between the Memio
// rename and this terminology change) to memio_memos.
async function migrateClipsToMemos() {
  const legacy = await chrome.storage.sync.get('memio_clips');
  const current = await chrome.storage.sync.get('memio_memos');
  if (legacy.memio_clips && !current.memio_memos) {
    await chrome.storage.sync.set({ memio_memos: legacy.memio_clips });
    await chrome.storage.sync.remove('memio_clips');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyFwiwStorage();
  await migrateClipsToMemos();

  const { memio_settings } = await chrome.storage.sync.get('memio_settings');
  if (!memio_settings) {
    await chrome.storage.sync.set({
      memio_settings: { accentName: 'yellow', theme: 'system' }
    });
  }

  const { memio_memos } = await chrome.storage.sync.get('memio_memos');
  if (!memio_memos) {
    await chrome.storage.sync.set({ memio_memos: [] });
  }

  const { connectors } = await chrome.storage.sync.get('connectors');
  if (!connectors) {
    // Credentials (apiKey/token) intentionally aren't seeded here — they
    // live in chrome.storage.local (see connectors.js), never .sync.
    await chrome.storage.sync.set({
      connectors: {
        obsidian: { enabled: false, folders: [], tagRules: [], collation: 'individual' },
        notion: { enabled: false, pages: [], tagRules: [], collation: 'individual' },
        drive: { enabled: false, folderId: '' },
        ai: { enabled: false, provider: 'claude' }
      }
    });
  }

  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.memio_memos) updateBadge();
});

async function updateBadge() {
  const { memio_memos } = await chrome.storage.sync.get('memio_memos');
  const count = (memio_memos || []).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#888580' });
}

// Per-tab (not global) so a failure on one restricted tab doesn't paint
// every other tab's icon with the same warning.
async function markTabUnsupported(tabId) {
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#C0392B' });
  await chrome.action.setTitle({ tabId, title: "Memio can't run on this page" });
}

// Clears a previously-set per-tab override (empty string reverts to the
// global badge/title rather than just hiding it) — needed so the "!"
// doesn't linger if the user navigates that same tab to a normal page.
async function clearTabUnsupported(tabId) {
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: '' });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'MEMIO_TOGGLE_WINDOW' });
    await clearTabUnsupported(tab.id);
    return;
  } catch (e) {
    // Content scripts aren't retroactively injected into tabs that were
    // already open before install/reload — fall back to injecting them now.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: MEMIO_CONTENT_FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'MEMIO_TOGGLE_WINDOW' });
    await clearTabUnsupported(tab.id);
  } catch (e) {
    // Some pages (chrome://, the Web Store, etc.) can't be scripted at all —
    // let the user know why nothing happened instead of failing silently.
    await markTabUnsupported(tab.id);
  }
});
