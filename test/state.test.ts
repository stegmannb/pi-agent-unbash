import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConfiguredEnabled,
  getDisabledCommandState,
  getEnabledCommandState,
  getReloadState,
  getSessionStartState,
  getToggledCommandState,
  hasSessionOverride,
} from '../src/state.ts';

test('unbash runtime state', async (t) => {
  await t.test('session start follows configured state when no user override is active', () => {
    assert.deepEqual(getSessionStartState(true, undefined, false), {
      unbashEnabled: true,
      userDisabled: false,
    });
    assert.deepEqual(getSessionStartState(true, false, false), {
      unbashEnabled: false,
      userDisabled: false,
    });
  });

  await t.test('disable command creates a sticky session override', () => {
    assert.deepEqual(getDisabledCommandState(), {
      unbashEnabled: false,
      userDisabled: true,
    });
  });

  await t.test('reload preserves a session disable override even when config is enabled', () => {
    const disabled = getDisabledCommandState();
    assert.deepEqual(getReloadState(disabled, true, undefined), disabled);
    assert.deepEqual(getReloadState(disabled, true, false), disabled);
  });

  await t.test('enable command clears the disable override and can override project disable', () => {
    assert.deepEqual(getEnabledCommandState(), {
      unbashEnabled: true,
      userDisabled: false,
    });
    assert.equal(getConfiguredEnabled(true, false), false);
    assert.equal(hasSessionOverride(true, true, false), true);
  });

  await t.test('toggle mirrors sandbox-style session semantics', () => {
    assert.deepEqual(getToggledCommandState(true), {
      unbashEnabled: false,
      userDisabled: true,
    });
    assert.deepEqual(getToggledCommandState(false), {
      unbashEnabled: true,
      userDisabled: false,
    });
  });
});
