import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AVATAR_SIZE, avatarFace, initialsFontSize } from '../src/ui/avatar-face.ts'

const photo = 'https://avatars.planningcenteronline.com/uploads/person/1/ben.jpg'

describe('what an avatar shows', () => {
  it("shows the person's photo when there is one", () => {
    assert.deepEqual(avatarFace('Ben Ito', photo, null), { kind: 'photo', uri: photo })
  })

  it('shows initials when there is no photo, as for a minor or a person with none uploaded', () => {
    const initials = { kind: 'initials', text: 'BI' }
    assert.deepEqual(avatarFace('Ben Ito', null, null), initials)
    assert.deepEqual(avatarFace('Ben Ito', undefined, null), initials)
    assert.deepEqual(avatarFace('Ben Ito', '', null), initials)
  })

  it('shows initials once the photo fails to load', () => {
    assert.deepEqual(avatarFace('Ben Ito', photo, photo), { kind: 'initials', text: 'BI' })
  })

  it('tries a new photo again after an earlier one failed', () => {
    const synced = 'https://avatars.planningcenteronline.com/uploads/person/1/ben-2.jpg'
    assert.deepEqual(avatarFace('Ben Ito', synced, photo), { kind: 'photo', uri: synced })
  })
})

describe("the size of an avatar's initials", () => {
  it("keeps the theme's caption size at the chat's avatar size and below", () => {
    assert.equal(AVATAR_SIZE, 28)
    assert.equal(initialsFontSize(28, 12), 12)
    assert.equal(initialsFontSize(20, 12), 12)
  })

  it('grows with a larger circle, so the Settings header does not hold tiny letters', () => {
    assert.equal(initialsFontSize(56, 12), 24)
    assert.equal(initialsFontSize(64, 14), 32)
  })
})
