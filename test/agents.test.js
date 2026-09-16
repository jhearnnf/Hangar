import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Agents = require('../agents.js');

describe('get', () => {
  it('answers with the agent asked for', () => {
    expect(Agents.get('codex').command).toBe('codex');
    expect(Agents.get('claude').command).toBe('claude');
  });

  it('falls back rather than returning nothing, since callers are drawing a sidebar', () => {
    // A hand-edited config, or one written by a later release that knows an
    // agent this one does not. Neither is worth a blank window over.
    expect(Agents.get('gpt-9').id).toBe(Agents.DEFAULT);
    expect(Agents.get(undefined).id).toBe(Agents.DEFAULT);
    expect(Agents.get(null).id).toBe(Agents.DEFAULT);
  });

  it('defaults to claude, which is what this machine was already running', () => {
    expect(Agents.DEFAULT).toBe('claude');
  });
});

describe('isAgentId', () => {
  it('accepts only the ids there is a row for', () => {
    expect(Agents.isAgentId('claude')).toBe(true);
    expect(Agents.isAgentId('codex')).toBe(true);
    expect(Agents.isAgentId('cursor')).toBe(false);
    expect(Agents.isAgentId('')).toBe(false);
    expect(Agents.isAgentId(null)).toBe(false);
  });

  it('is not fooled by what every object inherits', () => {
    // `agent: "constructor"` in a config file would otherwise be a valid id.
    expect(Agents.isAgentId('constructor')).toBe(false);
    expect(Agents.isAgentId('toString')).toBe(false);
  });
});

describe('processNames', () => {
  it('covers every agent at once, not only the chosen one', () => {
    // Switching agents leaves the terminals already running the other one
    // alone, and the process view has to keep stepping over both.
    const names = Agents.processNames();
    expect(names).toContain('claude');
    expect(names).toContain('codex');
  });

  it('is lower-cased, which is how the sampler rows are compared', () => {
    expect(Agents.processNames().every((name) => name === name.toLowerCase())).toBe(true);
  });
});

describe('the table itself', () => {
  it('gives every agent everything the app reads off it', () => {
    for (const id of Agents.IDS) {
      const agent = Agents.get(id);
      expect(agent.id).toBe(id);
      expect(typeof agent.name).toBe('string');
      expect(typeof agent.label).toBe('string');
      expect(typeof agent.command).toBe('string');
      expect(typeof agent.ownPicker).toBe('string');
      expect(typeof agent.usage).toBe('boolean');
      expect(agent.processNames.length).toBeGreaterThan(0);
      expect(typeof agent.resume('id')).toBe('string');
    }
  });

  it('supports provider-specific usage bars for both agents', () => {
    expect(Agents.get('claude').usage).toBe(true);
    expect(Agents.get('codex').usage).toBe(true);
  });
});
