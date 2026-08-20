import assert from 'node:assert/strict';
import test from 'node:test';
import { isPartslinkSessionContinuationLabel } from './partslinkSession';

test('recognizes explicit Partslink single-session continuation actions', () => {
  const accepted = [
    'In dieser Sitzung fortfahren',
    'In dieser Session fortfahren',
    'Bestehende Sitzung übernehmen',
    'Session fortsetzen',
    'Continue in this session',
    'Resume the current session',
  ];

  for (const label of accepted) {
    assert.equal(isPartslinkSessionContinuationLabel(label), true, label);
  }
});

test('does not mistake generic login/navigation actions for session takeover', () => {
  const rejected = ['Weiter', 'Login', 'Anmelden', 'Fortfahren', 'Abbrechen'];

  for (const label of rejected) {
    assert.equal(isPartslinkSessionContinuationLabel(label), false, label);
  }
});
