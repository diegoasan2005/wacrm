# Plan de mejoras SEO — Página principal de Luzdy Jiménez

**Fecha:** 2026-10-18 (v2) · act. 2026-10-25 (v3: ciudad y dirección confirmadas; mapa de Google ya visible en la landing)
**Alcance:** Landing pública en `src/app/page.tsx` (ruta `/`) y sus archivos de soporte (`src/app/layout.tsx`, `next.config.ts`, `messages/*.json`, `public/`).
**Estado:** ⚠️ Propuesta. **No se ha aplicado ningún cambio al código.** Este documento espera tu aprobación.
**Datos confirmados:** dominio `https://luzdy.beauty` (`.env:51` → `NEXT_PUBLIC_SITE_URL`) · idioma `es` (`.env:56` → `NEXT_PUBLIC_APP_LOCALE`) · **dirección "Cl 1 # 12-18, Pereira, Risaralda" (2026-10-25)**.

---

## 1. Diagnóstico actual (lo que hay hoy)

La landing está bien construida visualmente y ya tiene bases correctas: título de página con la marca, meta description en español, texto alternativo en el logo, fotos reales de los 9 servicios y estructura de encabezados razonable (un solo `<h1>`, `<h2>` por sección, `<h3>` por servicio).

Sin embargo, **el sitio es hoy prácticamente invisible para Google**, por tres bloqueadores:

1. **`noindex, nofollow` global** — el layout raíz (`src/app/layout.tsx:36-39`) exporta `robots: { index: false, follow: false }`. La metadata de Next.js se fusiona por campos: como `page.tsx` no define su propio `robots`, la landing hereda el `noindex`. Google no puede indexar `/`.
2. **No existe `robots.txt` ni `sitemap.xml`** — no hay archivo estático en `public/` ni convención `src/app/robots.ts` / `src/app/sitemap.ts`.
3. **Sin URL canónica ni `metadataBase`** — no hay `alternates.canonical`, ni Open Graph ni Twitter Card. El dominio ya está definido en `.env` (`NEXT_PUBLIC_SITE_URL=https://luzdy.beauty`) pero la metadata aún no lo utiliza.

Problemas adicionales encontrados (detallados abajo): descripciones heredadas de la plantilla en `messages/*.json`, sin datos estructurados JSON-LD, sin ciudad/ubicación en ningún lado (SEO local inexistente), imágenes sin optimizar (logo de 279 KB cargado 3 veces) y una llamada de red a Supabase en cada visita anónima que retrasa la respuesta de la página. El idioma ya está bien configurado: `NEXT_PUBLIC_APP_LOCALE=es` hace que la landing se sirva con `<html lang="es">`.

---

## 2. Cambios propuestos, por prioridad

### 🔴 P0 — Bloqueadores críticos (sin estos, nada de lo demás funciona)

#### P0-1. Permitir la indexación de la landing (quitar el `noindex` heredado)

**Archivo:** `src/app/page.tsx` (bloque `export const metadata`, línea 338).

La estrategia actual (noindex global) es correcta para un CRM: `/dashboard`, `/inbox`, `/login`, etc. **no** deben indexarse. Lo que falta es la excepción para la única página pública. Como la fusión de metadata es por campos, basta con que la landing defina su propio objeto `robots` completo:

```ts
export const metadata = {
  title: {
    absolute: "Luzdy Jiménez | Especialista en Cejas y Belleza",
  },
  description: "…", // ver P1-2
  robots: {
    index: true,
    follow: true,
  },
  // … (canonical y OG se agregan en P0-3 y P1-3)
};
```

Así el resto del sitio conserva el `noindex` del layout raíz sin tocarlo. **Impacto:** desbloquea todo el SEO orgánico.

#### P0-2. Crear `src/app/robots.ts` y `src/app/sitemap.ts`

Hoy no existen. Añadir (convención oficial de Next 16, verificado en `node_modules/next/dist/docs/.../robots.md` y `sitemap.md`):

```ts
// src/app/robots.ts
import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://luzdy.beauty";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/login/", "/join/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

```ts
// src/app/sitemap.ts
import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://luzdy.beauty";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
```

Se lee de `NEXT_PUBLIC_SITE_URL` (ya definida en `.env:51`) con `https://luzdy.beauty` como respaldo, para que funcione igual en local y en producción.

#### P0-3. URL canónica + `metadataBase`

**Archivo:** `src/app/layout.tsx` (`const metadata`).

Sin `metadataBase`, Next no puede construir URLs absolutas para canonical/OG. Añadir al metadata del layout raíz (reutiliza la variable ya presente en `.env`):

```ts
metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://luzdy.beauty"),
```

Y en `src/app/page.tsx`:

```ts
alternates: { canonical: "/" },
```

Evita contenido duplicado por `www`/sin-`www` o `http`/`https`.

---

### 🟠 P1 — Alta prioridad (aparecer bien en resultados y compartidos)

#### P1-1. Idioma verificado ✅ + corregir la descripción de `messages/*.json`

El idioma ya está bien: `NEXT_PUBLIC_APP_LOCALE=es` (`.env:56`) hace que `src/i18n/request.ts` sirva la landing con `<html lang="es">` y los mensajes en español. No hay que tocar nada ahí (opcionalmente, cambiar el respaldo por defecto `'en'` → `'es'` en `request.ts` para que un despliegue sin la variable siga saliendo en español).

Lo que sí sobra es la descripción heredada de la plantilla: `messages/es.json` → `Metadata.description` dice literalmente `"Luzdy CRM"` (y `en.json` dice `"Self-hostable CRM template for WhatsApp."`, usado solo como respaldo si faltara el locale, pero conviene alinearla).

**Texto aprobado para es.json:**

> "Cejas perfectas, uñas impecables y piel radiante con Luzdy Jiménez. Depilación con hilo, micropigmentación, lifting de pestañas y más."

#### P1-2. Mejorar la meta description de la landing

La actual (`src/app/page.tsx:342-343`) está bien pero es genérica. Propuesta (incluye palabra clave + servicio + llamada a la acción, ≤160 caracteres):

> "Depilación de cejas con hilo, micropigmentación, manicure, lifting de pestañas y limpieza facial con Luzdy Jiménez. Agenda tu cita por WhatsApp hoy."

(Opcional, si me confirmas la ciudad: añadir «en {Ciudad}» — refuerza el SEO local.)

#### P1-3. Open Graph y Twitter Card

No existen. Al compartir por WhatsApp/Instagram/Facebook hoy no se muestra vista previa con imagen. Añadir al `metadata` de `page.tsx`:

```ts
openGraph: {
  title: "Luzdy Jiménez | Especialista en Cejas y Belleza",
  description: "…la de P1-2…",
  url: "/",
  siteName: "Luzdy Jiménez",
  locale: "es_CO",
  type: "website",
  images: [{ url: "/og-luzdy.jpg", width: 1200, height: 630, alt: "Luzdy Jiménez — Especialista en Cejas y Belleza" }],
},
twitter: {
  card: "summary_large_image",
  title: "Luzdy Jiménez | Especialista en Cejas y Belleza",
  description: "…",
  images: ["/og-luzdy.jpg"],
},
```

**Requiere crear** `public/og-luzdy.jpg` (1200×630): composición con el logo, el rosa de marca `#FC0178` y el texto "Especialista en Cejas y Belleza".

#### P1-4. Datos estructurados JSON-LD (el mayor salto para negocio local)

Google no sabe que esto es un negocio de belleza. Añadir en el servidor de `src/app/page.tsx` un `<script type="application/ld+json">` con schema `BeautySalon`:

```json
{
  "@context": "https://schema.org",
  "@type": "BeautySalon",
  "name": "Luzdy Jiménez",
  "description": "Especialista en cejas y belleza: depilación con hilo, micropigmentación, manicure, lifting de pestañas y limpieza facial.",
  "url": "https://luzdy.beauty/",
  "image": "https://luzdy.beauty/luzdy-logo.png",
  "telephone": "+573116219282",
  "priceRange": "$$",
  "sameAs": ["https://instagram.com/luzdy_jimenez"],
  "address": { "@type": "PostalAddress", "addressLocality": "CIUDAD", "addressCountry": "CO" },
  "openingHoursSpecification": [{ "@type": "OpeningHoursSpecification", "dayOfWeek": [], "opens": "", "closes": "" }],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Servicios de belleza",
    "itemListElement": [ { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Depilación de Cejas con Hilo" } } ]
  }
}
```

(con los 9 servicios en `hasOfferCatalog`; dirección/horarios como placeholders hasta que me los confirmes). Esto habilita el panel enriched en Google ("negocio de belleza cerca de mí"), estrellas y elegibilidad para resultados locales.

---

### 🟡 P2 — Contenido on-page

| # | Cambio | Detalle |
|---|--------|---------|
| P2-1 | **H1 con marca y palabra clave** | Hoy el `<h1>` es "Realza tu belleza natural" (`page.tsx:158-163`). Proponer: **"Realza tu belleza natural con Luzdy Jiménez"** — mantiene el diseño y añade la marca al elemento más importante para SEO. |
| P2-2 | **Ciudad y ubicación visibles** | ✅ Parcial (2026-10-25): sección "Ubicación" con mapa y dirección ya en la landing. Falta: ciudad en el subtítulo del hero, en el footer y en los metadatos (description, JSON-LD). |
| P2-3 | **NAP consistente** (Nombre, Dirección, Teléfono) | Añadir teléfono visible como enlace `tel:+573116219282` junto al QR de WhatsApp. |
| P2-4 | **Sección de preguntas frecuentes** | 4–6 preguntas reales ("¿Cuánto dura la micropigmentación de cejas?", "¿Qué cuidado necesita el laminado?", "¿Cómo agendo mi cita?") con schema `FAQPage`. Captura búsquedas de cola larga y ocupa más espacio en la página de resultados. |
| P2-5 | **Textos alternativos más descriptivos** | Los `alt` de las fotos de servicios son solo el nombre (`page.tsx:219`). Proponer: `alt="Depilación de cejas con hilo — Luzdy Jiménez"`, etc. Ayuda a Google Imágenes. |
| P2-6 | **H2 con palabra clave** | "Belleza de pies a cabeza" es bonito pero genérico. Alternativa: "Nuestros servicios de belleza y estética". |

---

### 🟢 P3 — Rendimiento (Core Web Vitals, factor de ranking)

| # | Cambio | Detalle |
|---|--------|---------|
| P3-1 | **Migrar los `<img>` a `next/image`** | Hoy son `<img>` crudos con eslint deshabilitado. `next/image` sirve WebP/AVIF, `srcset` responsive y lazy-loading automático. El logo (`public/luzdy-logo.png`, **279 KB**) se carga 3 veces por página; con `next/image` bajaría a ~20–40 KB por carga. `priority` solo para el del hero; el resto `lazy`. |
| P3-2 | **`width`/`height` explícitos en imágenes** | Ningún `<img>` los declara. Añadirlos (o dejar que `next/image` los exija) elimina el riesgo de cambios de diseño (CLS). |
| P3-3 | **Eliminar la llamada a Supabase en visitas anónimas** | `page.tsx:102-111` llama `supabase.auth.getUser()` (ida y vuelta a Supabase) en **cada** visita pública, solo para cambiar "Iniciar sesión" por "Ingresar". Pero `/login` ya redirige a autenticados a `/dashboard` (el propio comentario del archivo lo dice): la distinción es cosmética y cuesta TTFB. Proponer: quitar la llamada o degradarla a una comprobación local de cookie. Además el middleware (`src/middleware.ts`) también llama a `getUser()` en `/` — se puede excluir la ruta pública del matcher. |
| P3-4 | **Favicon más ligero** | `src/app/icon.ico` pesa **124 KB**. Generar un .ico de 32×32 + `apple-touch-icon.png` de 180×180 (unos pocos KB). |
| P3-5 | **Caché del HTML de `/`** | `next.config.ts` manda `Cache-Control: private, no-store` a **todo** el HTML, incluida la landing. Fue una decisión deliberada por el CDN de Hostinger (documentada en el propio archivo) — proponer con cuidado: excluir `/` con una cabecera conservadora tipo `public, max-age=0, s-maxage=300, stale-while-revalidate=60` y vigilar el comportamiento del CDN. Requiere tu visto bueno por el historial de problemas con Hostinger. |
| P3-6 | **Foto real en el hero** (opcional) | El hero usa solo el logo. Una foto real de trabajo/estudio aumenta la tasa de clics desde resultados y la permanencia. |

---

### 🔵 P4 — Mediano plazo (fuera del alcance inmediato, para roadmap)

1. **Páginas individuales por servicio** (`/servicios/depilacion-cejas`, `/servicios/micropigmentacion-labios`, …) con contenido propio (descripción, duración, cuidados, fotos, precios). Es el mayor salto SEO estructural: 9 páginas indexables para 9 búsquedas distintas ("micropigmentación de cejas precio", "lifting de pestañas cerca de mí"…).
2. **Google Business Profile** (si no existe ya): es el canal nº 1 para negocios locales de belleza. Enlazar la web, mantener NAP idéntico al sitio, pedir reseñas.
3. **Google Search Console + Bing Webmaster**: verificar el dominio y enviar el sitemap **inmediatamente después** de aplicar P0. Sin esto no se medirá nada.
4. **Sección de reseñas/clientes** en la landing (con `AggregateRating` cuando haya reseñas verificables).
5. **Blog o contenido estacional** ("cuidados tras un laminado de cejas") para atraer tráfico informativo.

---

## 3. Resumen priorizado

| Prioridad | Cambio | Archivo(s) | Impacto SEO |
|-----------|--------|------------|-------------|
| 🔴 P0-1 | `robots: index,follow` en la landing | `src/app/page.tsx` | **Crítico** — hoy Google no puede indexar |
| 🔴 P0-2 | Crear `robots.ts` + `sitemap.ts` | `src/app/` (nuevos) | Crítico |
| 🔴 P0-3 | `metadataBase` + canonical | `layout.tsx`, `page.tsx` | Crítico |
| 🟠 P1-1 | Arreglar description de `messages/*.json` (idioma ya verificado ✅) | `messages/*.json` | Alto |
| 🟠 P1-2 | Meta description mejorada | `page.tsx` | Alto |
| 🟠 P1-3 | Open Graph + Twitter Card + imagen OG | `page.tsx`, `public/` | Alto |
| 🟠 P1-4 | JSON-LD `BeautySalon` (+FAQ) | `page.tsx` | Alto |
| 🟡 P2 | H1 con marca, ciudad, NAP, FAQ, alt texts | `page.tsx` | Medio-alto |
| 🟢 P3 | `next/image`, quitar llamada Supabase, favicon, caché | `page.tsx`, `layout.tsx`, `next.config.ts`, `middleware.ts` | Medio (CWV) |
| 🔵 P4 | Páginas por servicio, GBP, Search Console | roadmap | Alto a plazo |

---

## 4. Información pendiente que necesito de ti

1. ✅ **Ciudad y zona de servicio** — confirmado 2026-10-25: **Pereira, Risaralda**; dirección física del estudio: **Cl 1 # 12-18**. Ya aplicado fuera del plan: sección "Ubicación" con mapa embebido de Google Maps y botón "Cómo llegar" en la landing (`src/app/page.tsx`). Con esto, P1-4 puede usar `streetAddress: "Calle 1 # 12-18"`, `addressLocality: "Pereira"`, `addressRegion: "Risaralda"` y P2-2 queda parcialmente cubierto.
2. **Horarios de atención** (P1-4).
3. ¿Ya existe **Google Business Profile** de Luzdy Jiménez? (P4).
4. Aprobación específica del cambio de **caché para `/`** (P3-5), por el historial con el CDN de Hostinger.

✅ Ya confirmado: dominio `https://luzdy.beauty` (`NEXT_PUBLIC_SITE_URL`, `.env:51`) · idioma `es` (`NEXT_PUBLIC_APP_LOCALE`, `.env:56`) · texto de la description de es.json (P1-1) · ciudad Pereira (Risaralda) y dirección Cl 1 # 12-18 (2026-10-25).

---

*Aprobando este plan, aplicaré los cambios en el orden P0 → P1 → P2 → P3, actualizando `CHANGELOG.md` según CONTRIBUTING.md.*
