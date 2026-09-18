'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isWaitHold, isResume } = require('../src/utils/waitIntent');
const {
  matchQuickFact,
  isProjectInquiry,
} = require('../src/services/companyQuickFacts');

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

describe('companyQuickFacts', () => {
  it('matches CEO / CTO / Jaipur / what we do', () => {
    const ceo = matchQuickFact('Who is the CEO?');
    assert.equal(ceo.id, 'ceo');
    assert.match(ceo.answer, /Rahul Sukhwal/);
    assert.match(ceo.answer, /18 years/);
    const cto = matchQuickFact('Who is the CTO of JPLoft?');
    assert.equal(cto.id, 'cto');
    assert.match(cto.answer, /Yashwant Sharma/);
    assert.match(cto.answer, /14 years/);
    assert.equal(matchQuickFact('Where is your Jaipur office?').id, 'jaipur');
    assert.equal(matchQuickFact('What does JPLoft do?').id, 'whatWeDo');
    assert.equal(matchQuickFact('Where is JPLoft headquartered?').id, 'hq');
  });

  it('does not match project inquiries', () => {
    assert.equal(
      matchQuickFact(
        'I need an AI healthcare platform and want to know whether JPLoft can build it'
      ),
      null
    );
    assert.equal(isProjectInquiry('I need an AI healthcare platform'), true);
  });
});
