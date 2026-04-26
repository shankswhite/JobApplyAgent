//
// scripts/lib/extract-form-fields.mjs
//
// Snapshot-driven form field extraction. Walks the live DOM via page.evaluate
// and returns one normalized record per visible interactive field, including
// label text, input type, current value, dropdown options, required marker,
// and a stable selector for re-locating the field to fill it.
//
// Returned fields are the GROUND TRUTH for what's on the page — the resolver
// + fill flow no longer rely on hardcoded label whitelists.
//
// Field record shape:
// {
//   index:        unique number, ordinal in scan
//   label:        cleaned label text (without trailing * / required marker)
//   type:         text | email | tel | url | number | textarea | select | combobox |
//                 file | checkbox | radio | radio_group | contenteditable | unknown
//   name:         input name attribute (may be empty)
//   id:           input id attribute (may be empty)
//   selector:     stable CSS selector for re-locating (prefers [name], [id], [aria-label])
//   required:     boolean
//   currentValue: current value of the field (string)
//   options:      [string] — for select / radio_group / detected combobox
//   placeholder:  string
//   accept:       file accept attr (only for type=file)
//   group:        radio group name (radio inputs only)
// }
//

const FIELD_EXTRACTOR_FN = `
(() => {
  const fields = [];
  let idx = 0;

  const cleanLabel = (raw) => {
    if (!raw) return '';
    return String(raw)
      .replace(/\\u00a0/g, ' ')
      .replace(/\\s+/g, ' ')
      .replace(/\\s*\\*+\\s*$/, '')
      .replace(/\\s*\\(required\\)\\s*$/i, '')
      .trim();
  };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  };

  const findLabelFor = (el) => {
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return cleanLabel(lab.innerText || lab.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
      return cleanLabel(clone.innerText || clone.textContent);
    }
    if (el.getAttribute('aria-labelledby')) {
      const ids = el.getAttribute('aria-labelledby').split(/\\s+/);
      const text = ids.map(i => {
        const e = document.getElementById(i);
        return e ? (e.innerText || e.textContent) : '';
      }).join(' ');
      if (text.trim()) return cleanLabel(text);
    }
    if (el.getAttribute('aria-label')) return cleanLabel(el.getAttribute('aria-label'));
    // Greenhouse / Ashby: walk up to find a question container
    let parent = el.parentElement;
    for (let i = 0; i < 6 && parent; i++) {
      const candidate = parent.querySelector(':scope > label, :scope > div > label, :scope > [class*="label"], :scope > [class*="question"]');
      if (candidate && candidate !== el) {
        const t = cleanLabel(candidate.innerText || candidate.textContent);
        if (t && t.length < 200) return t;
      }
      parent = parent.parentElement;
    }
    // Fallback for Greenhouse EEO patterns where the label is a sibling block
    // above the combobox (e.g. "Please identify your race" — bold text in a
    // div that has no class hint, no <label> wrapper, and no for/aria link).
    // Walk up the tree and, at each level, check the immediately preceding
    // sibling for short bold/header-ish text.
    let walker = el;
    for (let i = 0; i < 6 && walker; i++) {
      let sib = walker.previousElementSibling;
      while (sib) {
        if (sib.tagName !== 'INPUT' && sib.tagName !== 'TEXTAREA' && sib.tagName !== 'SELECT' && sib.tagName !== 'BUTTON') {
          const t = cleanLabel(sib.innerText || sib.textContent);
          if (t && t.length >= 3 && t.length < 200) return t;
        }
        sib = sib.previousElementSibling;
      }
      walker = walker.parentElement;
    }
    // Last resort: look for the first short text node inside the closest
    // container that has the class signature of a Greenhouse/Ashby question.
    let container = el.parentElement;
    for (let i = 0; i < 8 && container; i++) {
      const cls = (container.className || '') + ' ' + (container.getAttribute('class') || '');
      if (/question|field|form-row|form-group|form-question|application|eeoc/i.test(cls) || container.tagName === 'FIELDSET') {
        // Take the first descendant text that isn't from an input/textarea/select.
        const clone = container.cloneNode(true);
        clone.querySelectorAll('input, textarea, select, button, a').forEach(n => n.remove());
        const text = cleanLabel(clone.innerText || clone.textContent);
        if (text && text.length >= 3 && text.length < 200) return text;
      }
      container = container.parentElement;
    }
    if (el.placeholder) return cleanLabel(el.placeholder);
    return '';
  };

  // Tag every interactive element with a unique identifier we control, so
  // we always have a robust re-locate path even when the form's own attributes
  // are missing (Ashby + custom forms commonly omit name/id/aria-label).
  const TAG_ATTR = 'data-cv-field-id';
  let tagCounter = 0;

  const buildSelector = (el) => {
    if (el.name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('aria-label')) {
      return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
    }
    if (el.dataset && el.dataset.fieldId) return '[data-field-id="' + el.dataset.fieldId + '"]';
    if (el.dataset && el.dataset.testid) return '[data-testid="' + el.dataset.testid + '"]';
    // Last resort: stamp our own attribute so we can re-find the element.
    let tagId = el.getAttribute(TAG_ATTR);
    if (!tagId) {
      tagId = 'cv-' + (tagCounter++);
      el.setAttribute(TAG_ATTR, tagId);
    }
    return '[' + TAG_ATTR + '="' + tagId + '"]';
  };

  const detectComboboxOptions = (el) => {
    // Greenhouse react-select pattern: hidden <select> with full options elsewhere
    // Or aria-controls pointing at a listbox. Heuristic only.
    const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (owns) {
      const list = document.getElementById(owns);
      if (list) {
        return Array.from(list.querySelectorAll('[role="option"]'))
          .map(o => (o.innerText || o.textContent || '').trim())
          .filter(Boolean);
      }
    }
    return [];
  };

  // --- inputs / textareas / selects ---
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (!isVisible(el) || el.disabled) return;
    const t = (el.tagName === 'INPUT') ? (el.type || 'text').toLowerCase() : el.tagName.toLowerCase();
    if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return;

    let label = findLabelFor(el);
    let required = !!el.required || /\\*$/.test(label) || el.getAttribute('aria-required') === 'true';

    let currentValue = '';
    let options = [];
    let normType = t;

    if (el.tagName === 'SELECT') {
      normType = 'select';
      options = Array.from(el.options).map(o => (o.text || '').trim()).filter(Boolean);
      currentValue = (el.options[el.selectedIndex] && el.options[el.selectedIndex].text || '').trim();
      // Skip the placeholder "--" first option from current value if it's selected
      if (el.selectedIndex <= 0 && options.length > 0 && currentValue === options[0] &&
          /^(--|select|please|choose)/i.test(options[0])) {
        currentValue = '';
      }
    } else if (el.tagName === 'TEXTAREA') {
      normType = 'textarea';
      currentValue = el.value;
    } else if (t === 'checkbox') {
      normType = 'checkbox';
      currentValue = el.checked ? 'true' : '';
    } else if (t === 'radio') {
      // Group radios — emit ONE record per group, with options
      const groupName = el.name || '';
      if (!groupName) return;
      const groupKey = 'radio:' + groupName;
      if (fields.some(f => f._groupKey === groupKey)) return;
      const group = Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(groupName) + '"]')).filter(isVisible);
      const groupOptions = group.map(r => {
        const lab = findLabelFor(r);
        return lab || r.value;
      }).filter(Boolean);
      const checked = group.find(r => r.checked);
      let groupLabel = '';
      // Try fieldset legend
      const fs = el.closest('fieldset');
      if (fs) {
        const legend = fs.querySelector('legend');
        if (legend) groupLabel = cleanLabel(legend.innerText || legend.textContent);
      }
      if (!groupLabel) groupLabel = label || groupName;
      fields.push({
        _groupKey: groupKey,
        index: idx++,
        label: groupLabel,
        type: 'radio_group',
        name: groupName,
        id: '',
        selector: 'input[type="radio"][name="' + groupName + '"]',
        required: group.some(r => r.required),
        currentValue: checked ? (findLabelFor(checked) || checked.value) : '',
        options: groupOptions,
        placeholder: '',
      });
      return;
    } else if (t === 'file') {
      normType = 'file';
      currentValue = el.value ? el.value.split(/[\\\\/]/).pop() : '';
    } else {
      currentValue = el.value || '';
    }

    fields.push({
      index: idx++,
      label,
      type: normType,
      name: el.name || '',
      id: el.id || '',
      selector: buildSelector(el),
      required,
      currentValue,
      options,
      placeholder: el.placeholder || '',
      accept: t === 'file' ? (el.accept || '') : '',
    });
  });

  // --- comboboxes / contenteditable ---
  document.querySelectorAll('[role="combobox"], [contenteditable="true"]').forEach((el) => {
    if (!isVisible(el)) return;
    // Skip if we already covered it via a child <input>
    if (el.querySelector('input, textarea, select')) return;
    let label = findLabelFor(el);
    // Even if label resolution failed, keep the combobox so the resolver can
    // still surface it as an unanswered field — silently dropping is what
    // caused Greenhouse Race to disappear pre-fix.
    if (!label) label = '(unlabeled combobox)';
    const role = el.getAttribute('role');
    const normType = role === 'combobox' ? 'combobox' : 'contenteditable';
    const currentValue = (el.innerText || el.textContent || '').trim();
    let options = [];
    if (normType === 'combobox') options = detectComboboxOptions(el);
    fields.push({
      index: idx++,
      label,
      type: normType,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      selector: buildSelector(el),
      required: el.getAttribute('aria-required') === 'true',
      currentValue,
      options,
      placeholder: el.getAttribute('placeholder') || '',
    });
  });

  const cleaned = fields.map(({ _groupKey, ...rest }) => rest);

  // --- post-process: dedupe text/combobox twins from Greenhouse react-select ---
  // Pattern: a text input + a combobox both share the same label. Keep the
  // combobox (interactive widget); drop the hidden-ish text twin.
  const labelGroups = new Map();
  for (const f of cleaned) {
    if (!f.label) continue;
    const key = f.label.toLowerCase();
    if (!labelGroups.has(key)) labelGroups.set(key, []);
    labelGroups.get(key).push(f);
  }
  const toRemove = new Set();
  for (const [, group] of labelGroups) {
    if (group.length < 2) continue;
    const hasCombobox = group.some(g => g.type === 'combobox');
    if (!hasCombobox) continue;
    for (const g of group) {
      if (g.type === 'text' || g.type === 'select') toRemove.add(g.index);
    }
  }

  // --- post-process: disambiguate file uploads ---
  // Greenhouse labels them "Attach" generically; use the input name to tag.
  for (const f of cleaned) {
    if (f.type !== 'file') continue;
    const lc = (f.name + ' ' + f.id).toLowerCase();
    if (/cover.?letter/.test(lc)) f.label = 'Cover Letter (file upload)';
    else if (/resume|cv/.test(lc)) f.label = 'Resume / CV (file upload)';
  }

  return cleaned.filter(f => !toRemove.has(f.index));
})()
`;

export async function extractFormFields(page) {
  return await page.evaluate(FIELD_EXTRACTOR_FN);
}

// --- helpers exported for resolver/filler use ---

export function isFillableType(type) {
  return [
    'text', 'email', 'tel', 'url', 'number', 'search', 'password',
    'textarea', 'select', 'combobox', 'radio_group', 'checkbox', 'contenteditable',
  ].includes(type);
}

export function isUploadType(type) {
  return type === 'file';
}

export function summarizeField(f) {
  const opt = f.options && f.options.length > 0 ? `  options: [${f.options.slice(0, 5).join(' / ')}${f.options.length > 5 ? `, +${f.options.length - 5} more` : ''}]` : '';
  const cur = f.currentValue ? `  current: "${f.currentValue.slice(0, 40)}${f.currentValue.length > 40 ? '…' : ''}"` : '';
  const req = f.required ? ' *' : '';
  return `  [${String(f.index).padStart(2, ' ')}] ${f.type.padEnd(16, ' ')} ${f.label || '(no label)'}${req}${opt}${cur}`;
}
