// batch/parser.mjs
// Parse batch-input.txt into structured works.
// Format per work:
//   <序号>. 《标题》——作者      (author optional)
//   <正文第一行>
//   ...
//   <空行>  only separates paragraphs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const batchDir = dirname(fileURLToPath(import.meta.url));

// 序号. 《标题》 (optional（节选）etc. kept in title) ——作者  OR  no author
const HEAD_RE = /^\s*(\d+)\.\s*《([^》]+)》(?:([（(][^）)]*[）)]))?\s*(?:——\s*(.*))?$/;
const HAN_RE = /[\u3400-\u9fff]/gu;

export function parseBatchInput(text) {
  const lines = text.split(/\r?\n/);
  const works = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const head = HEAD_RE.exec(line);
    if (head) {
      // Preserve an optional suffix like （节选） as part of the title so it is
      // not lost from display names and PDF filenames.
      const title = head[2] + (head[3] || "");
      current = {
        index: Number(head[1]),
        title,
        author: (head[4] || "").trim(),
        rawLines: [],
      };
      works.push(current);
      continue;
    }
    if (current) current.rawLines.push(line);
  }
  // Build final fields: keep line breaks verbatim; non-empty lines are sentences.
  for (const work of works) {
    const nonEmpty = work.rawLines.filter((line) => line.trim().length > 0);
    work.sourceText = work.rawLines.join("\n");
    work.nonEmptyLines = nonEmpty;
    work.sentenceCount = nonEmpty.length;
    work.hanCounts = nonEmpty.map((line) => (line.match(HAN_RE) || []).length);
    // stable hash: title + author + sourceText
    work.sourceHash = createHash("sha256")
      .update(`${work.title}\u0000${work.author}\u0000${work.sourceText}`)
      .digest("hex")
      .slice(0, 16);
  }
  return works;
}

export function readBatchInput(filePath = join(batchDir, "batch-input.txt")) {
  return readFileSync(filePath, "utf8");
}

export { batchDir };
