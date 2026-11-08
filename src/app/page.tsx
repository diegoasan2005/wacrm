import fs from 'node:fs';
import path from 'node:path';
import Image from 'next/image';
import Link from 'next/link';
import { Clock, LogIn, MapPin, Phone } from 'lucide-react';

import PhotoGallery, {
  type GalleryImage,
} from '@/components/landing/photo-gallery';

// ============================================================
// Landing pública — lo primero que ve cualquier visitante.
//
// No requiere sesión: presenta los servicios de Luzdy Jiménez y el
// botón de inicio de sesión lleva a /login (los usuarios ya
// autenticados que entren a /login son llevados a /dashboard por el
// middleware, así que el mismo botón sirve para ambos). No se
// consulta la sesión aquí: era una llamada a Supabase por visita
// anónima solo para cambiar la etiqueta del botón, y /login ya
// redirige a los autenticados.
//
// Sample images: drop real photos into `public/services/<slug>.jpg`
// and they replace the gradient placeholders automatically (checked
// at build time).
// ============================================================

const BRAND = '#FC0178';

const ADDRESS = 'Cl 1 # 12-18, Pereira, Risaralda';
const ADDRESS_QUERY = encodeURIComponent(ADDRESS);
// URL final del embed oficial de Google Maps ("Compartir → Insertar un mapa")
// para la dirección. Se usa la URL definitiva (/maps/embed?pb=...) porque la
// variante corta google.com/maps?...&output=embed responde con pantalla gris
// cuando se carga directamente como iframe (la redirección 301 solo funciona
// en navegación de pestaña).
const MAPS_EMBED_URL =
  'https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1sCl+1+%23+12-18,+Pereira,+Risaralda!6i16!3m1!1ses!5m1!1ses';
const MAPS_DIRECTIONS_URL = `https://www.google.com/maps/dir/?api=1&destination=${ADDRESS_QUERY}`;

const PHONE_TEL = '+573116219282';
const PHONE_DISPLAY = '311 621 9282';
const HOURS = 'Lunes a sábado, 9:00 a. m. – 6:00 p. m.';
const HOURS_CLOSED = 'Domingos y festivos cerrado';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://luzdy.beauty';

const PAGE_DESCRIPTION =
  'Depilación de cejas con hilo, micropigmentación, manicure, lifting de pestañas y limpieza facial con Luzdy Jiménez en Pereira. Agenda tu cita por WhatsApp.';

// Fotos reales del estudio y del trabajo de Luzdy. La primera ocupa la
// celda grande del collage; para añadir más basta con drop un archivo
// en public/ y sumarlo aquí.
const GALLERY: GalleryImage[] = [
  {
    src: '/local/fachada-noche.jpg',
    alt: 'Fachada del estudio de Luzdy Jiménez en Pereira al caer la noche',
  },
  {
    src: '/local/fachada-vinilos.jpg',
    alt: 'Puertas del estudio de Luzdy Jiménez en Pereira con servicios y horario de atención',
  },
  {
    src: '/luzdy/luzdy-estudio.jpg',
    alt: 'Luzdy Jiménez en la sala de su estudio de belleza en Pereira',
  },
  {
    src: '/luzdy/luzdy-instrumentos.jpg',
    alt: 'Luzdy Jiménez prepara los instrumentos para el lifting de pestañas',
  },
  {
    src: '/luzdy/luzdy-guantes.jpg',
    alt: 'Luzdy Jiménez se coloca los guantes antes de iniciar un procedimiento',
  },
];

const SPECIALIST = {
  src: '/luzdy/luzdy-especialista.jpg',
  alt: 'Luzdy Jiménez, especialista en cejas y belleza, en su estudio de Pereira',
  name: 'Luzdy Jiménez',
  role: 'Especialista en Cejas y Belleza',
  bio: 'Creó en Pereira un espacio de belleza pensado para cada una de las clientas que lo visitan: atención personal en cada cita y técnicas de depilación con hilo, laminado y revitalización de cejas, lifting de pestañas, micropigmentación de cejas y labios, hidralips y limpieza facial. Su objetivo: resaltar lo mejor de cada una.',
};

const SERVICES = [
  {
    slug: 'depilacion-cejas',
    name: 'Depilación de Cejas con Hilo',
    description:
      'Definición y limpieza perfecta con la técnica del hilo: precisión, menos irritación y una forma que resalta tu mirada.',
    emoji: '👁️',
  },
  {
    slug: 'manicure-pedicure',
    name: 'Manicure y Pedicure',
    description:
      'Todas las técnicas y con diseños personalizados para unas manos y pies impecables.',
    emoji: '💅',
  },
  {
    slug: 'micropigmentacion-cejas',
    name: 'Micropigmentación de Cejas',
    description:
      'Cejas perfectas 24/7 con acabado natural pelo a pelo, diseñadas según tu rostro.',
    emoji: '✨',
  },
  {
    slug: 'laminado-cejas',
    name: 'Laminado de Cejas',
    description:
      'Peinado y fijación de tus cejas naturales para un efecto pleno y ordenado por semanas.',
    emoji: '🪄',
  },
  {
    slug: 'revitalizacion-cejas',
    name: 'Tratamiento de Revitalización',
    description:
      'Nutrición y revitalización que fortalece y da brillo a tus cejas naturales.',
    emoji: '🌟',
  },
  {
    slug: 'micropigmentacion-labios',
    name: 'Micropigmentación de Labios',
    description:
      'Color y volumen duradero con acabado natural, en armonía con tus rasgos.',
    emoji: '💋',
  },
  {
    slug: 'hidralips',
    name: 'Hidralips',
    description:
      'Hidratación profunda de labios que recupera su suavidad, volumen y color natural.',
    emoji: '💧',
  },
  {
    slug: 'lifting-pestanas',
    name: 'Lifting de Pestañas',
    description:
      'Curvatura y longitud de tus pestañas naturales para una mirada abierta e impactante.',
    emoji: '🪶',
  },
  {
    slug: 'limpieza-facial',
    name: 'Limpieza Facial',
    description:
      'Limpieza profunda que renueva e ilumina tu piel, personalizada según su tipo.',
    emoji: '🧖‍♀️',
  },
];

// La FAQ visible y el schema FAQPage salen de la misma fuente: Google
// exige que el contenido del JSON-LD esté en la página.
const FAQS = [
  {
    q: '¿Dónde queda el estudio de Luzdy Jiménez?',
    a: 'En la Cl 1 # 12-18, Pereira, Risaralda (Colombia). En la sección de Ubicación encontrarás el mapa y el botón "Cómo llegar".',
  },
  {
    q: '¿Cuál es el horario de atención?',
    a: `${HOURS} ${HOURS_CLOSED}.`,
  },
  {
    q: '¿Cómo agendo mi cita?',
    a: 'Escríbenos por WhatsApp al +57 311 621 9282 o escríbenos por Instagram (@luzdy_jimenez) para coordinar tu espacio.',
  },
  {
    q: '¿Qué servicios ofrecen?',
    a: 'Depilación de cejas con hilo, micropigmentación de cejas y labios, laminado y revitalización de cejas, hidralips, lifting de pestañas, manicure y pedicure, y limpieza facial.',
  },
];

const businessJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BeautySalon',
  name: 'Luzdy Jiménez',
  description:
    'Especialista en cejas y belleza: depilación con hilo, micropigmentación, manicure, lifting de pestañas y limpieza facial.',
  url: `${SITE_URL}/`,
  image: [
    `${SITE_URL}/luzdy-logo.png`,
    `${SITE_URL}/local/fachada-noche.jpg`,
    `${SITE_URL}/local/fachada-vinilos.jpg`,
    `${SITE_URL}/luzdy/luzdy-especialista.jpg`,
  ],
  telephone: PHONE_TEL,
  priceRange: '$$',
  sameAs: ['https://instagram.com/luzdy_jimenez'],
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Cl 1 # 12-18',
    addressLocality: 'Pereira',
    addressRegion: 'Risaralda',
    addressCountry: 'CO',
  },
  // schema.org no tiene propiedad para "cerrado festivos": basta con
  // declarar solo los días abiertos (el cierre se comunica en texto
  // visible en Ubicación y FAQ).
  openingHoursSpecification: [
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: [
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ],
      opens: '09:00',
      closes: '18:00',
    },
  ],
  hasOfferCatalog: {
    '@type': 'OfferCatalog',
    name: 'Servicios de belleza',
    itemListElement: SERVICES.map((service) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: service.name },
    })),
  },
};

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((faq) => ({
    '@type': 'Question',
    name: faq.q,
    acceptedAnswer: { '@type': 'Answer', text: faq.a },
  })),
};

function hasSampleImage(slug: string): boolean {
  try {
    return fs.existsSync(
      path.join(process.cwd(), 'public', 'services', `${slug}.jpg`)
    );
  } catch {
    return false;
  }
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      {/* ===== Header ===== */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-black/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center">
            <Image
              src="/luzdy-logo.png"
              alt="Luzdy Jiménez — Especialista en Cejas y Belleza"
              width={2349}
              height={1081}
              loading="eager"
              className="h-10 w-auto"
            />
          </Link>
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-full border border-white/25 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-[#FC0178] hover:text-[#FC0178]"
          >
            <LogIn className="size-4" />
            Iniciar sesión
          </Link>
        </div>
      </header>

      {/* ===== Hero ===== */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            background: `radial-gradient(60% 80% at 50% 0%, ${BRAND} 0%, transparent 70%)`,
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-20 text-center sm:py-28">
          <Image
            src="/luzdy-logo.png"
            alt="Luzdy Jiménez — Especialista en Cejas y Belleza"
            width={2349}
            height={1081}
            preload
            className="mx-auto mb-8 h-28 w-auto sm:h-36"
          />
          <p
            className="text-xs font-semibold tracking-[0.35em] uppercase"
            style={{ color: BRAND }}
          >
            Especialista en Cejas y Belleza
          </p>
          <h1 className="mt-4 text-4xl leading-tight font-bold sm:text-6xl">
            Resalta tu belleza natural
            <span className="block" style={{ color: BRAND }}>
              con Luzdy Jiménez
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-white/70 sm:text-lg">
            Cejas perfectas, uñas impecables y una piel radiante en Pereira.
            Técnicas profesionales y atención personalizada para que te sientas
            increíble cada día.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://wa.me/573116219282"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full px-8 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
              style={{ backgroundColor: BRAND }}
            >
              Escríbenos por WhatsApp
            </a>
            <a
              href="#contacto"
              className="rounded-full border border-white/25 px-8 py-3 text-sm font-semibold text-white transition-colors hover:border-white/60"
            >
              Síguenos en Instagram
            </a>
          </div>
        </div>
      </section>

      {/* ===== Servicios ===== */}
      <section id="servicios" className="mx-auto max-w-6xl px-4 py-16">
        <p
          className="text-center text-xs font-semibold tracking-[0.35em] uppercase"
          style={{ color: BRAND }}
        >
          Servicios
        </p>
        <h2 className="mt-3 text-center text-3xl font-bold sm:text-4xl">
          Nuestros servicios de belleza y estética
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-white/60 sm:text-base">
          Cada servicio se realiza con productos profesionales y técnicas
          actualizadas, cuidando cada detalle.
        </p>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SERVICES.map((service) => {
            const hasImage = hasSampleImage(service.slug);
            return (
              <article
                key={service.slug}
                className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:-translate-y-1 hover:border-[#FC0178]/60"
              >
                {/* Sample image — replaced by real photos dropped into
                    public/services/<slug>.jpg */}
                {hasImage ? (
                  <div className="relative aspect-[4/3] w-full">
                    <Image
                      src={`/services/${service.slug}.jpg`}
                      alt={`${service.name} en Pereira — Luzdy Jiménez`}
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  </div>
                ) : (
                  <div
                    className="flex aspect-[4/3] w-full items-center justify-center transition-transform duration-500 group-hover:scale-105"
                    style={{
                      background: `linear-gradient(135deg, #1a1a1a 0%, ${BRAND}33 100%)`,
                    }}
                  >
                    <span className="text-5xl" aria-hidden>
                      {service.emoji}
                    </span>
                  </div>
                )}
                <div className="p-5">
                  <h3
                    className="text-base font-semibold"
                    style={{ color: BRAND }}
                  >
                    {service.name}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/65">
                    {service.description}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ===== Galería / Conoce el estudio ===== */}
      <section id="galeria" className="mx-auto max-w-6xl px-4 py-16">
        <p
          className="text-center text-xs font-semibold tracking-[0.35em] uppercase"
          style={{ color: BRAND }}
        >
          Galería
        </p>
        <h2 className="mt-3 text-center text-3xl font-bold sm:text-4xl">
          Conoce el estudio
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-white/60 sm:text-base">
          Un espacio cómodo en Pereira y la especialista que te acompañará en
          cada cita. Toca cualquier foto para verla en grande.
        </p>

        {/* Tu especialista */}
        <div className="mx-auto mt-12 grid max-w-3xl items-center gap-8 sm:grid-cols-[200px_1fr]">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[200px] overflow-hidden rounded-3xl border border-white/10">
            <Image
              src={SPECIALIST.src}
              alt={SPECIALIST.alt}
              fill
              sizes="200px"
              className="object-cover"
            />
          </div>
          <div className="text-center sm:text-left">
            <h3 className="text-xl font-bold" style={{ color: BRAND }}>
              {SPECIALIST.name}
            </h3>
            <p className="mt-1 text-sm font-medium text-white/80">
              {SPECIALIST.role}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-white/65">
              {SPECIALIST.bio}
            </p>
          </div>
        </div>

        {/* Collage de fotos con visor a pantalla completa */}
        <PhotoGallery images={GALLERY} />
      </section>

      {/* ===== Contacto / CTA ===== */}
      <section id="contacto" className="mx-auto max-w-6xl px-4 pb-20">
        <div
          className="rounded-3xl px-8 py-14 text-center"
          style={{
            background: `linear-gradient(135deg, ${BRAND} 0%, #7a0148 100%)`,
          }}
        >
          <h2 className="text-3xl font-bold">¿Lista para tu próxima cita?</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">
            Escríbenos por WhatsApp o síguenos en Instagram para agendar tu
            espacio. Tu momento de belleza empieza aquí.
          </p>

          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            {/* WhatsApp */}
            <a
              href="https://wa.me/573116219282"
              target="_blank"
              rel="noopener noreferrer"
              className="group mx-auto flex w-full max-w-xs flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-xl transition-transform hover:scale-[1.03]"
            >
              <Image
                src="/qr-whatsapp.jpg"
                alt="QR de WhatsApp de Luzdy Jiménez"
                width={400}
                height={400}
                sizes="176px"
                className="w-44 rounded-lg"
              />
              <span className="flex items-center gap-2 text-sm font-semibold text-black">
                <span
                  className="flex size-6 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: BRAND }}
                >
                  W
                </span>
                {PHONE_DISPLAY}
              </span>
              <span className="text-xs text-neutral-500 group-hover:text-neutral-800">
                Escríbenos
              </span>
            </a>

            {/* Instagram */}
            <a
              href="https://instagram.com/luzdy_jimenez"
              target="_blank"
              rel="noopener noreferrer"
              className="group mx-auto flex w-full max-w-xs flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-xl transition-transform hover:scale-[1.03]"
            >
              <Image
                src="/qr-instagram.jpg"
                alt="QR de Instagram de Luzdy Jiménez"
                width={650}
                height={650}
                sizes="176px"
                className="w-44 rounded-lg"
              />
              <span className="flex items-center gap-2 text-sm font-semibold text-black">
                <span
                  className="flex size-6 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: BRAND }}
                >
                  IG
                </span>
                @luzdy_jimenez
              </span>
              <span className="text-xs text-neutral-500 group-hover:text-neutral-800">
                Síguenos
              </span>
            </a>
          </div>
        </div>
      </section>

      {/* ===== Ubicación ===== */}
      <section id="ubicacion" className="mx-auto max-w-6xl px-4 py-16">
        <p
          className="text-center text-xs font-semibold tracking-[0.35em] uppercase"
          style={{ color: BRAND }}
        >
          Ubicación
        </p>
        <h2 className="mt-3 text-center text-3xl font-bold sm:text-4xl">
          Visítanos en Pereira
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-white/60 sm:text-base">
          {ADDRESS}. Un espacio cómodo y pensado para tu momento de belleza.
        </p>

        <div className="mt-10 overflow-hidden rounded-2xl border border-white/10">
          <iframe
            title="Mapa de ubicación de Luzdy Jiménez — Cl 1 # 12-18, Pereira, Risaralda"
            src={MAPS_EMBED_URL}
            className="h-80 w-full border-0 sm:h-96"
            loading="lazy"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>

        <div className="mt-6 flex flex-col items-center justify-center gap-4 text-sm text-white/70 sm:flex-row sm:gap-10">
          <span className="flex items-center gap-2">
            <Clock className="size-4 shrink-0" style={{ color: BRAND }} />
            {HOURS} · {HOURS_CLOSED}
          </span>
          <a
            href={`tel:${PHONE_TEL}`}
            className="flex items-center gap-2 transition-colors hover:text-white"
          >
            <Phone className="size-4 shrink-0" style={{ color: BRAND }} />
            {PHONE_DISPLAY}
          </a>
        </div>

        <div className="mt-8 text-center">
          <a
            href={MAPS_DIRECTIONS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full px-8 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
            style={{ backgroundColor: BRAND }}
          >
            <MapPin className="size-4" />
            Cómo llegar
          </a>
        </div>
      </section>

      {/* ===== Preguntas frecuentes ===== */}
      <section id="faq" className="mx-auto max-w-3xl px-4 pb-20">
        <p
          className="text-center text-xs font-semibold tracking-[0.35em] uppercase"
          style={{ color: BRAND }}
        >
          Preguntas frecuentes
        </p>
        <h2 className="mt-3 text-center text-3xl font-bold sm:text-4xl">
          Todo lo que necesitas saber
        </h2>

        <div className="mt-10 space-y-4">
          {FAQS.map((faq) => (
            <details
              key={faq.q}
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-4"
            >
              <summary className="cursor-pointer list-none text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
                {faq.q}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-white/65">
                {faq.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 text-center">
          <Image
            src="/luzdy-logo.png"
            alt="Luzdy Jiménez"
            width={2349}
            height={1081}
            className="h-12 w-auto opacity-80"
          />
          <p className="text-xs text-white/60">
            {ADDRESS} · {HOURS} ·{' '}
            <a href={`tel:${PHONE_TEL}`} className="hover:text-white">
              {PHONE_DISPLAY}
            </a>
          </p>
          <p className="text-xs text-white/40">
            Especialista en Cejas y Belleza · Todos los derechos reservados
          </p>
        </div>
      </footer>

      {/* ===== Datos estructurados (SEO local) ===== */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(businessJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </div>
  );
}

export const metadata = {
  title: {
    absolute: 'Luzdy Jiménez | Especialista en Cejas y Belleza',
  },
  description: PAGE_DESCRIPTION,
  // Sobrescribe el noindex global del layout raíz — esta es la única
  // página pública del CRM. La fusión de metadata es por campos, así
  // que este objeto robots reemplaza completo al del layout.
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Luzdy Jiménez | Especialista en Cejas y Belleza',
    description: PAGE_DESCRIPTION,
    url: '/',
    siteName: 'Luzdy Jiménez',
    locale: 'es_CO',
    type: 'website',
    images: [
      {
        url: '/og-luzdy.jpg',
        width: 1200,
        height: 630,
        alt: 'Luzdy Jiménez — Especialista en Cejas y Belleza',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Luzdy Jiménez | Especialista en Cejas y Belleza',
    description: PAGE_DESCRIPTION,
    images: ['/og-luzdy.jpg'],
  },
};
