export default function IndustryPlaceholder({ industry }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
      <p className="text-xs tracking-[0.3em] text-slate-500 uppercase">{industry}</p>
      <p className="text-2xl font-light text-slate-300">
        Vista no disponible para esta industria
      </p>
      <p className="text-sm text-slate-500 max-w-md">
        Esta pantalla está cableada solo para el demo bancario.
      </p>
    </div>
  )
}
