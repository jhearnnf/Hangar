import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { localAppUrl } = createRequire(import.meta.url)('../renderer/local-app-url');

it('accepts local HTTP addresses and supplies the missing protocol', () => {
  expect(localAppUrl(' localhost:3000/app?q=1 ')).toBe('http://localhost:3000/app?q=1');
  expect(localAppUrl('https://app.localhost:443')).toBe('https://app.localhost/');
  expect(localAppUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
  expect(localAppUrl('[::1]:8080')).toBe('http://[::1]:8080/');
});

it('rejects external hosts, credentials, invalid ports and non-web schemes', () => {
  for (const value of ['', 'https://example.com', '127.evil.com', 'localhost.evil.com', 'http://user@localhost', 'localhost:99999', 'file:///tmp/app', 'javascript:alert(1)']) {
    expect(localAppUrl(value)).toBe('');
  }
});
