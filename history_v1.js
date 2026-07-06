const FWIW_CLIPS_KEY = 'fwiw_clips';

let allClips = [];
let selectedTags = [];

async function getClips() {
  const { fwiw_clips } = await chrome.storage.sync.get(FWIW_CLIPS_KEY);
  return fwiw_clips || [];
}

async function saveClips(clips) {
  await chrome.storage.sync.set({ [FWIW_CLIPS_KEY]: clips });
}

function truncateUrl(url, maxLen = 42) {
  if (!url) return '';
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 1) + '…';
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function fwiwIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

function matchesTimeRange(clipDate, range, now) {
  if (!range || range === 'all') return true;
  if (range === 'today') return clipDate.toDateString() === now.toDateString();
  if (range === 'week') return fwiwIsoWeekKey(clipDate) === fwiwIsoWeekKey(now);
  if (range === 'month') return clipDate.getFullYear() === now.getFullYear() && clipDate.getMonth() === now.getMonth();
  if (range === 'year') return clipDate.getFullYear() === now.getFullYear();
  return true;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadClips() {
  allClips = await getClips();
  allClips.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  populateFilters();
  renderClips();
  updateClipCount();
  await refreshSendAllVisibility();
}

function updateClipCount() {
  document.getElementById('clipCount').textContent = `${allClips.length} save${allClips.length === 1 ? '' : 's'}`;
}

function populateFilters() {
  const tagSet = new Set();
  allClips.forEach((clip) => (clip.tags || []).forEach((t) => tagSet.add(t)));

  selectedTags = selectedTags.filter((t) => tagSet.has(t));
  renderTagFilterOptions(Array.from(tagSet).sort());
  updateTagFilterTrigger();
}

function updateTagFilterTrigger() {
  const trigger = document.getElementById('tagFilterTrigger');
  const clearBtn = document.getElementById('tagFilterClear');

  if (selectedTags.length === 0) {
    trigger.textContent = 'All tags';
  } else if (selectedTags.length === 1) {
    trigger.textContent = selectedTags[0];
  } else {
    trigger.textContent = `${selectedTags.length} tags`;
  }

  clearBtn.hidden = selectedTags.length === 0;
}

function renderTagFilterOptions(tags) {
  const optionsHost = document.getElementById('tagFilterOptions');
  optionsHost.innerHTML = '';

  tags.forEach((tag) => {
    const label = document.createElement('label');
    label.className = 'tag-filter-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedTags.includes(tag);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!selectedTags.includes(tag)) selectedTags.push(tag);
      } else {
        selectedTags = selectedTags.filter((t) => t !== tag);
      }
      updateTagFilterTrigger();
      renderClips();
    });

    const text = document.createElement('span');
    text.textContent = tag;

    label.appendChild(checkbox);
    label.appendChild(text);
    optionsHost.appendChild(label);
  });
}

function getFilteredClips() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const timeRange = document.getElementById('timeRangeFilter').value;
  const now = new Date();

  return allClips.filter((clip) => {
    if (query) {
      const haystack = ((clip.title || '') + ' ' + clip.text + ' ' + (clip.tags || []).join(' ')).toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (selectedTags.length && !selectedTags.every((t) => (clip.tags || []).includes(t))) return false;
    if (!matchesTimeRange(new Date(clip.createdAt), timeRange, now)) return false;
    return true;
  });
}

const FWIW_TIME_RANGE_LABELS = {
  all: '',
  today: 'today',
  week: 'this week',
  month: 'this month',
  year: 'this year'
};

function buildScopeLabel() {
  const timeRange = document.getElementById('timeRangeFilter').value;
  const query = document.getElementById('searchInput').value.trim();

  const parts = [];
  if (FWIW_TIME_RANGE_LABELS[timeRange]) parts.push(FWIW_TIME_RANGE_LABELS[timeRange]);
  if (selectedTags.length === 1) parts.push(`tag: ${selectedTags[0]}`);
  else if (selectedTags.length > 1) parts.push(`tags: ${selectedTags.join(', ')}`);
  if (query) parts.push(`search: ${query}`);

  return parts.join(', ');
}

function getScopedClips(scope) {
  const now = new Date();
  if (scope === 'view') return getFilteredClips();
  if (scope === 'today' || scope === 'week' || scope === 'month') {
    return allClips.filter((c) => matchesTimeRange(new Date(c.createdAt), scope, now));
  }
  return allClips;
}

function renderClips() {
  const list = document.getElementById('clipList');
  const emptyState = document.getElementById('emptyState');
  const filtered = getFilteredClips();

  list.innerHTML = '';

  if (allClips.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = 'Nothing saved yet. fwiw, start somewhere.';
    return;
  }

  if (filtered.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = 'No clips match that. Try broader terms.';
    return;
  }

  emptyState.hidden = true;

  filtered.forEach((clip) => {
    list.appendChild(buildClipCard(clip));
  });
}

async function buildSendToControl(clip, statusHost) {
  const enabled = await fwiwGetEnabledConnectors();
  if (enabled.length === 0) return null;

  const alreadySent = clip.sentTo || [];
  const available = enabled.filter((c) => !alreadySent.includes(c.id));

  const wrap = document.createElement('div');
  wrap.className = 'send-to-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'send-to-btn';
  btn.textContent = 'Send to...';

  if (available.length === 0) {
    btn.disabled = true;
    btn.classList.add('exhausted');
    btn.title = 'Already sent to every enabled connector';
    wrap.appendChild(btn);
    return wrap;
  }

  const menu = document.createElement('div');
  menu.className = 'send-to-menu';
  menu.hidden = true;

  available.forEach((c) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = `Send to ${c.name}`;
    item.addEventListener('click', async () => {
      menu.hidden = true;
      btn.disabled = true;
      btn.classList.add('spinner');
      btn.textContent = '';
      statusHost.textContent = '';
      statusHost.className = 'send-status';

      try {
        await fwiwSendClipToConnector(c.id, clip);
        statusHost.textContent = 'Sent.';
        statusHost.className = 'send-status success';
        await updateClip(clip.id, { sentTo: Array.from(new Set([...(clip.sentTo || []), c.id])) });
        setTimeout(() => {
          populateFilters();
          renderClips();
        }, 1500);
      } catch (err) {
        statusHost.innerHTML = '';
        statusHost.className = 'send-status failed';
        statusHost.appendChild(document.createTextNode('Failed. '));
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'send-status-link';
        link.textContent = 'Check settings';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          fwiwOpenSettingsOverlay();
        });
        statusHost.appendChild(link);
      } finally {
        btn.disabled = false;
        btn.classList.remove('spinner');
        btn.textContent = 'Send to...';
      }
    });
    menu.appendChild(item);
  });

  btn.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

function buildSentBadges(clip) {
  const sentTo = clip.sentTo || [];
  if (!sentTo.length) return null;
  const row = document.createElement('div');
  row.className = 'sent-badges';
  sentTo.forEach((id) => {
    const badge = document.createElement('span');
    badge.className = 'sent-badge';
    badge.textContent = `Sent to ${fwiwGetConnectorName(id)}`;
    row.appendChild(badge);
  });
  return row;
}

function buildUnsendControl(clip) {
  const sentTo = clip.sentTo || [];
  if (!sentTo.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'send-to-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'unsend-btn';
  btn.textContent = 'Unsend';

  const menu = document.createElement('div');
  menu.className = 'send-to-menu';
  menu.hidden = true;

  sentTo.forEach((id) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = `Unsend from ${fwiwGetConnectorName(id)}`;
    item.addEventListener('click', async () => {
      menu.hidden = true;
      const updated = (clip.sentTo || []).filter((c) => c !== id);
      await updateClip(clip.id, { sentTo: updated });
      populateFilters();
      renderClips();
    });
    menu.appendChild(item);
  });

  btn.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

async function updateClip(id, patch) {
  const idx = allClips.findIndex((c) => c.id === id);
  if (idx === -1) return;
  allClips[idx] = Object.assign({}, allClips[idx], patch);
  await saveClips(allClips);
}

function buildClipCard(clip, editing) {
  const card = document.createElement('div');
  card.className = 'clip-card';
  card.dataset.id = clip.id;

  if (editing) {
    const editTitle = document.createElement('input');
    editTitle.type = 'text';
    editTitle.className = 'title-input';
    editTitle.placeholder = 'Title';
    editTitle.value = clip.title || '';
    card.appendChild(editTitle);

    const editHint = document.createElement('p');
    editHint.className = 'title-hint';
    editHint.textContent = 'Add a title to save';
    editHint.hidden = true;
    card.appendChild(editHint);

    editTitle.addEventListener('input', () => {
      editTitle.classList.remove('invalid');
      editHint.hidden = true;
    });

    const editTextarea = document.createElement('textarea');
    editTextarea.className = 'clip-textarea clip-edit-textarea';
    editTextarea.value = clip.text;
    card.appendChild(editTextarea);

    const editTagsWrap = document.createElement('div');
    editTagsWrap.className = 'tag-input';
    card.appendChild(editTagsWrap);
    const editTagsWidget = fwiwCreateTagInput(editTagsWrap, clip.tags || []);

    const editFooter = document.createElement('div');
    editFooter.className = 'clip-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const newTitle = editTitle.value.trim();
      if (!newTitle) {
        editTitle.classList.add('invalid');
        editHint.hidden = false;
        return;
      }
      const newText = editTextarea.value.trim();
      const newTags = editTagsWidget.getTags();
      await updateClip(clip.id, { title: newTitle, text: newText, tags: newTags });
      populateFilters();
      renderClips();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      renderClips();
    });

    editFooter.appendChild(saveBtn);
    editFooter.appendChild(cancelBtn);
    card.appendChild(editFooter);

    return card;
  }

  if (clip.title) {
    const titleEl = document.createElement('p');
    titleEl.className = 'clip-title';
    titleEl.textContent = clip.title;
    card.appendChild(titleEl);
  }

  const meta = document.createElement('div');
  meta.className = 'clip-meta';

  const timestamp = document.createElement('span');
  timestamp.className = 'clip-timestamp';
  timestamp.textContent = formatTimestamp(clip.createdAt);
  meta.appendChild(timestamp);

  if (clip.url) {
    const link = document.createElement('a');
    link.className = 'clip-url';
    link.href = clip.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = truncateUrl(clip.url);
    meta.appendChild(link);
  }

  card.appendChild(meta);

  if (clip.tags && clip.tags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    clip.tags.forEach((t) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = t;
      tagRow.appendChild(pill);
    });
    card.appendChild(tagRow);
  }

  const sentBadges = buildSentBadges(clip);
  if (sentBadges) card.appendChild(sentBadges);

  const textEl = document.createElement('p');
  textEl.className = 'clip-text';
  textEl.textContent = clip.text;
  textEl.addEventListener('click', () => {
    textEl.classList.toggle('expanded');
  });
  card.appendChild(textEl);

  const footer = document.createElement('div');
  footer.className = 'clip-footer';

  const statusHost = document.createElement('span');
  statusHost.className = 'send-status';

  buildSendToControl(clip, statusHost).then((control) => {
    if (control) footer.insertBefore(control, footer.firstChild);
  });

  const actions = document.createElement('div');
  actions.className = 'clip-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    const editCard = buildClipCard(clip, true);
    card.replaceWith(editCard);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => {
    card.classList.add('fade-out');
    setTimeout(async () => {
      allClips = allClips.filter((c) => c.id !== clip.id);
      await saveClips(allClips);
      populateFilters();
      renderClips();
      updateClipCount();
      await refreshSendAllVisibility();
    }, 200);
  });

  const unsendControl = buildUnsendControl(clip);

  actions.appendChild(editBtn);
  if (unsendControl) actions.appendChild(unsendControl);
  actions.appendChild(deleteBtn);

  footer.appendChild(statusHost);
  footer.appendChild(actions);
  card.appendChild(footer);

  return card;
}

function toCSV(clips) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const header = 'createdAt,title,text,tags,url';
  const rows = clips.map((c) =>
    [esc(c.createdAt), esc(c.title || ''), esc(c.text), esc((c.tags || []).join(';')), esc(c.url)].join(',')
  );
  return [header, ...rows].join('\n');
}

function toMarkdown(clips) {
  return clips
    .map((c) => {
      const frontmatter = [
        '---',
        `created: ${c.createdAt}`,
        `tags: [${(c.tags || []).join(', ')}]`,
        `url: ${c.url}`,
        '---'
      ].join('\n');
      return `## ${c.title || c.createdAt}\n\n${frontmatter}\n\n${c.text}\n`;
    })
    .join('\n');
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportClips(format, scope) {
  const clips = getScopedClips(scope);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    downloadFile(`fwiw-export-${stamp}.json`, JSON.stringify(clips, null, 2), 'application/json');
  } else if (format === 'csv') {
    downloadFile(`fwiw-export-${stamp}.csv`, toCSV(clips), 'text/csv');
  } else if (format === 'markdown') {
    downloadFile(`fwiw-export-${stamp}.md`, toMarkdown(clips), 'text/markdown');
  }
}

async function refreshSendAllVisibility() {
  const row = document.getElementById('sendAllRow');
  const enabled = await fwiwGetEnabledConnectors();
  row.hidden = enabled.length === 0;
}

function initExportPanel() {
  const toggleBtn = document.getElementById('exportToggleBtn');
  const panel = document.getElementById('exportPanel');
  const confirmBtn = document.getElementById('exportConfirmBtn');

  toggleBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  confirmBtn.addEventListener('click', () => {
    const format = document.querySelector('input[name="exportFormat"]:checked').value;
    const scope = document.querySelector('input[name="exportScope"]:checked').value;
    exportClips(format, scope);
    panel.hidden = true;
  });
}

function initSendAll() {
  const toggleBtn = document.getElementById('sendAllToggleBtn');
  const menu = document.getElementById('sendAllMenu');
  const progress = document.getElementById('sendAllProgress');

  toggleBtn.addEventListener('click', async () => {
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const enabled = await fwiwGetEnabledConnectors();
    menu.innerHTML = '';
    enabled.forEach((c) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = `Send to ${c.name}`;
      item.addEventListener('click', () => {
        menu.hidden = true;
        runBulkSend(c.id);
      });
      menu.appendChild(item);
    });
    menu.hidden = false;
  });

  async function runBulkSend(connectorId) {
    const clips = getFilteredClips().filter((c) => !(c.sentTo || []).includes(connectorId));
    const scopeLabel = buildScopeLabel();
    const context = scopeLabel ? { scopeLabel } : undefined;
    const total = clips.length;
    let sent = 0;
    let failed = 0;

    if (total === 0) {
      progress.hidden = false;
      progress.textContent = 'Nothing new to send — already sent to everyone in view.';
      setTimeout(() => {
        progress.hidden = true;
      }, 4000);
      return;
    }

    progress.hidden = false;
    progress.textContent = `Sending 0 of ${total}...`;

    for (let i = 0; i < total; i++) {
      try {
        await fwiwSendClipToConnector(connectorId, clips[i], context);
        sent++;
        await updateClip(clips[i].id, {
          sentTo: Array.from(new Set([...(clips[i].sentTo || []), connectorId]))
        });
      } catch (err) {
        failed++;
      }
      progress.textContent = `Sending ${i + 1} of ${total}...`;
    }

    progress.textContent = failed === 0 ? `Done. ${sent} clips sent.` : `Done. ${sent} sent, ${failed} failed.`;
    populateFilters();
    renderClips();
    setTimeout(() => {
      progress.hidden = true;
    }, 4000);
  }
}

function initTagFilter() {
  const trigger = document.getElementById('tagFilterTrigger');
  const menu = document.getElementById('tagFilterMenu');
  const clearBtn = document.getElementById('tagFilterClear');

  trigger.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });

  clearBtn.addEventListener('click', () => {
    selectedTags = [];
    populateFilters();
    renderClips();
  });
}

function initBackToTop() {
  const btn = document.getElementById('backToTopBtn');

  function updateVisibility() {
    btn.hidden = document.body.scrollTop < 150;
  }

  document.body.addEventListener('scroll', updateVisibility);
  updateVisibility();

  btn.addEventListener('click', () => {
    document.body.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function init() {
  document.getElementById('searchInput').addEventListener('input', renderClips);
  document.getElementById('timeRangeFilter').addEventListener('change', renderClips);

  initTagFilter();
  initExportPanel();
  initSendAll();
  initBackToTop();

  document.addEventListener('click', (e) => {
    const tagFilterMenu = document.getElementById('tagFilterMenu');
    const tagFilterWrap = document.getElementById('tagFilterWrap');
    if (!tagFilterMenu.hidden && !tagFilterWrap.contains(e.target)) {
      tagFilterMenu.hidden = true;
    }

    const exportPanel = document.getElementById('exportPanel');
    const exportToggleBtn = document.getElementById('exportToggleBtn');
    if (!exportPanel.hidden && !exportPanel.contains(e.target) && e.target !== exportToggleBtn) {
      exportPanel.hidden = true;
    }

    const sendAllMenu = document.getElementById('sendAllMenu');
    const sendAllToggleBtn = document.getElementById('sendAllToggleBtn');
    if (!sendAllMenu.hidden && !sendAllMenu.contains(e.target) && e.target !== sendAllToggleBtn) {
      sendAllMenu.hidden = true;
    }

    document.querySelectorAll('.send-to-menu').forEach((menu) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target.closest('.send-to-wrap') !== menu.closest('.send-to-wrap')) {
        menu.hidden = true;
      }
    });
  });

  loadClips();
}

document.addEventListener('DOMContentLoaded', init);
