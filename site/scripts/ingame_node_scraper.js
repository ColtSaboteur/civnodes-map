/*
 * nodescan.js — manual /nodeprint scanner for jsmacros
 * ---------------------------------------------------------------
 * INSTALL
 *   1. Drop this file in your jsmacros macro folder
 *        .minecraft/config/jsmacros/macros/nodescan.js
 *   2. In-game: open the jsmacros menu -> Scripts -> Add Script
 *        - File: nodescan.js
 *        - Trigger: Key
 *        - Key: pick any key you don't already use (e.g. "N")
 *
 * USE
 *   Stand still, press your bound key. The script:
 *     1. reads your current position (used as the center of the scan)
 *     2. runs /nodeprint 19
 *     3. listens for the 19 chat lines that make up the grid
 *     4. decodes each of the 361 cells into an absolute chunk + node type
 *     5. merges the results into DATA_FILE (kept on disk, so progress
 *        survives restarts) and prints how many chunks are known so far
 *   That's it — no auto-navigation, you decide where to walk next.
 *
 * NOTES / LIMITATIONS
 *   - The middle row/column and outer edge midpoints of every scan are
 *     overwritten by the N / S / E / W / ^ markers, so those 5 chunks
 *     (out of 361) are never recorded by a given scan.
 *   - You must stand still for the ~1 second the scan takes; the script
 *     grabs your position once at the start and assumes it doesn't
 *     change while the 19 lines come in.
 */

// ============================== CONFIG ==============================
var DATA_FILE = "nodemap_data.json";   // saved inside your jsmacros folder
var SCAN_TIMEOUT_MS = 5000;             // give up waiting for the 19 lines after this long
// ======================================================================

var GRID_CHARS = "\u2588\u2593\u2592#"; // █ ▓ ▒ #
var MARKER_CHARS = "NSWE^v<>"; // compass letters + player-facing arrow (rotates: ^ v < >)
var ALLOWED_CHARS = GRID_CHARS + MARKER_CHARS;
var GRID_LINE_RE = new RegExp("^[" + ALLOWED_CHARS + "]{19}$");

// Convert whatever RecvMessage hands us (plain JS string on some jsmacros
// versions, a Java TextHelper object on others) into a real JS string.
function toJsString(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "string") return x;
  try { if (typeof x.getStringStripFormatting === "function") return x.getStringStripFormatting(); } catch (e) {}
  try { if (typeof x.getString === "function") return x.getString(); } catch (e) {}
  try { var s = String(x); if (s && s !== "undefined") return s; } catch (e) {}
  return null;
}

function stripFormatting(s) {
  return s.replace(/\u00a7./g, "");
}

function compactLine(raw) {
  return stripFormatting(raw).replace(/\s+/g, "");
}

function isGridLine(compact) {
  return GRID_LINE_RE.test(compact);
}

function readEventText(event) {
  var s = null;
  try { s = toJsString(event.text); } catch (e) {}
  if (s !== null) return s;
  try { s = toJsString(event.getMessage()); } catch (e) {}
  if (s !== null) return s;
  try { s = toJsString(event.message); } catch (e) {}
  return s;
}

function isMissingFileError(e) {
  var msg = "";
  try { msg = String(e); } catch (_e) {}
  msg = msg.toLowerCase();
  return msg.indexOf("no such file") !== -1 ||
         msg.indexOf("cannot find") !== -1 ||
         msg.indexOf("filenotfound") !== -1 ||
         msg.indexOf("does not exist") !== -1;
}

// Loads DATA_FILE. Returns null (never a fresh empty object) if anything
// looks even slightly uncertain, so the caller can abort the scan instead
// of risking an overwrite of real data. The ONLY case that returns a fresh
// {nodes:{}} is a read error that clearly indicates the file has never
// existed (first run) or content that parses to valid, empty JSON.
function loadData() {
  var f = FS.open(DATA_FILE);
  var raw = null;
  try {
    raw = f.read();
  } catch (e) {
    if (isMissingFileError(e)) {
      Chat.log("\u00a7e[nodescan] No existing " + DATA_FILE + " found — starting a new one.");
      return { nodes: {} };
    }
    Chat.log("\u00a7c[nodescan] Could not read " + DATA_FILE + " (" + e + "). Aborting this scan WITHOUT saving, so nothing gets overwritten. Check the file / permissions and try again.");
    return null;
  }
  if (raw === null || raw === undefined || raw === "") {
    return { nodes: {} };
  }
  try {
    var parsed = JSON.parse(raw);
    if (!parsed.nodes) parsed.nodes = {};
    return parsed;
  } catch (e) {
    var backupName = DATA_FILE + "." + Date.now() + ".corrupt.bak";
    try {
      FS.open(backupName).write(raw);
      Chat.log("\u00a7c[nodescan] " + DATA_FILE + " wasn't valid JSON. Copied the original content to " + backupName + " before touching anything — your old data is safe there. Continuing with a fresh node list; merge the backup back in by hand if you need it.");
    } catch (e2) {
      Chat.log("\u00a7c[nodescan] " + DATA_FILE + " wasn't valid JSON, and backing it up also failed (" + e2 + "). Aborting this scan WITHOUT touching the file.");
      return null;
    }
    return { nodes: {} };
  }
}

// Keeps a rolling one-generation backup: whatever was on disk before this
// write gets copied to DATA_FILE + ".bak" first, so a bad write can never
// destroy the only copy of your progress.
function saveData(data) {
  try {
    var f = FS.open(DATA_FILE);
    var prevRaw = null;
    try { prevRaw = f.read(); } catch (e) {}
    if (prevRaw) {
      try { FS.open(DATA_FILE + ".bak").write(prevRaw); } catch (e) {}
    }
    f.write(JSON.stringify(data));
  } catch (e) {
    Chat.log("\u00a7c[nodescan] Failed to write " + DATA_FILE + ": " + e);
  }
}

function scanAndParse(callback) {
  var lines = [];
  var done = false;

  var listener = JavaWrapper.methodToJava(function (event) {
    if (done) return;
    var raw = readEventText(event);
    if (raw === null) return;
    var compact = compactLine(raw);
    if (isGridLine(compact)) {
      lines.push(compact);
      if (lines.length >= 19) {
        done = true;
        JsMacros.off("RecvMessage", listener);
        callback(lines);
      }
    }
  });

  JsMacros.on("RecvMessage", listener);
  Chat.say("/nodeprint 19");

  var waited = 0;
  while (!done && waited < SCAN_TIMEOUT_MS) {
    Time.sleep(50);
    waited += 50;
  }
  if (!done) {
    JsMacros.off("RecvMessage", listener);
    Chat.log("\u00a7c[nodescan] Timed out waiting for /nodeprint output (" + lines.length + "/19 lines seen).");
  }
}

function runScan() {
  var player = Player.getPlayer();
  if (!player) {
    Chat.log("\u00a7c[nodescan] No player found.");
    return;
  }
  var px = player.getX(), pz = player.getZ();
  var pcx = Math.floor(px / 16), pcz = Math.floor(pz / 16);

  Chat.log("\u00a7e[nodescan] Scanning from chunk (" + pcx + ", " + pcz + ") — stand still...");

  scanAndParse(function (lines) {
    var data = loadData();
    if (data === null) return; // loadData already explained why we're stopping — nothing was touched
    var addedCount = 0;

    for (var r = 0; r < 19; r++) {
      var row = lines[r];
      for (var c = 0; c < 19; c++) {
        var ch = row.charAt(c);
        if (MARKER_CHARS.indexOf(ch) !== -1) continue; // N/S/E/W/^ overwrote this cell — no data
        if (GRID_CHARS.indexOf(ch) === -1) continue;   // unexpected char, skip defensively

        var cx = pcx + (c - 9);
        var cz = pcz + (r - 9);
        data.nodes[cx + "," + cz] = ch;
        addedCount++;
      }
    }

    saveData(data);

    var totalNodes = Object.keys(data.nodes).length;
    Chat.log("\u00a7a[nodescan] Saved " + addedCount + " cells this scan. Total known chunks: " + totalNodes + ".");
  });
}

runScan();
