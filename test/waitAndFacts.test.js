'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isWaitHold, isResume } = require('../src/utils/waitIntent');

describe('waitIntent', () => {
  it('detects simple wait', () => {
    assert.equal(isWaitHold('wait'), true);
    assert.equal(isWaitHold('Hold on'), true);
    assert.equal(isWaitHold('please wait'), true);
  });

  it('detects compound wait phrases', () => {
    assert.equal(isWaitHold('wait a second, please hold'), true);
    assert.equal(isWaitHold('hang on one moment please'), true);
    assert.equal(isWaitHold('give me a moment'), true);
  });

  it('does not treat project speech as wait', () => {
    assert.equal(isWaitHold('I need to build a healthcare app'), false);
    assert.equal(isWaitHold('What is your price for a project?'), false);
  });

  it('detects resume', () => {
    assert.equal(isResume('ok continue'), true);
    assert.equal(isResume("I'm back"), true);
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
