import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown, safeUrl } from "./markdown";

// ------------------------------------------------------------- safeUrl gate

test("safeUrl allows http, https, mailto, and relative URLs", () => {
  assert.equal(safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeUrl("http://example.com"), "http://example.com");
  assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeUrl("/local/path"), "/local/path");
  assert.equal(safeUrl("#anchor"), "#anchor");
  assert.equal(safeUrl("  https://trim.me  "), "https://trim.me");
});

test("safeUrl rejects script schemes, data, scheme-relative, and control chars", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("JaVaScRiPt:alert(1)"), null);
  assert.equal(safeUrl(" javascript:alert(1)"), null, "leading whitespace does not smuggle a scheme");
  assert.equal(safeUrl("java\tscript:alert(1)"), null, "tab-smuggled scheme (browsers strip \\t in URLs)");
  assert.equal(safeUrl("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(safeUrl("vbscript:x"), null);
  assert.equal(safeUrl("file:///etc/passwd"), null);
  assert.equal(safeUrl("//evil.example.com"), null, "scheme-relative inherits page protocol");
  assert.equal(safeUrl('https://x" onerror="alert(1)'), null, "quote breakout material");
  assert.equal(safeUrl(""), null);
});

// ------------------------------------------------------------ XSS coverage

test("markdown: image URL quote-breakout is defanged", () => {
  const html = renderMarkdown('![alt](https://x" onerror="alert(1))');
  assert.ok(!html.includes("onerror="), `no injected handler in: ${html}`);
  assert.ok(!/<img/.test(html), "unsafe image renders as literal text, not an img tag");
});

test("markdown: javascript: links never become anchors", () => {
  const html = renderMarkdown("[click me](javascript:alert(1))");
  assert.ok(!html.includes("javascript:"), `no script url in: ${html}`);
  assert.ok(!/<a /.test(html), "no anchor");
  assert.ok(html.includes("click me"), "link text survives as plain text");
});

test("markdown: data: URLs never become images", () => {
  const html = renderMarkdown("![x](data:text/html;base64,PHNjcmlwdD4=)");
  assert.ok(!/<img/.test(html));
  assert.ok(!html.includes("data:"));
});

test("markdown: legitimate links and images still render", () => {
  const html = renderMarkdown("[site](https://example.com/a?b=1) and ![pic](https://cdn.example.com/p.png)");
  assert.equal(html, '<p><a href="https://example.com/a?b=1" target="_blank" rel="noreferrer">site</a> and <a href="https://cdn.example.com/p.png" target="_blank" rel="noreferrer"><img src="https://cdn.example.com/p.png" alt="pic" loading="lazy" class="md-img" /></a></p>');
});

test("markdown: text and code contexts escape quotes and angles", () => {
  const html = renderMarkdown('`<img src=x onerror="1">`');
  assert.ok(html.includes("&lt;img src=x onerror=&quot;1&quot;&gt;"), `escaped in: ${html}`);
  assert.ok(!html.includes("<img"), "no raw img tag from code span");
  const heading = renderMarkdown('# "quoted" <b>title</b>');
  assert.ok(heading.includes("&quot;quoted&quot;"));
  assert.ok(!heading.includes("<b>"));
});

test("markdown: ampersand URLs round-trip correctly", () => {
  const html = renderMarkdown("[q](https://example.com/search?a=1&b=2)");
  assert.ok(html.includes('href="https://example.com/search?a=1&amp;b=2"'));
});

// ------------------------------------------------------- rendering intact

test("markdown: blocks still render (headings, lists, tables, fences)", () => {
  const html = renderMarkdown("# Title\n\n- a\n- b\n\n```\n<x>\n```\n\n| h1 | h2 |\n| --- | --- |\n| a | b |");
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<ul><li>a</li><li>b</li></ul>"));
  assert.ok(html.includes("<pre><code>&lt;x&gt;</code></pre>"));
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("<th>h1</th>"));
});
