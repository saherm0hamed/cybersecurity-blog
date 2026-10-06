const { marked } = require('marked');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');

const languageAliases = {
  csharp: 'cs',
  cxx: 'cpp',
  golang: 'go',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml'
};

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const requestedLanguage = typeof lang === 'string' ? lang.toLowerCase() : '';
  const language = languageAliases[requestedLanguage] || requestedLanguage;
  const supportedLanguage = /^[\w+#.-]+$/.test(language) && hljs.getLanguage(language)
    ? language
    : null;
  let highlighted;
  try {
    highlighted = supportedLanguage
      ? hljs.highlight(text, { language: supportedLanguage }).value
      : hljs.highlightAuto(text).value;
  } catch {
    highlighted = hljs.highlightAuto(text).value;
  }
  const normalizedLanguage = supportedLanguage || 'plaintext';
  const languageClass = ` language-${normalizedLanguage}`;
  return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`;
};

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true
});

function renderMarkdown(content) {
  if (!content) return '';
  return sanitizeHtml(marked.parse(content), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'pre', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span']),
    allowedAttributes: {
      a: ['href', 'name'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      code: ['class'],
      pre: ['class'],
      span: ['class'],
      th: ['align'],
      td: ['align']
    },
    allowedSchemes: ['http', 'https', 'mailto']
  });
}

function extractToc(content) {
  if (!content) return [];
  const headings = [];
  const lines = content.split('\n');
  let idCounter = {};
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      let text = match[2].trim();
      // Simple slug
      let id = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      if (idCounter[id]) {
        idCounter[id]++;
        id = `${id}-${idCounter[id]}`;
      } else {
        idCounter[id] = 1;
      }
      headings.push({ level, text, id });
    }
  }
  return headings;
}

module.exports = { renderMarkdown, extractToc };
