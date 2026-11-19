(() => {
  const element = tag => document.createElement(tag);
  const decode = value => String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, name) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    if (name[0] !== '#') return names[name.toLowerCase()] || raw;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2),16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
  function text(parent, value) { parent.append(document.createTextNode(decode(value))); }
  function safeLink(href) {
    try { const url = new URL(decode(href)); return ['http:','https:','mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function tokens(parent, items, depth = 0) {
    if (depth > 24) return;
    for (const token of items || []) {
      const children = target => tokens(target,token.tokens,depth+1);
      let node;
      switch (token.type) {
        case 'space': case 'def': break;
        case 'heading': node = element('h' + Math.min(6,Math.max(2,token.depth))); children(node); parent.append(node); break;
        case 'paragraph': node = element('p'); children(node); parent.append(node); break;
        case 'strong': case 'em': case 'del': node = element(token.type); children(node); parent.append(node); break;
        case 'text': if (token.tokens) children(parent); else text(parent,token.text); break;
        case 'escape': text(parent,token.text); break;
        case 'br': parent.append(element('br')); break;
        case 'hr': parent.append(element('hr')); break;
        case 'codespan': node = element('code'); text(node,token.text); parent.append(node); break;
        case 'code': {
          const pre = element('pre'); const code = element('code'); code.textContent = token.text; pre.append(code); parent.append(pre); break;
        }
        case 'blockquote': node = element('blockquote'); children(node); parent.append(node); break;
        case 'list': {
          const list = element(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isInteger(token.start) && token.start !== 1) list.setAttribute('start',String(token.start));
          for (const item of token.items || []) { const li = element('li'); if (item.task) text(li,item.checked ? '☑ ' : '☐ '); tokens(li,item.tokens,depth+1); list.append(li); }
          parent.append(list); break;
        }
        case 'link': {
          const href = safeLink(token.href);
          if (!href) { children(parent); break; }
          node = element('a'); node.setAttribute('href',href); node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); children(node); parent.append(node); break;
        }
        case 'image': text(parent,token.text || '[изображение]'); break;
        case 'table': {
          const wrapper = element('div'); wrapper.className = 'table-scroll'; wrapper.setAttribute('role','region'); wrapper.setAttribute('aria-label','Таблица из ответа. При необходимости прокрути в сторону.'); wrapper.setAttribute('tabindex','0');
          const table = element('table'); const head = element('thead'); const body = element('tbody');
          const row = (cells, heading) => {
            const tr = element('tr');
            for (const [index,cell] of cells.entries()) {
              const td = element(heading ? 'th' : 'td'); if (heading) td.setAttribute('scope','col');
              const align = cell.align || token.align?.[index]; if (['left','center','right'].includes(align)) td.className = 'align-' + align;
              tokens(td,cell.tokens || [{ type: 'text', text: cell.text }],depth+1); tr.append(td);
            }
            return tr;
          };
          head.append(row(token.header,true)); for (const cells of token.rows) body.append(row(cells,false));
          table.append(head,body); wrapper.append(table); parent.append(wrapper); break;
        }
        // Never insert model HTML into the DOM. Only a bare line break is recognized.
        case 'html': if (/^<br\s*\/?\s*>$/i.test(token.text.trim())) parent.append(element('br')); else text(parent,token.text); break;
        default: text(parent,token.text || token.raw || '');
      }
    }
  }
  function render(content, target) {
    target.replaceChildren(); target.classList.add('markdown-body');
    try {
      if (!window.marked?.lexer) throw new Error('Parser unavailable');
      tokens(target,window.marked.lexer(String(content),{ gfm: true, breaks: true }));
    } catch { target.textContent = String(content); }
    return target;
  }
  window.MozgMarkdown = Object.freeze({ render });
})();
