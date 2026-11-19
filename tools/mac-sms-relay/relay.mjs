#!/usr/bin/env node
// Mac text relay: reads incoming texts (SMS and RCS) from the Messages app on this Mac and posts them to the
// platform as enquiries. Read-only on Messages. No dependencies: uses macOS's own sqlite3.
//
//   AAAS_SMS_URL=https://aaas-platform.fly.dev/webhooks/sms/<token> node relay.mjs
//
// Needs: an iPhone with "Text Message Forwarding" on for this Mac, and Full Disk Access for whatever runs this
// (System Settings → Privacy & Security → Full Disk Access). See README.md.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.AAAS_SMS_URL;
const DB = process.env.AAAS_MESSAGES_DB ?? join(homedir(), "Library/Messages/chat.db");
const STATE_DIR = join(homedir(), "Library/Application Support/aaas-sms-relay");
const STATE = join(STATE_DIR, "state.json");
const EVERY_MS = Number(process.env.AAAS_SMS_EVERY_SECONDS ?? 30) * 1000;
const ONCE = process.argv.includes("--once");
const APPLE_EPOCH = Date.UTC(2001, 0, 1);

if (!URL_ || !/^(https:\/\/[^/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/webhooks\/sms\/[\w-]+$/.test(URL_)) {
  console.error("Set AAAS_SMS_URL to the link from the admin app (Connections → Text messages from a Mac).");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sql = (q) => {
  const out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", DB, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
};

function loadState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; }
}
function saveState(s) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); }

/** Newer macOS keeps the text only inside attributedBody (an NSArchiver blob). Pull the NSString out of it. */
function textFromAttributedBody(hex) {
  if (!hex) return "";
  const b = Buffer.from(hex, "hex");
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  let i = b.indexOf(0x2b, at + 8);           // '+' marks the start of the string
  if (i < 0) return "";
  i++;
  let len = b[i++];
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = b.readUIntLE(i, 3); i += 3; }
  return b.subarray(i, i + len).toString("utf8");
}

// Only real phone numbers: skips bank codes, delivery notices and other short or named senders.
const isPhone = (h) => /^\+?\d{10,15}$/.test((h ?? "").replace(/[\s-]/g, ""));

function newTexts(after) {
  return sql(`select m.ROWID as rowid, m.guid, m.text, hex(m.attributedBody) as ab, m.date, h.id as handle
    from message m left join handle h on h.ROWID = m.handle_id
    where m.is_from_me = 0 and m.service in ('SMS', 'RCS') and m.ROWID > ${Number(after)}
    order by m.ROWID limit 200`);
}

async function tick() {
  let state = loadState();
  if (!state) {
    // First run: start from now, so old texts aren't sent as new enquiries.
    const [{ max }] = sql("select coalesce(max(ROWID), 0) as max from message");
    saveState(state = { lastRowid: max });
    log(`Started. Watching for texts after message ${max}.`);
    return;
  }
  const rows = newTexts(state.lastRowid);
  if (!rows.length) return;
  const messages = rows
    .filter((r) => isPhone(r.handle))
    .map((r) => {
      const d = Number(r.date);
      const ms = APPLE_EPOCH + (d > 1e12 ? d / 1e6 : d * 1000);
      return { id: r.guid, from: r.handle, text: (r.text ?? textFromAttributedBody(r.ab)).trim(), receivedAt: new Date(ms).toISOString() };
    })
    .filter((m) => m.text);
  if (messages.length) {
    const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
    if (!res.ok) throw new Error(`Platform said ${res.status}. Will try again.`);
    log(`Sent ${messages.length} text${messages.length === 1 ? "" : "s"}.`);
  }
  saveState({ lastRowid: rows[rows.length - 1].rowid });
}

async function main() {
  for (;;) {
    try { await tick(); } catch (e) {
      const msg = String(e?.message ?? e);
      log(/unable to open|authori[sz]ation denied|not permitted/i.test(msg)
        ? "Can't read Messages. Give Full Disk Access to the app running this relay (see README)."
        : msg);
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
}
main();
