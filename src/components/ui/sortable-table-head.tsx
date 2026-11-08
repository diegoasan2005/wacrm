'use client';

// Encabezado de tabla ordenable: muestra la etiqueta con un icono de
// dirección (neutro ↑ ↓ según estado) y delega el ciclo de orden al
// consumidor vía onToggle. Compartido por Agenda Historial y
// Contactos.
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortDir = 'asc' | 'desc';

export function SortableTableHead({
  label,
  dir,
  onToggle,
  className,
}: {
  label: string;
  /** Dirección activa; null = columna sin ordenar. */
  dir: SortDir | null;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = !dir ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn('text-muted-foreground', className)}
      aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={onToggle}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        {label}
        <Icon
          className={cn('size-3', dir ? 'text-foreground' : 'opacity-50')}
          aria-hidden
        />
      </button>
    </TableHead>
  );
}
