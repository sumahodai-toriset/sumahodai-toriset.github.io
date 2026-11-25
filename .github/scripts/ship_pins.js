#!/usr/bin/env node
/**
 * Pinterest 用のフィードに、在庫（pins/queue.json）からピンを少しずつ足す。
 *
 * 毎日 GitHub Actions（.github/workflows/pins.yml）が実行する。
 * Pinterest は、つないだ RSS フィードに新しい項目が増えると、24時間以内に自動でピンにする。
 * 一度に全部を足すと一括でピンになるので、1日 PINS_PER_DAY 件ずつ足す（既定は1件）。
 *
 *   node .github/scripts/ship_pins.js            本番（ファイルを書き換える）
 *   node .github/scripts/ship_pins.js --dry-run  何を足すかを表示するだけ
 *
 * 決まり:
 *  - shipped が false のものだけが対象。足したら shipped を true にする
 *  - not_before（YYYY-MM-DD）があれば、その日より前には出さない
 *  - ボードが偏らないよう、まだピンが少ないボードから1件ずつ選ぶ
 *  - 同じ guid が既にフィードにあれば足さない（二重に出さない）
 *  - 在庫が無ければ何もしない
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "pins");
const QUEUE = path.join(DIR, "queue.json");
const MAX = parseInt(process.env.PINS_PER_DAY || "1", 10);
const DRY = process.argv.includes("--dry-run");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const queue = JSON.parse(fs.readFileSync(QUEUE, "utf-8"));
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

// ボードごとの出荷済みの数（少ないボードを先に）
const shippedCount = {};
for (const p of queue) shippedCount[p.board_slug] = (shippedCount[p.board_slug] || 0) + (p.shipped ? 1 : 0);
const waiting = queue.filter((p) => !p.shipped && (!p.not_before || p.not_before <= today));
const byBoard = {};
for (const p of waiting) (byBoard[p.board_slug] = byBoard[p.board_slug] || []).push(p);
const boards = Object.keys(byBoard).sort((a, b) => shippedCount[a] - shippedCount[b] || a.localeCompare(b));

const picked = [];
while (picked.length < MAX && boards.some((b) => byBoard[b].length)) {
  for (const b of boards) {
    if (picked.length >= MAX) break;
    const p = byBoard[b].shift();
    if (p) picked.push(p);
  }
}

if (!picked.length) { console.log("在庫なし。何もしない（残り 0 件）"); process.exit(0); }

const pubDate = new Date().toUTCString();
let added = 0;
for (const p of picked) {
  const feed = path.join(DIR, p.board_slug + ".xml");
  let xml = fs.readFileSync(feed, "utf-8");
  if (xml.includes(p.guid)) { console.log("既にある（足さない）: " + p.guid); p.shipped = true; p.shipped_at = p.shipped_at || today; continue; }
  if (!xml.includes("</channel>")) throw new Error("フィードの形が違う: " + feed);
  const item =
    "<item>\n" +
    "<title>" + esc(p.title) + "</title>\n" +
    "<link>" + esc(p.link) + "</link>\n" +
    "<description>" + esc(p.description) + "</description>\n" +
    '<guid isPermaLink="false">' + esc(p.guid) + "</guid>\n" +
    "<pubDate>" + pubDate + "</pubDate>\n" +
    '<enclosure url="' + esc(p.image) + '" length="' + (p.image_bytes || 0) + '" type="image/jpeg"/>\n' +
    '<media:content url="' + esc(p.image) + '" medium="image" type="image/jpeg"/>\n' +
    "</item>\n";
  xml = xml.replace("</channel>", item + "</channel>");
  console.log((DRY ? "（試し）" : "") + "足す: [" + p.board + "] " + p.title);
  if (!DRY) fs.writeFileSync(feed, xml);
  p.shipped = true; p.shipped_at = today; added++;
}
if (!DRY) fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 1) + "\n");
console.log("足した " + added + " 件 ／ 残り " + queue.filter((p) => !p.shipped).length + " 件");
