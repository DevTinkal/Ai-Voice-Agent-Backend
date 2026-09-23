'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isWaitHold, isResume, isHoldNoiseFragment, isIncompleteWaitPrefix } = require('../src/utils/waitIntent');

describe('waitIntent', () => {
  it('detects all supported short WAIT phrases', () => {
    const phrases = [
      'wait',
      'wait wait',
      'wait a second',
      'wait a minute',
      'please wait',
      'hold on',
      'hold on a second',
      'hang on',
      'one moment',
      'just a moment',
      'give me a second',
      'give me a moment',
      'give me a minute',
      'let me think',
      'Wait.',
      'HOLD ON',
    ];
    for (const p of phrases) {
      assert.equal(isWaitHold(p), true, `expected WAIT for: ${p}`);
    }
  });

  it('rejects noise fragments and short non-wait speech', () => {
    for (const p of ['yo', 'le', 'de', 'uh', 'hmm', 'random noise']) {
      assert.equal(isWaitHold(p), false, `expected not WAIT for: ${p}`);
      if (['yo', 'le', 'de', 'uh', 'hmm'].includes(p)) {
        assert.equal(isHoldNoiseFragment(p), true, `expected noise fragment: ${p}`);
      }
    }
  });

  it('marks incomplete WAIT prefixes without treating them as hold', () => {
    for (const p of ['w', 'wa', 'wai', 'ho', 'hol', 'hold o', 'give me', 'please w']) {
      assert.equal(isWaitHold(p), false, `must not WAIT yet: ${p}`);
      assert.equal(isIncompleteWaitPrefix(p), true, `expected prefix: ${p}`);
    }
    // Bare "hold"/"wait" are complete holds (repeat-token pattern), not prefixes.
    assert.equal(isWaitHold('hold'), true);
    assert.equal(isIncompleteWaitPrefix('hold'), false);
    assert.equal(isIncompleteWaitPrefix('wait'), false);
    assert.equal(isIncompleteWaitPrefix('de'), false);
    assert.equal(isIncompleteWaitPrefix('What is the franchise fee'), false);
  });

  it('does not treat long questions containing wait as pure WAIT', () => {
    assert.equal(
      isWaitHold('Wait, what are the franchise requirements?'),
      false
    );
    assert.equal(isWaitHold('I need to build a healthcare app'), false);
    assert.equal(isWaitHold('What is your price for a project?'), false);
    assert.equal(
      isWaitHold('Please wait until I finish explaining the franchise cost'),
      false
    );
  });

  it('detects resume', () => {
    assert.equal(isResume('ok continue'), true);
    assert.equal(isResume("I'm back"), true);
    assert.equal(isResume('continue'), true);
  });
});

describe('no hardcoded company prompt modules', () => {
  it('agent.config and companyQuickFacts are removed', () => {
    assert.equal(
      fs.existsSync(
        path.join(__dirname, '../src/agent/agent.config.js')
      ),
      false
    );
    assert.equal(
      fs.existsSync(
        path.join(__dirname, '../src/services/companyQuickFacts.js')
      ),
      false
    );
    assert.equal(
      fs.existsSync(path.join(__dirname, '../src/prompts')),
      false
    );
    assert.equal(
      fs.existsSync(
        path.join(__dirname, '../src/services/knowledgeBootstrap.js')
      ),
      false
    );
  });
});
