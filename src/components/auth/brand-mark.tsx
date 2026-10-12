// Brand mark — the Luzdy Jiménez icon (icono.ico) used on auth
// screens and anywhere the old chat glyph appeared as a brand mark.
export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icono.ico" alt="Luzdy CRM" className={className} />
  );
}
