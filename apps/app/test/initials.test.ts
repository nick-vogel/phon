import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initials } from '../src/ui/initials.ts'

describe("a person's initials", () => {
  it('takes the first letter of the first and the last word', () => {
    assert.equal(initials('Ben Ito'), 'BI')
    assert.equal(initials('Mary Ann de la Cruz'), 'MC')
    assert.equal(initials('Former member'), 'FM')
  })

  it('gives one letter for a one-word name', () => {
    assert.equal(initials('Cher'), 'C')
  })

  it('gives nothing for an empty or blank name', () => {
    assert.equal(initials(''), '')
    assert.equal(initials('  '), '')
  })

  it('upper-cases accented letters', () => {
    assert.equal(initials('émile zola'), 'ÉZ')
  })

  it('keeps a letter outside the Basic Multilingual Plane whole', () => {
    assert.equal(initials('𝒜da Lovelace'), '𝒜L')
  })
})
