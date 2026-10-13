import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { LogIn } from "lucide-react";

import { createClient } from "@/lib/supabase/server";

// ============================================================
// Landing pública — lo primero que ve cualquier visitante.
//
// No requiere sesión: presenta los servicios de Luzdy Jiménez y el
// botón de inicio de sesión lleva a /login (los usuarios ya
// autenticados que entren a /login son llevados a /dashboard por el
// middleware, así que el mismo botón sirve para ambos).
//
// Sample images: drop real photos into `public/services/<slug>.jpg`
// and they replace the gradient placeholders automatically (checked
// at build time).
// ============================================================

const BRAND = "#FC0178";

const SERVICES = [
  {
    slug: "depilacion-cejas",
    name: "Depilación de Cejas con Hilo",
    description:
      "Definición y limpieza perfecta con la técnica del hilo: precisión, menos irritación y una forma que realza tu mirada.",
    emoji: "👁️",
  },
  {
    slug: "manicure-pedicure",
    name: "Manicure y Pedicure",
    description:
      "Todas las técnicas y con diseños personalizados para unas manos y pies impecables.",
    emoji: "💅",
  },
  {
    slug: "micropigmentacion-cejas",
    name: "Micropigmentación de Cejas",
    description:
      "Cejas perfectas 24/7 con acabado natural pelo a pelo, diseñadas según tu rostro.",
    emoji: "✨",
  },
  {
    slug: "laminado-cejas",
    name: "Laminado de Cejas",
    description:
      "Peinado y fijación de tus cejas naturales para un efecto pleno y ordenado por semanas.",
    emoji: "🪄",
  },
  {
    slug: "revitalizacion-cejas",
    name: "Tratamiento de Revitalización",
    description:
      "Nutrición y revitalización que fortalece y da brillo a tus cejas naturales.",
    emoji: "🌟",
  },
  {
    slug: "micropigmentacion-labios",
    name: "Micropigmentación de Labios",
    description:
      "Color y volumen duradero con acabado natural, en armonía con tus rasgos.",
    emoji: "💋",
  },
  {
    slug: "hidralips",
    name: "Hidralips",
    description:
      "Hidratación profunda de labios que recupera su suavidad, volumen y color natural.",
    emoji: "💧",
  },
  {
    slug: "lifting-pestanas",
    name: "Lifting de Pestañas",
    description:
      "Curvatura y longitud de tus pestañas naturales para una mirada abierta e impactante.",
    emoji: "🪶",
  },
  {
    slug: "limpieza-facial",
    name: "Limpieza Facial",
    description:
      "Limpieza profunda que renueva e ilumina tu piel, personalizada según su tipo.",
    emoji: "🧖‍♀️",
  },
];

function hasSampleImage(slug: string): boolean {
  try {
    return fs.existsSync(
      path.join(process.cwd(), "public", "services", `${slug}.jpg`),
    );
  } catch {
    return false;
  }
}

export default async function LandingPage() {
  // Session check only to personalize the header button — the page
  // itself is public and never requires a session.
  let isLoggedIn = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isLoggedIn = !!user;
  } catch {
    isLoggedIn = false;
  }

  return (
    <div className="min-h-screen bg-black text-white">
      {/* ===== Header ===== */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-black/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/luzdy-logo.png"
              alt="Luzdy Jiménez — Especialista en Cejas y Belleza"
              className="h-10 w-auto"
            />
          </Link>
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-full border border-white/25 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-[#FC0178] hover:text-[#FC0178]"
          >
            <LogIn className="size-4" />
            {isLoggedIn ? "Ingresar" : "Iniciar sesión"}
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/luzdy-logo.png"
            alt="Luzdy Jiménez — Especialista en Cejas y Belleza"
            className="mx-auto mb-8 h-28 w-auto sm:h-36"
          />
          <p
            className="text-xs font-semibold uppercase tracking-[0.35em]"
            style={{ color: BRAND }}
          >
            Especialista en Cejas y Belleza
          </p>
          <h1 className="mt-4 text-4xl font-bold leading-tight sm:text-6xl">
            Realza tu belleza
            <span className="block" style={{ color: BRAND }}>
              natural
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-white/70 sm:text-lg">
            Cejas perfectas, uñas impecables y una piel radiante. Técnicas
            profesionales y atención personalizada para que te sientas increíble
            cada día.
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
          className="text-center text-xs font-semibold uppercase tracking-[0.35em]"
          style={{ color: BRAND }}
        >
          Nuestros servicios
        </p>
        <h2 className="mt-3 text-center text-3xl font-bold sm:text-4xl">
          Belleza de pies a cabeza
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
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/services/${service.slug}.jpg`}
                    alt={service.name}
                    className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
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
                  <h3 className="text-base font-semibold" style={{ color: BRAND }}>
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/qr-whatsapp.jpg"
                alt="QR de WhatsApp de Luzdy Jimenez"
                className="w-44 rounded-lg"
              />
              <span className="flex items-center gap-2 text-sm font-semibold text-black">
                <span
                  className="flex size-6 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: BRAND }}
                >
                  W
                </span>
                311 621 9282
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/qr-instagram.jpg"
                alt="QR de Instagram de Luzdy Jimenez"
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

      {/* ===== Footer ===== */}
      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/luzdy-logo.png"
            alt="Luzdy Jiménez"
            className="h-12 w-auto opacity-80"
          />
          <p className="text-xs text-white/40">
            Especialista en Cejas y Belleza · Todos los derechos reservados
          </p>
        </div>
      </footer>
    </div>
  );
}

export const metadata = {
  title: {
    absolute: "Luzdy Jiménez | Especialista en Cejas y Belleza",
  },
  description:
    "Depilación de cejas con hilo, manicure y pedicure, micropigmentación, lifting de pestañas y limpieza facial. Agenda tu cita.",
};
