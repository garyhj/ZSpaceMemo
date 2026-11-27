export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; label: string; href: string };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; inlines: InlineToken[] }
  | { type: "code"; lang: string; content: string }
  | { type: "checklist"; checked: boolean; inlines: InlineToken[] }
  | { type: "bullet"; inlines: InlineToken[] }
  | { type: "paragraph"; inlines: InlineToken[] };

export function isSafeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

const INLINE_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(([^)\s]+)\)|https?:\/\/[^\s<>"')\]]+)/g;

export function parseInlineMarkdown(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  INLINE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE_PATTERN.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: line.slice(lastIndex, match.index) });
    }
    const full = match[0];
    if (full.startsWith("`") && full.endsWith("`")) {
      tokens.push({ type: "code", text: full.slice(1, -1) });
    } else if (full.startsWith("**") && full.endsWith("**")) {
      tokens.push({ type: "bold", text: full.slice(2, -2) });
    } else if (full.startsWith("*") && full.endsWith("*")) {
      tokens.push({ type: "italic", text: full.slice(1, -1) });
    } else if (full.startsWith("[")) {
      const closeBracket = full.indexOf("]");
      const label = full.slice(1, closeBracket);
      const rawHref = match[2] ?? "";
      const safe = isSafeHttpUrl(rawHref);
      if (safe) {
        tokens.push({ type: "link", label: label || safe, href: safe });
      } else {
        tokens.push({ type: "text", text: full });
      }
    } else {
      const safe = isSafeHttpUrl(full);
      if (safe) {
        tokens.push({ type: "link", label: full, href: safe });
      } else {
        tokens.push({ type: "text", text: full });
      }
    }
    lastIndex = INLINE_PATTERN.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: "text", text: line.slice(lastIndex) });
  }
  return tokens;
}

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang, content: buf.join("\n") });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Headings (#, ##, ###)
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseInlineMarkdown(heading[2]),
      });
      i += 1;
      continue;
    }

    // Checklists (- [ ] / - [x])
    const check = line.match(/^(?:[-*]|\u2610|\u2611)\s+\[([ xX])\]\s+(.*)$/) ??
      line.match(/^([☐☑])\s*(.*)$/);
    if (check) {
      const isBoxSymbol = check[1] === "☐" || check[1] === "☑";
      const checked = isBoxSymbol ? check[1] === "☑" : check[1].toLowerCase() === "x";
      blocks.push({
        type: "checklist",
        checked,
        inlines: parseInlineMarkdown(check[2]),
      });
      i += 1;
      continue;
    }

    // Bullet list
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({
        type: "bullet",
        inlines: parseInlineMarkdown(bullet[1]),
      });
      i += 1;
      continue;
    }

    blocks.push({
      type: "paragraph",
      inlines: parseInlineMarkdown(line),
    });
    i += 1;
  }

  return blocks;
}
