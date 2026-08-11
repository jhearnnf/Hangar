'use strict';

const { execFile } = require('child_process');
const path = require('path');

/**
 * Whether Windows Firewall is set to throw away everything the phone sends.
 *
 * This is worth a file of its own because it is the failure that looks like no
 * failure at all. Windows asks once, the first time Hangar listens on a port:
 * a dialog with two tick boxes, "private networks" ticked and "public networks"
 * not. Answering it that way — or clicking Cancel — does not simply decline to
 * add a rule. It writes a **Block** rule, permanently, and the dialog never
 * appears again.
 *
 * After that the port is open, `netstat` shows it listening, the server is
 * running and correct, and every packet from the phone is silently dropped.
 * Dropped, not refused: the phone gets no answer rather than an error, so it
 * sits on "connecting…" until it gives up. Nothing anywhere says why.
 *
 * So Hangar reads its own rules and says so. `netsh` can list them without
 * elevation, which is the whole reason this is possible; changing them needs
 * administrator, which is why the fix is a button that asks rather than
 * something that happens.
 */

// Rules are printed as blocks of "Field: value" separated by a name line.
const RULE_HEAD = /^Rule Name:\s*(.*)$/i;
const FIELD = /^([A-Za-z ]+):\s*(.*)$/;

/**
 * Pull the rules out of `netsh advfirewall firewall show rule` output.
 *
 * Field names are localised, and on a non-English Windows nothing here matches
 * anything — which is why every caller treats "found nothing" as "no opinion"
 * rather than as "all clear".
 */
function parseRules(output) {
  const rules = [];
  let current = null;

  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trim();

    const head = RULE_HEAD.exec(line);
    if (head) {
      current = { name: head[1].trim() };
      rules.push(current);
      continue;
    }

    if (!current) continue;
    const field = FIELD.exec(line);
    if (!field) continue;

    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    if (key === 'program') current.program = value;
    if (key === 'action') current.action = value.toLowerCase();
    if (key === 'profiles') current.profiles = value;
    if (key === 'enabled') current.enabled = /yes/i.test(value);
    if (key === 'protocol') current.protocol = value;
    if (key === 'localport') current.localPort = value;
    if (key === 'localip') current.localIP = value;
  }

  return rules;
}

/**
 * Block rules that name no program at all.
 *
 * These are the ones worth going looking for, because nothing about them
 * mentions Hangar and yet they stop it dead. Windows resolves a conflict
 * between rules by letting the Block win — always, whatever the Allow says and
 * however much more specific it is — so a single hand-written "block inbound
 * from the network" rule silently outranks every allowance made for the phone,
 * and no amount of correct setting-up anywhere else will shift it.
 *
 * Only reported, never touched. A rule like this was written on purpose by
 * someone who wanted it, and quietly removing it to make a terminal app work
 * would be an appalling thing to do. Naming it is the useful part: it is the
 * one thing nobody would think to look for.
 */
function catchAllBlocks(rules, { port } = {}) {
  return rules.filter((rule) => {
    if (rule.enabled === false || rule.action !== 'block') return false;
    // A rule naming a program is somebody else's problem, not the phone's.
    if (rule.program && !/^any$/i.test(rule.program)) return false;
    if (!matchesProtocol(rule.protocol)) return false;
    return matchesPort(rule.localPort, port);
  });
}

function matchesProtocol(protocol) {
  if (!protocol) return true;
  return /^(any|tcp)$/i.test(protocol.trim());
}

function matchesPort(localPort, port) {
  if (!localPort || /^any$/i.test(localPort)) return true;
  if (!port) return true;

  // "7433", "80,443", "1000-2000", and combinations of those.
  return String(localPort).split(',').some((part) => {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (range) return port >= Number(range[1]) && port <= Number(range[2]);
    return Number(part.trim()) === port;
  });
}

/**
 * The rules that are actively blocking this executable.
 *
 * Matched on the program path, case-insensitively, because Windows stores it
 * lower-cased however it was written when the rule was made.
 */
function blockingRules(rules, execPath) {
  const target = String(execPath || '').toLowerCase();
  if (!target) return [];

  return rules.filter((rule) => (
    rule.enabled !== false
    && rule.action === 'block'
    && rule.program
    && rule.program.toLowerCase() === target
  ));
}

/** The profiles named across a set of rules, tidied for showing to a person. */
function profilesOf(rules) {
  const names = new Set();
  for (const rule of rules) {
    for (const name of String(rule.profiles || '').split(',')) {
      const tidy = name.trim();
      if (tidy) names.add(tidy);
    }
  }
  return [...names];
}

/**
 * Both executables this can be running as.
 *
 * `Hangar.exe` is the icon-stamped copy `npm run exe` makes, and is what the
 * shortcut launches. `electron.exe` beside it is what `npm start` launches.
 * Windows keeps rules per program, so a machine can easily have one allowed and
 * the other blocked — and then Hangar works or does not depending on how it was
 * started that day, which is a thing nobody would ever guess at.
 */
function relatedPrograms(execPath) {
  const dir = path.dirname(execPath);
  const seen = new Set();
  const out = [];

  // Deduplicated case-insensitively, since Windows treats the paths that way,
  // but kept as written — a rule in the Windows Firewall list reading
  // "c:\users\..." when everything else says "C:\Users\..." looks like
  // something else put it there.
  for (const candidate of [execPath, path.join(dir, 'Hangar.exe'), path.join(dir, 'electron.exe')]) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function check({ execPath = process.execPath, port = 7433, run = runNetsh } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ known: false, blocked: false });

  return run().then((output) => {
    const rules = parseRules(output);
    // No rules parsed at all means netsh said something this does not
    // understand — a translated Windows, most likely. Saying nothing is right;
    // claiming everything is fine would not be.
    if (!rules.length) return { known: false, blocked: false };

    // Only the running executable decides whether we are blocked *now*; the
    // sibling is reported so the fix can clear it too, without crying wolf
    // about a program nobody is running.
    const blocking = blockingRules(rules, execPath);
    const alsoBlocked = relatedPrograms(execPath)
      .filter((program) => program !== String(execPath).toLowerCase())
      .some((program) => blockingRules(rules, program).length > 0);

    const catchAll = catchAllBlocks(rules, { port });

    return {
      known: true,
      blocked: blocking.length > 0,
      alsoBlocked,
      profiles: profilesOf(blocking),
      names: [...new Set(blocking.map((r) => r.name))],
      // Separate from `blocked` because the answer is different: one is a rule
      // Hangar wrote the wrong way round and can put right, the other is a rule
      // someone meant, and only they can say what should happen to it.
      catchAll: [...new Set(catchAll.map((r) => r.name))],
      catchAllScope: catchAll.map((r) => ({ name: r.name, localIP: r.localIP, protocol: r.protocol })),
    };
  }).catch(() => ({ known: false, blocked: false }));
}

function runNetsh() {
  return new Promise((resolve, reject) => {
    execFile(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * The PowerShell that puts it right, as one string for `Start-Process -Verb
 * RunAs` to elevate.
 *
 * Deliberately narrower than what Windows would have written had the prompt
 * been answered the other way. That would have allowed the whole executable on
 * every port; this allows two ports, from the local subnet only, and nothing
 * else — so a Hangar that is not sharing is still not reachable, and neither is
 * anything else Electron might ever listen on.
 */
// The carrier-grade NAT range, which is where a mesh VPN — Tailscale, and the
// others that copied it — puts its addresses.
const MESH_RANGE = '100.64.0.0/10';

/**
 * @param {string[]} meshRanges Extra remote ranges to allow, beyond this
 *   network. Passed only when the machine actually has a mesh interface: it is
 *   the difference between letting a VPN you set up reach Hangar and opening a
 *   range to a machine that has no VPN on it at all.
 */
function fixScript({
  execPath = process.execPath, port = 7433, discoveryPort = 7434, meshRanges = [],
} = {}) {
  const escape = (value) => String(value).replace(/'/g, "''");
  const programs = relatedPrograms(execPath);
  const list = programs.map((p) => `'${escape(p)}'`).join(',');
  const remote = ['LocalSubnet', ...meshRanges].map((r) => `'${escape(r)}'`).join(',');

  const lines = [
    '$ErrorActionPreference = "Stop"',
    `$programs = @(${list})`,
    // The Block rules Windows wrote when its prompt was answered. They win over
    // any Allow rule, so they have to go rather than be added to. Both the
    // shortcut's executable and `npm start`'s, so that how Hangar was launched
    // stops being something that changes whether the phone works.
    'Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue |'
    + ' Where-Object { $programs -contains ($_ | Get-NetFirewallApplicationFilter).Program } |'
    + ' Remove-NetFirewallRule -ErrorAction SilentlyContinue',
    // And any earlier version of what is about to be added, so this is safe to
    // run twice.
    'Get-NetFirewallRule -DisplayName "Hangar (phone)*" -ErrorAction SilentlyContinue'
    + ' | Remove-NetFirewallRule -ErrorAction SilentlyContinue',
  ];

  programs.forEach((program, i) => {
    const suffix = i === 0 ? '' : ` ${i + 1}`;
    lines.push(
      `New-NetFirewallRule -DisplayName "Hangar (phone)${suffix}" -Direction Inbound -Action Allow`
      + ` -Program '${escape(program)}' -Protocol TCP -LocalPort ${Number(port)}`
      + ` -RemoteAddress @(${remote}) -Profile Any -ErrorAction SilentlyContinue | Out-Null`,
      // Discovery is a broadcast, which no mesh carries, so it stays local.
      `New-NetFirewallRule -DisplayName "Hangar (phone discovery)${suffix}" -Direction Inbound -Action Allow`
      + ` -Program '${escape(program)}' -Protocol UDP -LocalPort ${Number(discoveryPort)}`
      + ' -RemoteAddress LocalSubnet -Profile Any -ErrorAction SilentlyContinue | Out-Null',
    );
  });

  lines.push('Write-Host "Hangar can now be reached on this network."');
  return lines.join('; ');
}

module.exports = {
  check, parseRules, blockingRules, catchAllBlocks, profilesOf, fixScript, MESH_RANGE,
};
