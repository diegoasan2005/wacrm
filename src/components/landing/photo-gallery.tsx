'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

export type GalleryImage = {
  src: string;
  alt: string;
};

// Grid de fotos del estudio con lightbox propio (sin librerías): todas
// las imágenes viven en el DOM desde el HTML —a diferencia de un
// carrusel, Google las indexa todas— y el clic abre el visor a pantalla
// completa con navegación por teclado (Esc cierra, flechas navegan).
export default function PhotoGallery({ images }: { images: GalleryImage[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (openIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenIndex(null);
      if (event.key === 'ArrowRight')
        setOpenIndex((i) => (i === null ? null : (i + 1) % images.length));
      if (event.key === 'ArrowLeft')
        setOpenIndex((i) =>
          i === null ? null : (i - 1 + images.length) % images.length
        );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openIndex, images.length]);

  const move = (direction: 1 | -1) =>
    setOpenIndex((i) =>
      i === null ? null : (i + direction + images.length) % images.length
    );

  return (
    <>
      <div className="mt-12 grid grid-cols-2 gap-3 sm:auto-rows-[200px] sm:grid-cols-4">
        {images.map((image, index) => (
          <button
            key={image.src}
            type="button"
            onClick={() => setOpenIndex(index)}
            aria-label={`Ampliar foto: ${image.alt}`}
            className={`group relative overflow-hidden rounded-2xl border border-white/10 focus-visible:outline-2 focus-visible:outline-[#FC0178] ${
              index === 0
                ? 'col-span-2 aspect-[4/3] sm:row-span-2 sm:aspect-auto'
                : 'aspect-square sm:aspect-auto'
            }`}
          >
            <Image
              src={image.src}
              alt={image.alt}
              fill
              sizes={
                index === 0
                  ? '(max-width: 640px) 100vw, 50vw'
                  : '(max-width: 640px) 50vw, 25vw'
              }
              className="object-cover transition-transform duration-500 group-hover:scale-105"
            />
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Foto ampliada: ${images[openIndex].alt}`}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/95 p-4"
          onClick={() => setOpenIndex(null)}
        >
          <button
            type="button"
            onClick={() => setOpenIndex(null)}
            aria-label="Cerrar galería"
            className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full border border-white/25 text-xl text-white transition-colors hover:border-[#FC0178] hover:text-[#FC0178]"
          >
            ✕
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              move(-1);
            }}
            aria-label="Foto anterior"
            className="absolute left-2 flex size-11 items-center justify-center rounded-full border border-white/25 text-2xl text-white transition-colors hover:border-[#FC0178] hover:text-[#FC0178] sm:left-6"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              move(1);
            }}
            aria-label="Foto siguiente"
            className="absolute right-2 flex size-11 items-center justify-center rounded-full border border-white/25 text-2xl text-white transition-colors hover:border-[#FC0178] hover:text-[#FC0178] sm:right-6"
          >
            ›
          </button>

          <figure
            className="relative h-[78vh] w-full max-w-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <Image
              src={images[openIndex].src}
              alt={images[openIndex].alt}
              fill
              sizes="(max-width: 768px) 92vw, 768px"
              className="object-contain"
              priority
            />
          </figure>
          <p className="absolute bottom-3 left-1/2 w-full max-w-xl -translate-x-1/2 px-4 text-center text-xs text-white/70">
            {images[openIndex].alt}
          </p>
        </div>
      )}
    </>
  );
}
