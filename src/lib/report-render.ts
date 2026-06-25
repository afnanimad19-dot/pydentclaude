import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { createClient } from "@supabase/supabase-js";

// Save a generated report and return its id (for a download link). Server-only.
export async function saveReport(ws: string, agentKey: string, title: string, md: string): Promise<string | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!key) return null;
  const admin = createClient(url, key);
  const { data } = await admin.from("reports").insert({ workspace_id: ws, agent_key: agentKey, title: title.slice(0, 200), content_md: md }).select("id").single();
  return data?.id ?? null;
}

// Renders an agent's Markdown report into a downloadable DOCX (Word/Google Docs)
// or a print-ready HTML (which saves to PDF from the browser). Simple Markdown:
// #/##/### headings, - bullets, **bold**, blank lines = paragraphs.

function inlineRuns(text: string): TextRun[] {
  // Split on **bold** segments.
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) =>
    p.startsWith("**") && p.endsWith("**")
      ? new TextRun({ text: p.slice(2, -2), bold: true })
      : new TextRun(p)
  );
}

export async function markdownToDocx(title: string, md: string): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { children.push(new Paragraph("")); continue; }
    if (line.startsWith("### ")) children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    else if (line.startsWith("## ")) children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    else if (line.startsWith("# ")) children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    else if (/^\s*[-*]\s+/.test(line)) children.push(new Paragraph({ children: inlineRuns(line.replace(/^\s*[-*]\s+/, "")), bullet: { level: 0 } }));
    else children.push(new Paragraph({ children: inlineRuns(line) }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineHtml(s: string) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function markdownToHtml(title: string, md: string): string {
  const body: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { body.push("</ul>"); inList = false; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith("### ")) { closeList(); body.push(`<h3>${inlineHtml(line.slice(4))}</h3>`); }
    else if (line.startsWith("## ")) { closeList(); body.push(`<h2>${inlineHtml(line.slice(3))}</h2>`); }
    else if (line.startsWith("# ")) { closeList(); body.push(`<h1>${inlineHtml(line.slice(2))}</h1>`); }
    else if (/^[-*]\s+/.test(line)) { if (!inList) { body.push("<ul>"); inList = true; } body.push(`<li>${inlineHtml(line.replace(/^[-*]\s+/, ""))}</li>`); }
    else { closeList(); body.push(`<p>${inlineHtml(line)}</p>`); }
  }
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1f2937;line-height:1.6}
h1{font-size:28px}h2{font-size:20px;margin-top:1.6em}h3{font-size:16px}ul{padding-left:22px}
.print{position:fixed;top:16px;right:16px}@media print{.print{display:none}}</style></head>
<body><button class="print" onclick="window.print()">Save as PDF</button><h1>${esc(title)}</h1>${body.join("\n")}</body></html>`;
}
