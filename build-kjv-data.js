// Converter: kjv.csv -> kjv-data.js
//
// Flattens the verse-per-row CSV into one marker-annotated string assigned to
// window.KJV_TEXT: % start of book (resets chapter/verse), $ end of book,
// # end of chapter, @ end of verse. No newlines, no chapter/verse numbers —
// the markers carry all the structure the codec needs to round-trip.
//
// Parser strategy: rather than track CSV quote state strictly, anchor on the
// regular record-start pattern "BookName,bookNum,chapterNum,verseNum," and
// treat any physical line that doesn't match it as a continuation of the
// previous record's verse_text (source rows occasionally wrap verse_text
// across a literal embedded newline).
//
// Run from the repo root: node build-kjv-data.js
const fs = require("fs");

const raw = fs.readFileSync("kjv.csv", "utf8");
const lines = raw.split("\n");

const RECORD_START = /^([0-9A-Za-z ]+),(\d+),(\d+),(\d+),(.*)$/;

function unquote(field) {
  let f = field;
  if (f.startsWith('"')) f = f.slice(1);
  if (f.endsWith('"')) f = f.slice(0, -1);
  return f.replace(/""/g, '"');
}

const records = [];
let current = null;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (line === "" && i === lines.length - 1) continue; // trailing newline
  const m = RECORD_START.exec(line);
  if (m) {
    if (current) records.push(current);
    current = {
      bookNumber: m[2],
      chapterNumber: m[3],
      verseText: unquote(m[5]),
    };
  } else {
    if (!current) throw new Error(`orphan continuation line at ${i + 1}: ${JSON.stringify(line)}`);
    current.verseText += " " + unquote(line);
  }
}
if (current) records.push(current);

let out = "";
let prevBook = null;

for (let i = 0; i < records.length; i++) {
  const r = records[i];
  const next = records[i + 1];

  if (r.bookNumber !== prevBook) out += "%";
  out += r.verseText.replace(/\s+/g, " ").trim();

  if (!next || r.bookNumber !== next.bookNumber) out += "$";
  else if (r.chapterNumber !== next.chapterNumber) out += "#";
  else out += "@";

  prevBook = r.bookNumber;
}

const jsOut = "window.KJV_TEXT = " + JSON.stringify(out) + ";\n";
fs.writeFileSync("kjv-data.js", jsOut);
console.log(`${records.length} verses, ${Buffer.byteLength(out, "utf8")} bytes -> kjv-data.js`);
