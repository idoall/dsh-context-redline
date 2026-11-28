// The supervisor's routing table for classified model failures.
//
// A retry on the SAME route cannot fix a credential, configuration or upgrade
// problem, and it cannot fix a provider that rejects the request with a 4xx:
// those must be reported as the failure they are instead of burning quota and
// hiding the real cause behind a second attempt. Reachability problems (5xx,
// 408, 429, 404) stay switchable.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  failureAction,
  failureLabel,
  isDefinitiveFailure,
  isQuotaFailure,
  isSwitchableFailure,
} from '../../src/host/goal-supervisor/failure-policy'

describe('goal-supervisor failure policy', () => {
  test('an upgrade or configuration failure is definitive, never a retry', () => {
    // A client that must upgrade cannot be fixed by asking again, and neither
    // can a configuration the adapter has already rejected.
    assert.equal(isDefinitiveFailure('CLIENT_UPGRADE_REQUIRED'), true)
    assert.equal(isDefinitiveFailure('INVALID_CONFIG'), true)
    assert.equal(failureAction('INVALID_CONFIG', 'p', 'q'), 'report')
    assert.equal(failureAction('CLIENT_UPGRADE_REQUIRED', 'p', 'q'), 'report')
  })

  test('a non-retryable HTTP 4xx is definitive, while reachability statuses stay switchable', () => {
    for (const status of [400, 401, 403, 409, 422]) {
      assert.equal(isDefinitiveFailure(`HTTP_${status}`), true, `HTTP ${status}`)
      assert.equal(failureAction(`HTTP_${status}`, 'p', 'q'), 'report')
    }
    for (const status of [404, 408, 429]) {
      assert.equal(isSwitchableFailure(`HTTP_${status}`), true, `HTTP ${status}`)
      assert.equal(isDefinitiveFailure(`HTTP_${status}`), false, `HTTP ${status}`)
      assert.equal(failureAction(`HTTP_${status}`, 'p', 'q'), 'switch')
    }
    assert.equal(isDefinitiveFailure('HTTP_500'), false)
    assert.equal(isDefinitiveFailure('HTTP_503'), false)
    assert.equal(failureAction('HTTP_503', 'p', 'q'), 'switch')
  })

  test('quota exhaustion switches across providers only', () => {
    assert.equal(isQuotaFailure('QUOTA'), true)
    assert.equal(failureAction('QUOTA', 'p', 'q'), 'switch')
    assert.equal(failureAction('QUOTA', 'p', 'p'), 'report')
    assert.equal(failureAction('AUTH', 'p', 'q'), 'report')
  })

  test('unclassified failures are reported, never silently switched', () => {
    assert.equal(isDefinitiveFailure(undefined), false)
    assert.equal(isSwitchableFailure(undefined), false)
    assert.equal(failureAction(undefined, 'p', 'q'), 'report')
    assert.equal(failureLabel('HTTP_401'), '提供方 HTTP 错误（HTTP_401）')
  })
})
