import type { MetadataRoute } from 'next';

// Por ahora el sitio público es una sola página; cuando existan las
// páginas por servicio (/servicios/<slug>) se agregan aquí.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://luzdy.beauty';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 1,
    },
  ];
}
