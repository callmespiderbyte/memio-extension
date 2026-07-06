// Shared tag-chip input: typing a tag then hitting Enter or comma commits it
// as a removable pill, so it's visually clear the tag has been captured
// rather than sitting as ungrouped text in a plain field. Used by both the
// Memo view (popup.js) and the History edit form (history.js).
function memioCreateTagInput(wrapperEl, initialTags, onChange) {
  const tags = (initialTags || []).slice();

  wrapperEl.classList.add('tag-input-field');
  wrapperEl.innerHTML = '';

  const pillsHost = document.createElement('div');
  pillsHost.className = 'tag-input-pills';

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'tag-input-text';

  function notify() {
    if (onChange) onChange(tags.slice());
  }

  function renderPills() {
    pillsHost.innerHTML = '';
    tags.forEach((tag, idx) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill tag-pill-removable';

      const label = document.createElement('span');
      label.textContent = tag;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tag-pill-remove';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', `Remove tag ${tag}`);
      removeBtn.addEventListener('click', () => {
        tags.splice(idx, 1);
        renderPills();
        notify();
      });

      pill.appendChild(label);
      pill.appendChild(removeBtn);
      pillsHost.appendChild(pill);
    });
    textInput.placeholder = tags.length ? '' : 'Add tags...';
  }

  function commitCurrentInput() {
    const raw = textInput.value.trim();
    textInput.value = '';
    if (!raw) return;
    if (!tags.includes(raw)) {
      tags.push(raw);
      renderPills();
      notify();
    }
  }

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitCurrentInput();
    } else if (e.key === 'Backspace' && textInput.value === '' && tags.length) {
      tags.pop();
      renderPills();
      notify();
    }
  });

  textInput.addEventListener('blur', commitCurrentInput);

  renderPills();
  wrapperEl.appendChild(pillsHost);
  wrapperEl.appendChild(textInput);

  return {
    getTags: () => tags.slice(),
    focus: () => textInput.focus(),
    clear: () => {
      tags.length = 0;
      textInput.value = '';
      renderPills();
    }
  };
}
