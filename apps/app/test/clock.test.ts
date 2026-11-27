import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { showClock, stepClock } from '../src/clock.ts'

describe('stepping a quiet hours clock time', () => {
  it('moves by 30 minutes within a day', () => {
    assert.equal(stepClock('22:00', 30), '22:30')
    assert.equal(stepClock('07:30', -30), '07:00')
  })

  it('wraps past midnight both ways', () => {
    assert.equal(stepClock('23:30', 30), '00:00')
    assert.equal(stepClock('00:00', -30), '23:30')
  })

  it('keeps an odd minute the server sent, stepping from it', () => {
    assert.equal(stepClock('06:45', 30), '07:15')
  })

  it('leaves a value that is not HH:MM as it is', () => {
    assert.equal(stepClock('7:00', 30), '7:00')
  })
})

describe('showing a quiet hours clock time', () => {
  it('keeps the 24-hour time when the phone uses a 24-hour clock', () => {
    assert.equal(showClock('22:00', true), '22:00')
    assert.equal(showClock('07:30', true), '07:30')
  })

  it('shows a 12-hour time with AM or PM when the phone uses a 12-hour clock', () => {
    assert.equal(showClock('22:00', false), '10:00 PM')
    assert.equal(showClock('07:30', false), '7:30 AM')
  })

  it('shows midnight and noon as 12 on a 12-hour clock', () => {
    assert.equal(showClock('00:00', false), '12:00 AM')
    assert.equal(showClock('00:30', false), '12:30 AM')
    assert.equal(showClock('12:00', false), '12:00 PM')
  })

  it('uses a 12-hour clock when the phone does not say', () => {
    assert.equal(showClock('13:00', null), '1:00 PM')
  })

  it('leaves a value that is not HH:MM as it is', () => {
    assert.equal(showClock('7:00', false), '7:00')
  })
})
