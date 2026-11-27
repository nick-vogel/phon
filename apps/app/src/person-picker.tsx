import type { Person } from '@phon/api-types'
import { ListRow } from './ui/list-row'

/**
 * Picks people from the church's list, for a private channel's members. It shows everyone the
 * server listed, in the server's order, as one inset group of checkbox rows, and a picked row
 * draws the check mark, so the state shows by shape, not by colour alone. The server decides
 * whether the set is allowed.
 */
export function PersonPicker({
  people,
  picked,
  onChange,
}: {
  people: readonly Person[]
  picked: ReadonlySet<string>
  onChange: (picked: Set<string>) => void
}) {
  const toggle = (personId: string) => {
    const next = new Set(picked)
    if (next.has(personId)) next.delete(personId)
    else next.add(personId)
    onChange(next)
  }

  return (
    <>
      {people.map((person, index) => (
        <ListRow
          key={person.personId}
          title={person.name}
          checked={picked.has(person.personId)}
          choice="checkbox"
          onPress={() => toggle(person.personId)}
          first={index === 0}
          last={index === people.length - 1}
        />
      ))}
    </>
  )
}
