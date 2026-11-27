import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineMarkdown, parseMarkdownBlocks } from "./markdown.ts";

test("parseMarkdownBlocks parses headings, checklists, bullets, and fenced code", () => {
  const md = [
    "# 标题一",
    "## 子标题",
    "- [x] 已完成事项",
    "- [ ] 待办事项",
    "- 普通列表 **加粗** 和 `inline`",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 6);
  assert.equal(blocks[0].type, "heading");
  if (blocks[0].type === "heading") assert.equal(blocks[0].level, 1);
  assert.equal(blocks[2].type, "checklist");
  if (blocks[2].type === "checklist") assert.equal(blocks[2].checked, true);
  assert.equal(blocks[3].type, "checklist");
  if (blocks[3].type === "checklist") assert.equal(blocks[3].checked, false);
  assert.equal(blocks[4].type, "bullet");
  assert.equal(blocks[5].type, "code");
  if (blocks[5].type === "code") {
    assert.equal(blocks[5].lang, "ts");
    assert.equal(blocks[5].content, "const x = 1;");
  }
});

test("parseInlineMarkdown allows http/https links and neutralizes javascript: links", () => {
  const safeTokens = parseInlineMarkdown("查看 [极空间](https://www.zspace.cn) 和 https://example.com/a");
  assert.equal(safeTokens.some((t) => t.type === "link" && t.href === "https://www.zspace.cn/"), true);
  assert.equal(safeTokens.some((t) => t.type === "link" && t.href === "https://example.com/a"), true);

  const unsafeTokens = parseInlineMarkdown("危险 [点我](javascript:alert(1))");
  assert.equal(unsafeTokens.some((t) => t.type === "link"), false);
});
