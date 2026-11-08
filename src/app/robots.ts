import type { MetadataRoute } from 'next';

// robots.txt público: la landing es la única sección indexable; el
// resto de la app es un CRM privado (además marca noindex vía
// metadata, aquí solo se evita gastar crawl budget).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://luzdy.beauty';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/dashboard/', '/login/', '/join/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
