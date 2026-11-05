/**
 * HTML 消毒（白名单）——聊天区与文件浏览器共用（设计文档 §29.1）。
 *
 * 安全关键代码只留一份：两处各写一份必然漂移，之前聊天区那份已被冒烟覆盖，
 * 文件页直接复用同一个实现。规则：
 *   · 只保留排版类标签；SCRIPT/STYLE/IFRAME 等直接删掉；
 *   · 去掉所有 on* 事件属性与非白名单属性；
 *   · href/src 只允许 http(s)/mailto/#/绝对/相对路径，杜绝 javascript: 等伪协议。
 */
(function () {
  const ALLOWED = new Set([
    'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'BLOCKQUOTE',
    'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'SPAN', 'DEL', 'DIV',
    'IMG',
  ]);
  const BAD_TAGS = ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION'];

  function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');

    for (const el of [...template.content.querySelectorAll('*')]) {
      if (BAD_TAGS.includes(el.tagName)) {
        el.remove();
        continue;
      }
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' || name === 'src') {
          const val = attr.value.trim();
          const lower = val.toLowerCase();
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(lower);
          // 没有 scheme 就是相对/裸文件名（markdown 里 `![](pic.png)` 很常见），允许；
          // 有 scheme 只放行 http(s)/mailto 与 data:image/，杜绝 javascript:/data:text/html。
          const ok = scheme
            ? ['http', 'https', 'mailto'].includes(scheme[1]) || lower.startsWith('data:image/')
            : true;
          if (!ok) el.removeAttribute(attr.name);
        } else if (
          name !== 'class' &&
          name !== 'id' &&
          name !== 'colspan' &&
          name !== 'rowspan' &&
          name !== 'align' &&
          name !== 'alt' &&
          name !== 'title'
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    return template.innerHTML;
  }

  window.sanitizeHtml = sanitizeHtml;
})();
