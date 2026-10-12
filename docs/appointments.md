# Servicios y Agendamiento de Citas (migraciones 047–051)

Módulos **Servicios** (`/services`) y **Agenda** (`/agenda`) integrados con
contactos, miembros, roles, RLS y navegación existentes de WACRM.

## Aplicar la migración

```bash
supabase db push          # o: psql -f <archivo> por cada migración 047→051, en orden
```

Ninguna es destructiva: `ADD COLUMN`, tablas nuevas, políticas propias y la
reconstrucción del enum de estados (050/051, sin FINALIZADA). Seguras para
reejecutar (idempotentes).

## Modelo de datos

| Tabla | Propósito |
|---|---|
| `appointment_services` | Servicios por cuenta (duración, precio, color, `is_default` único por cuenta vía índice parcial único, `is_active`, `available_for_booking`, `max_concurrent` — atenciones simultáneas por franja) |
| `appointments` | Citas: contacto + servicio (+ snapshot `service_name`) + especialista + rango UTC + estado enum (`PENDIENTE`, `CONFIRMADA`, `LLEGA TARDE`, `NO LLEGA`, `CANCELADA` — la 050/051 eliminó FINALIZADA) |
| `appointment_member_schedules` | Ventanas laborales semanales por miembro (sin filas = siempre agendable, comportamiento inicial documentado) |
| `appointment_schedule_exceptions` | Excepciones por fecha (`unavailable` / `available`) |
| `appointment_history` | Auditoría escrita por trigger (`SECURITY DEFINER`); clientes solo `SELECT` |

Columnas nuevas: `profiles.can_book_appointments` (permiso «Puede registrar
citas» por membresía) y `profiles.show_in_agenda` («En agenda» — decide qué
miembros se listan como especialistas, cualquier rol), `accounts.timezone`
(default `America/Bogota`), `contacts.identification / last_name /
birth_month / birth_day`.

## Concurrencia

El índice `idx_appointments_no_overlap` (GiST `EXCLUDE` sobre
`(assigned_user_id, tstzrange(starts_at, ends_at, '[)'))` restringido a los
estados que bloquean: PENDIENTE / CONFIRMADA / LLEGA TARDE) impide
transaccionalmente dos citas superpuestas para el mismo especialista, aunque
dos peticiones lleguen a la vez. Los límites `[)` permiten citas consecutivas.
`CANCELADA` y `NO LLEGA` no bloquean; `FINALIZADA` no bloquea huecos futuros
pero se conserva como historial.

## Seguridad (defensa en profundidad)

1. **API routes** — `requireRole` + RPCs (`create_appointment`,
   `update_appointment`, `set_member_booking_permission`,
   `set_default_service`) con verificación de rol/membresía server-side;
   `created_by` y `account_id` jamás se toman del cliente.
2. **RLS** — lectura: todos menos agentes (que solo ven lo suyo); escritura:
   admin+ o agente con flag y solo sobre su propia agenda
   (`appointment_write_allowed` / `appointment_read_allowed`).
3. **Trigger de transiciones** (`appointment_guard_transition`) — mapa
   operativo para agentes; admin+ puede corregir cualquier estado (queda en
   auditoría); estados terminales protegidos contra agentes.
4. **Trigger de auditoría** — registra created/updated/deleted con valores
   previos/nuevos y autor.

Tiempo: las paredes de reloj se interpretan en `accounts.timezone`; la DB
guarda instantes UTC (`timestamptz`). Conversión con `@date-fns/tz`.

## Permisos (matriz central: `src/lib/appointments/permissions.ts`)

| Rol | Agenda | Citas | Servicios |
|---|---|---|---|
| Propietario | todas | crear/editar/reasignar cualquier miembro | CRUD |
| Administrador | todas | crear/editar/reasignar cualquier miembro | CRUD + permisos |
| Agente (sin flag) | solo la suya (lectura) | ninguna | solo lectura |
| Agente (con flag) | solo la suya | crear/editar/cambiar estado **propias** | solo lectura |
| Observador | todas (lectura) | ninguna | solo lectura |

El checkbox «Puede registrar citas» vive en **Configuración → Miembros** y
solo aplica a agentes (el backend lo valida vía
`set_member_booking_permission`).

## Pruebas ejecutadas

- `npm run typecheck` — sin errores.
- `npm test` — 1171/1171 (incluye las nuevas: matriz de permisos,
  transiciones, conversiones de zona horaria, validación de servicios).
- `npm run lint` — 0 errores.
- `npm run build` — compila con `/agenda`, `/services` y sus APIs.

Las pruebas de integración contra Supabase real (RLS con múltiples usuarios,
`EXCLUDE` bajo concurrencia) requieren un proyecto Supabase con la migración
aplicada; ver «Verificación manual por rol» abajo.

## Verificación manual por rol (requiere `supabase db push` + `npm run dev`)

1. **Propietario/Admin**: crear/editar/inactivar servicios; marcar
   predeterminado; agendar para cualquier miembro; editar permisos en
   Miembros; reasignar citas.
2. **Agente con flag**: ver solo su columna; crear/editar sus citas; el
   selector de especialista aparece fijo a su usuario.
3. **Agente sin flag**: ve su agenda pero «Nueva cita» no aparece y la API
   responde 403.
4. **Observador**: ve toda la agenda en modo lectura; un POST directo a
   `/api/appointments` devuelve 403.
5. **Conflictos**: dos citas superpuestas para el mismo especialista → error
   «Ese horario ya está ocupado…» (también por API directa).
