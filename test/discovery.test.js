import { describe, it, expect } from 'vitest';
import { lanAddresses, addressKind, isPrivateAddress } from '../discovery.js';
import { loginItem, startedHidden, isPackagedLayout, HIDDEN_FLAG } from '../startup.js';

describe('isPrivateAddress', () => {
  it('recognises the ranges a home network uses', () => {
    for (const ip of ['192.168.1.42', '10.0.0.5', '172.16.9.9', '172.31.0.1', '127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  // Load-bearing for the mesh-VPN route: a Tailscale peer arrives from
  // 100.64/10, and the server drops anything it does not count as local.
  it('accepts a mesh VPN peer, which is neither the LAN nor the internet', () => {
    expect(isPrivateAddress('100.83.129.23')).toBe(true);
    expect(isPrivateAddress('100.101.102.103')).toBe(true);
  });

  it('refuses the rest of the internet', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.7', '1.1.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('sees through the form Node reports a v4 peer in on a v6 socket', () => {
    expect(isPrivateAddress('::ffff:192.168.0.4')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('knows the v6 local ranges', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1c2b')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('is false for nothing at all rather than throwing on it', () => {
    expect(isPrivateAddress(null)).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
    expect(isPrivateAddress('not an address')).toBe(false);
  });
});

describe('lanAddresses', () => {
  const interfaces = {
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
    ],
    'vEthernet (WSL)': [
      { address: '172.28.16.1', family: 'IPv4', internal: false },
    ],
    'Wi-Fi': [
      { address: '192.168.1.42', family: 'IPv4', internal: false },
      { address: 'fe80::1c2b', family: 'IPv6', internal: false },
    ],
    'Ethernet 2': [
      { address: '169.254.7.7', family: 'IPv4', internal: false },
    ],
  };

  it('offers only addresses another device could actually reach', () => {
    const found = lanAddresses(interfaces).map((a) => a.address);
    expect(found).toContain('192.168.1.42');
    expect(found).not.toContain('127.0.0.1');     // no use to a phone
    expect(found).not.toContain('169.254.7.7');   // DHCP gave up
    expect(found).not.toContain('fe80::1c2b');    // phones type v4
  });

  it('says which interface each one is, so two can be told apart', () => {
    expect(lanAddresses(interfaces)[0]).toEqual({ name: 'Wi-Fi', address: '192.168.1.42', kind: 'lan' });
  });

  it('copes with a machine that has no network at all', () => {
    expect(lanAddresses({})).toEqual([]);
    expect(lanAddresses(undefined)).toEqual(expect.any(Array));
  });

  it('reads the numeric family newer Node reports', () => {
    const found = lanAddresses({ eth: [{ address: '10.1.2.3', family: 4, internal: false }] });
    expect(found).toEqual([{ name: 'eth', address: '10.1.2.3', kind: 'lan' }]);
  });

  // A mesh VPN address is real, reachable, and useless from a phone that is not
  // on the mesh — and it fails by going silent, which is exactly how a firewall
  // and the wrong wifi and a switched-off PC all fail too. So it is marked, and
  // it sorts below the address that is simply on the network.
  it('tells a VPN address apart from one on the actual network', () => {
    const found = lanAddresses({
      Tailscale: [{ address: '100.83.129.23', family: 'IPv4', internal: false }],
      Ethernet: [{ address: '192.168.18.32', family: 'IPv4', internal: false }],
    });

    expect(found.map((a) => a.address)).toEqual(['192.168.18.32', '100.83.129.23']);
    expect(found.map((a) => a.kind)).toEqual(['lan', 'overlay']);
  });

  it('does not mistake an ordinary 100.x address for a mesh one', () => {
    expect(addressKind('100.83.129.23')).toBe('overlay');   // 100.64/10
    expect(addressKind('100.63.0.1')).toBe('other');        // just below it
    expect(addressKind('100.128.0.1')).toBe('other');       // just above it
    expect(addressKind('192.168.1.1')).toBe('lan');
  });
});

describe('loginItem', () => {
  const appPath = 'C:\\Users\\you\\Projects\\Hangar';
  const electron = 'C:\\Users\\you\\Projects\\Hangar\\node_modules\\electron\\dist\\electron.exe';
  const branded = 'C:\\Users\\you\\Projects\\Hangar\\node_modules\\electron\\dist\\Hangar.exe';

  it('prefers the icon-stamped copy, so the startup list says Hangar', () => {
    const item = loginItem({ execPath: electron, appPath, exists: (p) => p === branded });
    expect(item.path).toBe(branded);
    expect(item.args).toEqual([appPath]);
  });

  it('falls back to electron.exe in a checkout that never ran the script', () => {
    const item = loginItem({ execPath: electron, appPath, exists: () => false });
    expect(item.path).toBe(electron);
    expect(item.args).toEqual([appPath]);
  });

  it('carries the source folder, or the exe would launch Electron itself', () => {
    const item = loginItem({ execPath: electron, appPath, exists: () => false });
    expect(item.args).toContain(appPath);
  });

  it('adds the hidden flag only when asked, and only to the startup entry', () => {
    const shown = loginItem({ execPath: electron, appPath, exists: () => false });
    const hidden = loginItem({ execPath: electron, appPath, hidden: true, exists: () => false });

    expect(shown.args).not.toContain(HIDDEN_FLAG);
    expect(hidden.args).toContain(HIDDEN_FLAG);
  });

  it('a packaged build is the app, and takes no folder', () => {
    const item = loginItem({
      execPath: 'C:\\Program Files\\Hangar\\Hangar.exe',
      appPath: 'C:\\Program Files\\Hangar\\resources\\app.asar',
    });
    expect(item.args).toEqual([]);
  });

  // The bug this guards: `app.isPackaged` is true for any exe not called
  // electron.exe, so the icon-stamped copy looked packaged and the startup
  // entry went out as `Hangar.exe --hidden` — Electron's welcome window.
  it('the icon-stamped copy still carries the folder, packaged though it looks', () => {
    const item = loginItem({ execPath: branded, appPath, hidden: true, exists: (p) => p === branded });
    expect(item.path).toBe(branded);
    expect(item.args).toEqual([appPath, HIDDEN_FLAG]);
  });
});

describe('isPackagedLayout', () => {
  it('is the app living inside the exe folder, not the exe being renamed', () => {
    expect(isPackagedLayout('C:\\Program Files\\Hangar\\Hangar.exe',
      'C:\\Program Files\\Hangar\\resources\\app.asar')).toBe(true);

    // A checkout: the exe is buried in node_modules, the folder sits above it.
    expect(isPackagedLayout(
      'C:\\Users\\you\\Projects\\Hangar\\node_modules\\electron\\dist\\Hangar.exe',
      'C:\\Users\\you\\Projects\\Hangar')).toBe(false);
  });
});

describe('startedHidden', () => {
  it('is only true for a launch that carries the flag', () => {
    expect(startedHidden(['electron.exe', '.', HIDDEN_FLAG])).toBe(true);
    expect(startedHidden(['electron.exe', '.'])).toBe(false);
  });
});
