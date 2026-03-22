import { describe, test, expect } from 'bun:test'
import { computeBackoff } from '../reconnect.js'

describe('computeBackoff', () => {
  test('starts at 1000ms', () => {
    expect(computeBackoff(0)).toBe(1000)
  })

  test('doubles each attempt', () => {
    expect(computeBackoff(1)).toBe(2000)
    expect(computeBackoff(2)).toBe(4000)
    expect(computeBackoff(3)).toBe(8000)
  })

  test('caps at 30000ms', () => {
    expect(computeBackoff(10)).toBe(30000)
    expect(computeBackoff(100)).toBe(30000)
  })

  test('follows sequence 1s, 2s, 4s, 8s, 16s, 30s', () => {
    expect(computeBackoff(0)).toBe(1000)
    expect(computeBackoff(1)).toBe(2000)
    expect(computeBackoff(2)).toBe(4000)
    expect(computeBackoff(3)).toBe(8000)
    expect(computeBackoff(4)).toBe(16000)
    expect(computeBackoff(5)).toBe(30000)
  })
})
