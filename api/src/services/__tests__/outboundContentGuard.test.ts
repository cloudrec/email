import { describe, it, expect } from 'vitest';
import {
  contentBlockers,
  hasUnresolvedMacros,
  hasReplacePlaceholder,
  hasBrokenGrammar,
} from '../outboundContentGuard.js';

describe('outboundContentGuard.contentBlockers', () => {
  it('passes a clean, fully-rendered draft', () => {
    expect(contentBlockers('Quick question about Acme', 'Hi Anna, I run a cleaning service in Leeds. Reply STOP to opt out.')).toEqual([]);
  });

  it('blocks empty subject and body', () => {
    expect(contentBlockers('', '')).toEqual(expect.arrayContaining(['missing_subject', 'missing_body']));
    expect(contentBlockers('   ', 'body here')).toContain('missing_subject');
    expect(contentBlockers('subject', '   ')).toContain('missing_body');
  });

  it('blocks leftover {{macros}} in subject or body', () => {
    expect(contentBlockers('Hi {{company}}', 'body')).toContain('unresolved_macro');
    expect(contentBlockers('subject', 'We help {{city}} businesses')).toContain('unresolved_macro');
  });

  it('blocks leftover spintax {a|b}', () => {
    expect(contentBlockers('subject', 'Hello {there|hi} friend')).toContain('unresolved_macro');
  });

  it('blocks <<<REPLACE>>> operator-fill fields', () => {
    expect(contentBlockers('subject', 'Best, <<< REPLACE: your name >>>')).toContain('unfilled_replace_field');
    expect(contentBlockers('<<<REPLACE company>>>', 'body')).toContain('unfilled_replace_field');
  });

  it('blocks the known broken "the your business" grammar', () => {
    expect(contentBlockers('subject', 'I can help the your business grow')).toContain('broken_grammar');
  });

  it('unit predicates behave', () => {
    expect(hasUnresolvedMacros('{{x}}')).toBe(true);
    expect(hasUnresolvedMacros('clean text')).toBe(false);
    expect(hasReplacePlaceholder('<<< REPLACE x >>>')).toBe(true);
    expect(hasReplacePlaceholder('no markers')).toBe(false);
    expect(hasBrokenGrammar('the your service')).toBe(true);
    expect(hasBrokenGrammar('your service')).toBe(false);
  });
});
