import { describe, it, expect } from 'vitest';
import { parseRules, blockingRules, catchAllBlocks, profilesOf, fixScript, check } from '../firewall.js';

// Trimmed from what `netsh advfirewall firewall show rule name=all dir=in
// verbose` really printed on the machine this was written for — the case that
// started all of it: Block on Public, Allow on Private, and an active network
// Windows had decided was Public.
const NETSH = `
Rule Name:                            hangar.exe
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Program:                              C:\\users\\james\\desktop\\cursor projects\\hangar\\node_modules\\electron\\dist\\hangar.exe
Action:                               Block

Rule Name:                            hangar.exe
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             TCP
Program:                              C:\\users\\james\\desktop\\cursor projects\\hangar\\node_modules\\electron\\dist\\hangar.exe
Action:                               Allow

Rule Name:                            Something Else
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Protocol:                             TCP
Program:                              C:\\program files\\other\\other.exe
Action:                               Block

Ok.
`;

const HANGAR = 'C:\\Users\\James\\Desktop\\Cursor Projects\\Hangar\\node_modules\\electron\\dist\\Hangar.exe';

describe('parseRules', () => {
  it('reads each rule as its own block of fields', () => {
    const rules = parseRules(NETSH);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({ name: 'hangar.exe', action: 'block', profiles: 'Public', enabled: true });
  });

  it('has no opinion about output it cannot read', () => {
    expect(parseRules('')).toEqual([]);
    expect(parseRules('Regelname: irgendwas')).toEqual([]);
  });
});

describe('blockingRules', () => {
  it('finds the rule that is throwing the phone away', () => {
    const found = blockingRules(parseRules(NETSH), HANGAR);
    expect(found).toHaveLength(1);
    expect(found[0].profiles).toBe('Public');
  });

  it('matches the path however Windows happens to have cased it', () => {
    const found = blockingRules(parseRules(NETSH), HANGAR.toUpperCase());
    expect(found).toHaveLength(1);
  });

  it('leaves other programs alone', () => {
    const found = blockingRules(parseRules(NETSH), 'C:\\program files\\other\\other.exe');
    expect(found[0].name).toBe('Something Else');
  });

  it('ignores a rule that is switched off', () => {
    const off = parseRules(NETSH).map((r) => ({ ...r, enabled: false }));
    expect(blockingRules(off, HANGAR)).toEqual([]);
  });

  it('says nothing about a program it was not given', () => {
    expect(blockingRules(parseRules(NETSH), '')).toEqual([]);
    expect(blockingRules(parseRules(NETSH), null)).toEqual([]);
  });
});

// The rule that actually stopped this working, and the reason the check looks
// past Hangar's own: it names no program, so nothing about it mentions Hangar,
// and Windows lets it beat every Allow rule sitting beside it.
const CATCH_ALL = `
Rule Name:                            block all other devices on router
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
LocalIP:                              192.168.18.0-192.168.18.255
RemoteIP:                             Any
Protocol:                             Any
Action:                               Block

Rule Name:                            block printing
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
LocalIP:                              Any
Protocol:                             TCP
LocalPort:                            9100
Action:                               Block

Rule Name:                            off for now
----------------------------------------------------------------------
Enabled:                              No
Direction:                            In
Profiles:                             Public
Protocol:                             Any
Action:                               Block
`;

describe('catchAllBlocks', () => {
  it('finds the rule that blocks everything without naming anything', () => {
    const found = catchAllBlocks(parseRules(CATCH_ALL), { port: 7433 });
    expect(found.map((r) => r.name)).toEqual(['block all other devices on router']);
  });

  it('ignores a block aimed at a port that is not ours', () => {
    const found = catchAllBlocks(parseRules(CATCH_ALL), { port: 9100 });
    expect(found.map((r) => r.name)).toContain('block printing');
  });

  it('ignores a rule that is switched off', () => {
    const found = catchAllBlocks(parseRules(CATCH_ALL), { port: 7433 });
    expect(found.map((r) => r.name)).not.toContain('off for now');
  });

  it('leaves rules that name a program to the other check', () => {
    expect(catchAllBlocks(parseRules(NETSH), { port: 7433 })).toEqual([]);
  });

  it('reads a port list and a port range', () => {
    const ports = (localPort, port) => catchAllBlocks(
      parseRules(`\nRule Name: r\nEnabled: Yes\nAction: Block\nProtocol: TCP\nLocalPort: ${localPort}\n`),
      { port },
    ).length;

    expect(ports('80,443,7433', 7433)).toBe(1);
    expect(ports('80,443', 7433)).toBe(0);
    expect(ports('7000-8000', 7433)).toBe(1);
    expect(ports('7000-7400', 7433)).toBe(0);
  });

  it('is reported by check, separately from the rules naming Hangar', async () => {
    const state = await check({ execPath: HANGAR, port: 7433, run: async () => CATCH_ALL });
    expect(state.blocked).toBe(false);
    expect(state.catchAll).toEqual(['block all other devices on router']);
    expect(state.catchAllScope[0].localIP).toBe('192.168.18.0-192.168.18.255');
  });
});

describe('profilesOf', () => {
  it('names the profiles once each', () => {
    expect(profilesOf([{ profiles: 'Public,Private' }, { profiles: 'Public' }]))
      .toEqual(['Public', 'Private']);
  });
});

describe('check', () => {
  it('reports the block, and where', async () => {
    const state = await check({ execPath: HANGAR, run: async () => NETSH });
    expect(state).toMatchObject({ known: true, blocked: true, profiles: ['Public'] });
  });

  it('is quiet when the rules allow', async () => {
    const allowed = NETSH.replace(/Action:\s+Block/, 'Action:                               Allow');
    const state = await check({ execPath: HANGAR, run: async () => allowed });
    expect(state).toMatchObject({ known: true, blocked: false });
  });

  it('admits it does not know rather than claiming all is well', async () => {
    expect(await check({ execPath: HANGAR, run: async () => 'Regelname: irgendwas' }))
      .toEqual({ known: false, blocked: false });
    expect(await check({ execPath: HANGAR, run: async () => { throw new Error('nope'); } }))
      .toEqual({ known: false, blocked: false });
  });
});

describe('fixScript', () => {
  const script = fixScript({ execPath: HANGAR, port: 7433, discoveryPort: 7434 });

  it('takes the blocking rule away, since a Block beats any Allow beside it', () => {
    expect(script).toContain('Remove-NetFirewallRule');
    expect(script).toContain('-Action Block');
  });

  it('allows the two ports and nothing else', () => {
    expect(script).toContain('-Protocol TCP -LocalPort 7433');
    expect(script).toContain('-Protocol UDP -LocalPort 7434');
  });

  it('allows them only from this network, not from anywhere', () => {
    // Two ports each, for both the shortcut's exe and the one 'npm start' uses.
    expect(script.match(/LocalSubnet/g)).toHaveLength(4);
    expect(script).not.toContain('-RemoteAddress Any');
  });

  it('leaves the mesh range out on a machine that has no mesh', () => {
    expect(script).not.toContain('100.64.0.0/10');
  });

  it('adds the mesh range only when asked, and only to the port a phone dials', () => {
    const meshed = fixScript({ execPath: HANGAR, meshRanges: ['100.64.0.0/10'] });

    expect(meshed).toContain("-RemoteAddress @('LocalSubnet','100.64.0.0/10')");
    // Discovery is a broadcast and no mesh carries one, so it stays local —
    // offering the range there would be an allowance nothing could ever use.
    expect(meshed).toMatch(/discovery[^;]*-RemoteAddress LocalSubnet/);
  });

  it('can be run twice without stacking rules up', () => {
    expect(script).toContain('Get-NetFirewallRule -DisplayName "Hangar (phone)*"');
  });

  it('cannot be broken out of by a quote in the path', () => {
    const nasty = fixScript({ execPath: "C:\\it's here\\hangar.exe" });
    expect(nasty).toContain("C:\\it''s here\\hangar.exe");
  });
});
