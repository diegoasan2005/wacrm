import { Suspense } from "react";
import { Loader2 } from "lucide-react";

import { AgendaView } from "@/components/agenda/agenda-view";

export default function AgendaPage() {
  // Suspense boundary required: AgendaView reads search params
  // (deep links like /agenda?contact=…), which forces dynamic
  // rendering of that subtree.
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      }
    >
      <AgendaView />
    </Suspense>
  );
}
