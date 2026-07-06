chrome.runtime.onInstalled.addListener(async () => {
  const { fwiw_settings } = await chrome.storage.sync.get('fwiw_settings');
  if (!fwiw_settings) {
    await chrome.storage.sync.set({
      fwiw_settings: { accentName: 'yellow', theme: 'system' }
    });
  }

  const { fwiw_clips } = await chrome.storage.sync.get('fwiw_clips');
  if (!fwiw_clips) {
    await chrome.storage.sync.set({ fwiw_clips: [] });
  }

  const { fwiw_onboarded } = await chrome.storage.sync.get('fwiw_onboarded');
  if (fwiw_onboarded === undefined) {
    await chrome.storage.sync.set({ fwiw_onboarded: false });
  }

  const { connectors } = await chrome.storage.sync.get('connectors');
  if (!connectors) {
    await chrome.storage.sync.set({
      connectors: {
        obsidian: { enabled: false, apiKey: '', folderPath: '' },
        notion: { enabled: false, token: '', pageId: '' },
        drive: { enabled: false, apiKey: '', folderId: '' },
        ai: { provider: 'claude', apiKey: '' }
      }
    });
  }
});
