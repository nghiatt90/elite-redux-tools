import { Link } from 'react-router'
import { useGameData } from '../lib/GameDataContext'

export default function PokedexList() {
  const { species } = useGameData()
  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-2">Pokedex ({species.length})</h1>
      <ul>
        {species.slice(0, 20).map((s) => (
          <li key={s.id}>
            <Link className="underline" to={`/pokemon/${s.id}`}>
              {s.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
