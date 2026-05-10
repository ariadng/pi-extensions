export interface ElementBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SnapshotNode {
	ref?: string;
	role: string;
	name?: string;
	text?: string;
	value?: string;
	placeholder?: string;
	disabled?: boolean;
	checked?: boolean;
	url?: string;
	selector: string;
	box?: ElementBox;
	tag?: string;
}

export interface SnapshotData {
	title: string;
	url: string;
	viewport: {
		width: number;
		height: number;
		scrollX: number;
		scrollY: number;
	};
	nodes: SnapshotNode[];
	totalNodes: number;
	truncated: boolean;
	focused?: string;
	text?: string;
}

export interface SnapshotRef {
	ref: string;
	selector: string;
	role?: string;
	name?: string;
	box?: ElementBox;
	navigationId: number;
	createdAt: number;
}

export interface SnapshotOptions {
	includeBoxes?: boolean;
	maxNodes?: number;
	includeText?: boolean;
	selector?: string;
}

export const SNAPSHOT_EXTRACTOR = String.raw`function extractSnapshot(options) {
  const includeBoxes = options && options.includeBoxes !== false;
  const maxNodes = Math.max(1, Math.min(Number(options && options.maxNodes) || 120, 500));
  const includeText = options && options.includeText === true;
  const rootSelector = options && typeof options.selector === 'string' && options.selector ? options.selector : undefined;
  const root = rootSelector ? document.querySelector(rootSelector) : document.documentElement;
  if (!root) throw new Error('Snapshot root selector did not match: ' + rootSelector);

  const nodes = [];
  let totalNodes = 0;
  const seen = new Set();

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch) { return '\\' + ch; });
  }

  function clean(value, max) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max || 180);
  }

  function textOf(el, max) {
    if (!el) return '';
    return clean(el.innerText || el.textContent || '', max || 180);
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight * 3 || rect.left > window.innerWidth * 3) return false;
    return true;
  }

  function uniqueSelector(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) {
      const selector = '#' + cssEscape(el.id);
      try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
    }
    const attrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'title', 'placeholder'];
    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const selector = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(value) + ']';
      try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
    }
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const sameTag = Array.from(parent.children).filter(function(child) { return child.tagName === current.tagName; });
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
      current = parent;
    }
    parts.unshift('html');
    return parts.join(' > ');
  }

  function labelText(el) {
    const aria = clean(el.getAttribute('aria-label'), 180);
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(function(id) { return textOf(document.getElementById(id), 80); }).filter(Boolean).join(' ');
      if (text) return clean(text, 180);
    }
    if (el.id) {
      const label = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
      const text = textOf(label, 120);
      if (text) return text;
    }
    const wrappedLabel = el.closest && el.closest('label');
    const wrapped = textOf(wrappedLabel, 120);
    if (wrapped) return wrapped;
    const alt = clean(el.getAttribute('alt'), 180);
    if (alt) return alt;
    const title = clean(el.getAttribute('title'), 180);
    if (title) return title;
    const placeholder = clean(el.getAttribute('placeholder'), 180);
    if (placeholder) return placeholder;
    if ('value' in el && typeof el.value === 'string' && el.tagName !== 'INPUT') {
      const value = clean(el.value, 180);
      if (value) return value;
    }
    return textOf(el, 180);
  }

  function roleOf(el) {
    const explicit = clean(el.getAttribute('role'), 80);
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function isSemantic(el) {
    if (!(el instanceof Element) || !isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
    if (/^h[1-6]$/.test(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('role') || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return true;
    return false;
  }

  function add(el) {
    if (seen.has(el) || !isSemantic(el)) return;
    seen.add(el);
    totalNodes += 1;
    if (nodes.length >= maxNodes) return;
    const rect = el.getBoundingClientRect();
    const role = roleOf(el);
    const node = {
      role,
      name: labelText(el),
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase()
    };
    if (includeBoxes) node.box = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    if ('value' in el && typeof el.value === 'string' && !['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) node.value = clean(el.value, 120);
    const placeholder = clean(el.getAttribute('placeholder'), 120);
    if (placeholder) node.placeholder = placeholder;
    if ('disabled' in el) node.disabled = Boolean(el.disabled);
    if ('checked' in el) node.checked = Boolean(el.checked);
    if (el instanceof HTMLAnchorElement) node.url = el.href;
    if (includeText && !node.name) node.text = textOf(el, 240);
    nodes.push(node);
  }

  function walk(node) {
    if (!node || nodes.length >= maxNodes && totalNodes > maxNodes * 2) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    add(el);
    if (el.shadowRoot) walk(el.shadowRoot);
    const children = el.shadowRoot ? Array.from(el.shadowRoot.children) : Array.from(el.children);
    for (const child of children) walk(child);
  }

  walk(root);
  const active = document.activeElement instanceof Element ? uniqueSelector(document.activeElement) : undefined;
  const bodyText = includeText ? clean(document.body ? document.body.innerText : '', 4000) : undefined;
  return {
    title: document.title || '',
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
    nodes,
    totalNodes,
    truncated: totalNodes > nodes.length,
    focused: active,
    text: bodyText
  };
}`;

export function applySnapshotRefs(data: SnapshotData, createRef: (node: SnapshotNode) => string): SnapshotData {
	return {
		...data,
		nodes: data.nodes.map((node) => ({ ...node, ref: createRef(node) })),
	};
}

export function formatSnapshot(data: SnapshotData): string {
	const lines: string[] = [];
	lines.push(`Page: ${JSON.stringify(data.title || "(untitled)")}`);
	lines.push(`URL: ${data.url}`);
	lines.push(
		`Viewport: ${data.viewport.width}x${data.viewport.height}, scroll=(${data.viewport.scrollX}, ${data.viewport.scrollY})`,
	);
	if (data.focused) lines.push(`Focused: ${data.focused}`);
	lines.push("");

	for (const node of data.nodes) {
		const parts = [`- ${node.role}`];
		if (node.name) parts.push(JSON.stringify(node.name));
		else if (node.text) parts.push(JSON.stringify(node.text));
		if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
		if (node.placeholder) parts.push(`placeholder=${JSON.stringify(node.placeholder)}`);
		if (node.url) parts.push(`url=${JSON.stringify(node.url)}`);
		if (node.disabled !== undefined) parts.push(`disabled=${node.disabled}`);
		if (node.checked !== undefined) parts.push(`checked=${node.checked}`);
		if (node.ref) parts.push(`[ref=${node.ref}]`);
		if (node.box) parts.push(`[box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}]`);
		lines.push(parts.join(" "));
	}

	if (data.truncated) lines.push(`\n[Snapshot truncated: showing ${data.nodes.length} of ${data.totalNodes} semantic nodes.]`);
	if (data.text) lines.push("\nText:\n" + data.text);
	return lines.join("\n");
}
