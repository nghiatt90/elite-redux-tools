import { Link, useParams } from 'react-router'
import { useGameData } from '../lib/GameDataContext'

export default function PokedexDetail() {
  const { id } = useParams<{ id: string }>()
  const { speciesById } = useGameData()
  const species = id ? speciesById.get(id.toUpperCase()) : undefined

  if (!species) {
    return (
      <div className="p-4">
        <p>Unknown species: {id}</p>
        <Link className="underline" to="/">
          Back
        </Link>
      </div>
    )
  }

  return (
    <div className="p-4">
      <Link className="underline" to="/">
        Back
      </Link>
      <h1 className="text-xl font-semibold mt-2">{species.name}</h1>
      <p>{species.category}</p>
      <p>{species.types.join(' / ')}</p>
    </div>
  )
}
