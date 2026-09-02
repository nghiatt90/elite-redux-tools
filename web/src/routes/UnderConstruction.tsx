export default function UnderConstruction({ title }: { title: string }) {
  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Under construction.
        </p>
      </div>
    </div>
  )
}
