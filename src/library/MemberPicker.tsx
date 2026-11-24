import type { LibraryItem } from '../shared/channels'

/** Choosing assets for a design system: everything but other design systems. */
export function MemberPicker({
  items,
  selected,
  onChange,
}: {
  items: LibraryItem[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <div className="member-picker">
      {items
        .filter((item) => item.asset.kind !== 'design-system')
        .map(({ asset }) => (
          <label key={asset.id}>
            <input
              type="checkbox"
              checked={selected.includes(asset.id)}
              onChange={(event) =>
                onChange(event.target.checked ? [...selected, asset.id] : selected.filter((id) => id !== asset.id))
              }
            />{' '}
            {asset.title} <code>{asset.name}</code> <span className="muted">{asset.kind}</span>
          </label>
        ))}
    </div>
  )
}
