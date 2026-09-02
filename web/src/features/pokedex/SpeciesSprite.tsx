import { useState } from 'react'
import { spriteUrl } from '../../lib/data'

export default function SpeciesSprite({ speciesId }: { speciesId: string }) {
  const [shiny, setShiny] = useState(false)

  return (
    <div className="flex flex-col items-center gap-2">
      <img
        src={spriteUrl(speciesId, shiny ? 'front-shiny' : 'front')}
        alt=""
        width={64}
        height={64}
        className="pixelated"
        style={{ width: 128, height: 128, imageRendering: 'pixelated' }}
      />
      <button
        type="button"
        onClick={() => setShiny((v) => !v)}
        className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
        style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
        aria-pressed={shiny}
      >
        <span aria-hidden>✨</span>
        {shiny ? 'Shiny' : 'Normal'}
      </button>
    </div>
  )
}
